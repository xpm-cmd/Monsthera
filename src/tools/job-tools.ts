import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { MonstheraContext } from "../core/context.js";
import { AgentIdSchema, SessionIdSchema } from "../core/input-hardening.js";
import { resolveAgent } from "./resolve-agent.js";
import { checkToolAccess } from "../trust/tiers.js";
import { recordDashboardEvent } from "../core/events.js";
import * as queries from "../db/queries.js";
import { LOOP_TEMPLATES, JOB_SLOT_TRANSITIONS, type JobSlotStatus } from "../../schemas/job.js";
import { randomUUID } from "node:crypto";

type GetContext = () => Promise<MonstheraContext>;

function slotId(): string {
  return `JOB-${randomUUID().slice(0, 8)}`;
}

export function registerJobTools(server: McpServer, getContext: GetContext): void {
  // ─── create_loop ──────────────────────────────────────────────
  server.tool(
    "create_loop",
    "Create a job loop with predefined or custom slots for agents to claim",
    {
      loopId: z.string().min(1).max(100).describe("Unique loop identifier"),
      template: z.enum(["full-team", "full-team-unified-council", "small-team", "custom"]).default("full-team").describe("Loop template"),
      slots: z.array(z.object({
        role: z.string().min(1).max(50),
        specialization: z.string().max(50).optional(),
        label: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        systemPrompt: z.string().max(5000).optional(),
        contextJson: z.string().max(5000).optional(),
        ticketId: z.string().max(50).optional(),
      })).optional().describe("Custom slots (required when template='custom')"),
      agentId: AgentIdSchema.describe("Your agent ID"),
      sessionId: SessionIdSchema.describe("Your session ID"),
    },
    async ({ loopId, template, slots: customSlots, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return { content: [{ type: "text" as const, text: result.error }], isError: true };
      const resolved = result.agent;

      const access = checkToolAccess("create_loop", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ denied: true, reason: access.reason }) }], isError: true };
      }

      // Check loop doesn't already exist
      const existing = queries.getJobSlotsByLoop(c.db, c.repoId, loopId);
      if (existing.length > 0) {
        return { content: [{ type: "text" as const, text: `Loop "${loopId}" already exists with ${existing.length} slots` }], isError: true };
      }

      // Resolve template slots
      let templateSlots: Array<{
        role: string; specialization?: string; label: string;
        description?: string; systemPrompt?: string; contextJson?: string; ticketId?: string;
      }>;
      if (template === "custom") {
        if (!customSlots || customSlots.length === 0) {
          return { content: [{ type: "text" as const, text: "Custom template requires at least one slot" }], isError: true };
        }
        templateSlots = customSlots;
      } else {
        const tmpl = LOOP_TEMPLATES[template];
        if (!tmpl) {
          return { content: [{ type: "text" as const, text: `Unknown template: ${template}` }], isError: true };
        }
        templateSlots = tmpl.map((s) => ({
          role: s.role,
          specialization: s.specialization,
          label: s.label,
          systemPrompt: s.systemPrompt,
          description: s.description,
          contextJson: s.contextJson ? JSON.stringify(s.contextJson) : undefined,
        }));
      }

      const now = new Date().toISOString();
      const created: string[] = [];

      for (const slot of templateSlots) {
        const id = slotId();
        queries.insertJobSlot(c.db, {
          repoId: c.repoId,
          slotId: id,
          loopId,
          role: slot.role,
          specialization: slot.specialization ?? null,
          label: slot.label,
          description: slot.description ?? null,
          systemPrompt: slot.systemPrompt ?? null,
          contextJson: slot.contextJson ?? null,
          ticketId: slot.ticketId ?? null,
          status: "open",
          agentId: null,
          sessionId: null,
          claimedAt: null,
          activeSince: null,
          completedAt: null,
          lastHeartbeat: null,
          progressNote: null,
          createdAt: now,
          updatedAt: now,
        });
        created.push(id);
      }

      recordDashboardEvent(c.db, c.repoId, {
        type: "job_loop_created",
        data: { loopId, template, slotCount: created.length, createdBy: resolved.agentId },
      });

      c.insight.info(`Loop "${loopId}" created with ${created.length} slots (template: ${template})`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            loopId,
            template,
            slotsCreated: created.length,
            slotIds: created,
          }),
        }],
      };
    },
  );

  // ─── list_jobs ────────────────────────────────────────────────
  server.tool(
    "list_jobs",
    "List job slots in a loop (systemPrompt hidden until claimed)",
    {
      loopId: z.string().min(1).max(100).optional().describe("Filter by loop ID"),
      status: z.enum(["open", "claimed", "active", "completed", "abandoned"]).optional().describe("Filter by status"),
      role: z.string().max(50).optional().describe("Filter by role"),
      agentId: AgentIdSchema.describe("Your agent ID"),
      sessionId: SessionIdSchema.describe("Your session ID"),
    },
    async ({ loopId, status, role, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return { content: [{ type: "text" as const, text: result.error }], isError: true };

      let slots = loopId
        ? queries.getJobSlotsByLoop(c.db, c.repoId, loopId, status)
        : queries.getAllJobSlots(c.db, c.repoId);

      if (!loopId && status) {
        slots = slots.filter((s) => s.status === status);
      }
      if (role) {
        slots = slots.filter((s) => s.role === role);
      }

      // Summarize loops
      const loops = queries.getDistinctLoops(c.db, c.repoId);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            loops,
            slots: slots.map((s) => ({
              slotId: s.slotId,
              loopId: s.loopId,
              role: s.role,
              specialization: s.specialization,
              label: s.label,
              description: s.description,
              ticketId: s.ticketId,
              status: s.status,
              agentId: s.agentId,
              lastHeartbeat: s.lastHeartbeat,
              progressNote: s.progressNote,
              // systemPrompt intentionally omitted
            })),
          }),
        }],
      };
    },
  );

  // ─── claim_job ────────────────────────────────────────────────
  server.tool(
    "claim_job",
    "Claim an available job slot and receive role-specific instructions",
    {
      slotId: z.string().max(50).optional().describe("Specific slot to claim"),
      loopId: z.string().max(100).optional().describe("Loop to find an open slot in (auto-match by role)"),
      agentId: AgentIdSchema.describe("Your agent ID"),
      sessionId: SessionIdSchema.describe("Your session ID"),
    },
    async ({ slotId: requestedSlotId, loopId, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return { content: [{ type: "text" as const, text: result.error }], isError: true };
      const resolved = result.agent;

      const access = checkToolAccess("claim_job", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ denied: true, reason: access.reason }) }], isError: true };
      }

      // Check agent doesn't already have an active slot
      const existingSlots = queries.getJobSlotsByAgent(c.db, resolved.agentId);
      const activeSlot = existingSlots.find((s) => s.status === "claimed" || s.status === "active");
      if (activeSlot) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              denied: true,
              reason: `You already have an active job: ${activeSlot.slotId} (${activeSlot.label}). Complete or release it first.`,
              activeSlot: { slotId: activeSlot.slotId, label: activeSlot.label, status: activeSlot.status },
            }),
          }],
          isError: true,
        };
      }

      let slot;
      if (requestedSlotId) {
        slot = queries.getJobSlotBySlotId(c.db, c.repoId, requestedSlotId);
        if (!slot) return { content: [{ type: "text" as const, text: `Slot not found: ${requestedSlotId}` }], isError: true };
        if (slot.status !== "open") {
          return { content: [{ type: "text" as const, text: `Slot ${requestedSlotId} is ${slot.status}, not open` }], isError: true };
        }
      } else if (loopId) {
        // Auto-match by agent's role
        const openSlots = queries.getOpenSlotsByRole(c.db, c.repoId, loopId, resolved.role);
        if (openSlots.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                denied: true,
                reason: `No open ${resolved.role} slots in loop "${loopId}"`,
                suggestion: "Try list_jobs to see available slots",
              }),
            }],
            isError: true,
          };
        }
        slot = openSlots[0]!;
      } else {
        return { content: [{ type: "text" as const, text: "Provide either slotId or loopId" }], isError: true };
      }

      const now = new Date().toISOString();
      queries.updateJobSlot(c.db, slot.slotId, {
        status: "claimed",
        agentId: resolved.agentId,
        sessionId: resolved.sessionId,
        claimedAt: now,
        lastHeartbeat: now,
      });

      recordDashboardEvent(c.db, c.repoId, {
        type: "job_slot_claimed",
        data: {
          slotId: slot.slotId, loopId: slot.loopId, role: slot.role,
          label: slot.label, agentId: resolved.agentId,
          specialization: slot.specialization, ticketId: slot.ticketId,
        },
      });

      c.insight.info(`Job claimed: ${slot.label} (${slot.slotId}) by ${resolved.agentId}`);

      // Parse context
      let context: Record<string, unknown> | null = null;
      if (slot.contextJson) {
        try { context = JSON.parse(slot.contextJson); } catch { /* ignore */ }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            claimed: true,
            slotId: slot.slotId,
            loopId: slot.loopId,
            role: slot.role,
            specialization: slot.specialization,
            label: slot.label,
            ticketId: slot.ticketId,
            systemPrompt: slot.systemPrompt,
            context,
          }),
        }],
      };
    },
  );

  // ─── update_job_progress ──────────────────────────────────────
  server.tool(
    "update_job_progress",
    "Update job progress and heartbeat (call every 3-5 minutes)",
    {
      slotId: z.string().min(1).max(50).describe("Your job slot ID"),
      progressNote: z.string().max(500).optional().describe("Brief status note"),
      status: z.enum(["active", "completed"]).optional().describe("Transition to active or completed"),
      ticketId: z.string().max(50).optional().describe("Associate a ticket with this slot"),
      agentId: AgentIdSchema.describe("Your agent ID"),
      sessionId: SessionIdSchema.describe("Your session ID"),
    },
    async ({ slotId: targetSlotId, progressNote, status: newStatus, ticketId, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return { content: [{ type: "text" as const, text: result.error }], isError: true };
      const resolved = result.agent;

      const slot = queries.getJobSlotBySlotId(c.db, c.repoId, targetSlotId);
      if (!slot) return { content: [{ type: "text" as const, text: `Slot not found: ${targetSlotId}` }], isError: true };
      if (slot.agentId !== resolved.agentId) {
        return { content: [{ type: "text" as const, text: `Slot ${targetSlotId} is not assigned to you` }], isError: true };
      }

      const now = new Date().toISOString();
      const updates: Record<string, unknown> = { lastHeartbeat: now };

      if (progressNote !== undefined) updates.progressNote = progressNote;
      if (ticketId !== undefined) updates.ticketId = ticketId;

      if (newStatus) {
        const currentStatus = slot.status as JobSlotStatus;
        const allowed = JOB_SLOT_TRANSITIONS[currentStatus];
        if (!allowed.includes(newStatus)) {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot transition from ${currentStatus} to ${newStatus}. Allowed: ${allowed.join(", ")}`,
            }],
            isError: true,
          };
        }
        updates.status = newStatus;
        if (newStatus === "active" && currentStatus !== "active") updates.activeSince = now;
        if (newStatus === "completed") updates.completedAt = now;
      }

      queries.updateJobSlot(c.db, targetSlotId, updates as Partial<typeof import("../db/schema.js").jobSlots.$inferInsert>);

      const eventType = newStatus === "completed" ? "job_slot_completed"
        : (newStatus === "active" && slot.status !== "active") ? "job_slot_active"
        : "job_progress_update";

      recordDashboardEvent(c.db, c.repoId, {
        type: eventType,
        data: {
          slotId: targetSlotId, loopId: slot.loopId, agentId: resolved.agentId,
          status: newStatus ?? slot.status, progressNote,
          ticketId: ticketId ?? slot.ticketId,
        },
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            updated: true,
            slotId: targetSlotId,
            status: newStatus ?? slot.status,
            progressNote: progressNote ?? slot.progressNote,
            lastHeartbeat: now,
          }),
        }],
      };
    },
  );

  // ─── complete_job ─────────────────────────────────────────────
  server.tool(
    "complete_job",
    "Mark a job as completed",
    {
      slotId: z.string().min(1).max(50).describe("Job slot ID to complete"),
      agentId: AgentIdSchema.describe("Your agent ID"),
      sessionId: SessionIdSchema.describe("Your session ID"),
    },
    async ({ slotId: targetSlotId, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return { content: [{ type: "text" as const, text: result.error }], isError: true };
      const resolved = result.agent;

      const slot = queries.getJobSlotBySlotId(c.db, c.repoId, targetSlotId);
      if (!slot) return { content: [{ type: "text" as const, text: `Slot not found: ${targetSlotId}` }], isError: true };
      if (slot.agentId !== resolved.agentId) {
        return { content: [{ type: "text" as const, text: `Slot ${targetSlotId} is not assigned to you` }], isError: true };
      }

      const currentStatus = slot.status as JobSlotStatus;
      if (!JOB_SLOT_TRANSITIONS[currentStatus].includes("completed")) {
        return { content: [{ type: "text" as const, text: `Cannot complete a slot in ${currentStatus} state` }], isError: true };
      }

      const now = new Date().toISOString();
      queries.updateJobSlot(c.db, targetSlotId, { status: "completed", completedAt: now, lastHeartbeat: now });

      recordDashboardEvent(c.db, c.repoId, {
        type: "job_slot_completed",
        data: { slotId: targetSlotId, loopId: slot.loopId, agentId: resolved.agentId, label: slot.label },
      });

      c.insight.info(`Job completed: ${slot.label} (${targetSlotId}) by ${resolved.agentId}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ completed: true, slotId: targetSlotId, label: slot.label }),
        }],
      };
    },
  );

  // ─── release_job ──────────────────────────────────────────────
  server.tool(
    "release_job",
    "Release a job slot back to open (facilitator/admin can release others' jobs)",
    {
      slotId: z.string().min(1).max(50).describe("Job slot ID to release"),
      agentId: AgentIdSchema.describe("Your agent ID"),
      sessionId: SessionIdSchema.describe("Your session ID"),
    },
    async ({ slotId: targetSlotId, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return { content: [{ type: "text" as const, text: result.error }], isError: true };
      const resolved = result.agent;

      const access = checkToolAccess("release_job", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ denied: true, reason: access.reason }) }], isError: true };
      }

      const slot = queries.getJobSlotBySlotId(c.db, c.repoId, targetSlotId);
      if (!slot) return { content: [{ type: "text" as const, text: `Slot not found: ${targetSlotId}` }], isError: true };

      // Only owner or facilitator/admin can release
      const isOwner = slot.agentId === resolved.agentId;
      const isElevated = ["facilitator", "admin"].includes(resolved.role);
      if (!isOwner && !isElevated) {
        return {
          content: [{ type: "text" as const, text: "Only the slot owner or a facilitator/admin can release this job" }],
          isError: true,
        };
      }

      const currentStatus = slot.status as JobSlotStatus;
      if (!JOB_SLOT_TRANSITIONS[currentStatus].includes("open") && currentStatus !== "abandoned") {
        return { content: [{ type: "text" as const, text: `Cannot release a slot in ${currentStatus} state` }], isError: true };
      }

      const now = new Date().toISOString();
      queries.updateJobSlot(c.db, targetSlotId, {
        status: "open",
        agentId: null,
        sessionId: null,
        claimedAt: null,
        activeSince: null,
        lastHeartbeat: null,
        progressNote: null,
      });

      recordDashboardEvent(c.db, c.repoId, {
        type: "job_slot_released",
        data: {
          slotId: targetSlotId, loopId: slot.loopId,
          releasedBy: resolved.agentId, previousAgent: slot.agentId,
        },
      });

      c.insight.info(`Job released: ${slot.label} (${targetSlotId}) by ${resolved.agentId}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ released: true, slotId: targetSlotId, label: slot.label }),
        }],
      };
    },
  );
}
