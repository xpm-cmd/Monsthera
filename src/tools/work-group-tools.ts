import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
import type { MonstheraContext } from "../core/context.js";
import {
  AgentIdSchema,
  SessionIdSchema,
} from "../core/input-hardening.js";
import * as queries from "../db/queries.js";
import { resolveAgent } from "./resolve-agent.js";
import { checkToolAccess } from "../trust/tiers.js";
import { errJson, errText } from "./response-helpers.js";

type GetContext = () => Promise<MonstheraContext>;

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

export function registerWorkGroupTools(server: McpServer, getContext: GetContext): void {
  // ─── create_work_group ──────────────────────────────────────
  server.tool(
    "create_work_group",
    "Create a new work group to aggregate tracking for multi-ticket features",
    {
      title: z.string().min(1).max(MAX_TITLE_LENGTH).describe("Work group title"),
      description: z.string().max(MAX_DESCRIPTION_LENGTH).optional().describe("Work group description"),
      tags: z.array(z.string().min(1).max(64)).max(25).optional().describe("Tags for categorization"),
      ticketIds: z.array(z.string().min(1)).max(50).optional().describe("Initial ticket IDs (TKT-...) to add"),
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ title, description, tags, ticketIds, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved.ok) {
        return errText(resolved.error);
      }

      const access = checkToolAccess("create_work_group", resolved.agent.role, resolved.agent.trustTier);
      if (!access.allowed) {
        return errJson({ denied: true, reason: access.reason });
      }

      const now = new Date().toISOString();
      const groupId = `WG-${randomUUID().slice(0, 8)}`;

      const group = queries.insertWorkGroup(c.db, {
        repoId: c.repoId,
        groupId,
        title,
        description: description ?? null,
        status: "open",
        createdBy: agentId,
        tagsJson: tags ? JSON.stringify(tags) : null,
        createdAt: now,
        updatedAt: now,
      });

      // Add initial tickets if provided
      const addedTickets: string[] = [];
      const ticketErrors: string[] = [];

      if (ticketIds && ticketIds.length > 0) {
        for (const tktId of ticketIds) {
          const ticket = queries.getTicketByTicketId(c.db, tktId);
          if (!ticket) {
            ticketErrors.push(`Ticket ${tktId} not found`);
            continue;
          }
          try {
            queries.addTicketToWorkGroup(c.db, group.id, ticket.id, now);
            addedTickets.push(tktId);
          } catch (err) {
            ticketErrors.push(`Failed to add ${tktId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            groupId,
            title,
            status: "open",
            addedTickets,
            ticketErrors: ticketErrors.length > 0 ? ticketErrors : undefined,
          }, null, 2),
        }],
      };
    },
  );

  // ─── update_work_group ──────────────────────────────────────
  server.tool(
    "update_work_group",
    "Update a work group's title, description, status, or tags",
    {
      groupId: z.string().min(1).describe("Work group ID (WG-...)"),
      title: z.string().min(1).max(MAX_TITLE_LENGTH).optional().describe("New title"),
      description: z.string().max(MAX_DESCRIPTION_LENGTH).optional().describe("New description"),
      status: z.enum(["open", "completed", "cancelled"]).optional().describe("New status"),
      tags: z.array(z.string().min(1).max(64)).max(25).optional().describe("New tags"),
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ groupId, title, description, status, tags, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved.ok) {
        return errText(resolved.error);
      }

      const access = checkToolAccess("update_work_group", resolved.agent.role, resolved.agent.trustTier);
      if (!access.allowed) {
        return errJson({ denied: true, reason: access.reason });
      }

      const group = queries.getWorkGroupByGroupId(c.db, groupId);
      if (!group) {
        return errJson({ error: `Work group ${groupId} not found` });
      }

      const updates: Parameters<typeof queries.updateWorkGroup>[2] = {
        updatedAt: new Date().toISOString(),
      };
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (status !== undefined) updates.status = status;
      if (tags !== undefined) updates.tagsJson = JSON.stringify(tags);

      queries.updateWorkGroup(c.db, group.id, updates);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            groupId,
            updated: true,
            ...(title !== undefined ? { title } : {}),
            ...(status !== undefined ? { status } : {}),
          }, null, 2),
        }],
      };
    },
  );

  // ─── add_tickets_to_group ───────────────────────────────────
  server.tool(
    "add_tickets_to_group",
    "Add tickets to a work group",
    {
      groupId: z.string().min(1).describe("Work group ID (WG-...)"),
      ticketIds: z.array(z.string().min(1)).min(1).max(50).describe("Ticket IDs (TKT-...) to add"),
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ groupId, ticketIds, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved.ok) {
        return errText(resolved.error);
      }

      const access = checkToolAccess("add_tickets_to_group", resolved.agent.role, resolved.agent.trustTier);
      if (!access.allowed) {
        return errJson({ denied: true, reason: access.reason });
      }

      const group = queries.getWorkGroupByGroupId(c.db, groupId);
      if (!group) {
        return errJson({ error: `Work group ${groupId} not found` });
      }

      let warning: string | undefined;
      if (group.status === "completed") {
        warning = "Adding tickets to a completed work group. Consider re-opening it (status=open) first.";
      }
      if (group.status === "cancelled") {
        return errJson({ error: "Cannot add tickets to a cancelled work group" });
      }

      const now = new Date().toISOString();
      const added: string[] = [];
      const errors: string[] = [];

      for (const tktId of ticketIds) {
        const ticket = queries.getTicketByTicketId(c.db, tktId);
        if (!ticket) {
          errors.push(`Ticket ${tktId} not found`);
          continue;
        }
        try {
          queries.addTicketToWorkGroup(c.db, group.id, ticket.id, now);
          added.push(tktId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("UNIQUE")) {
            errors.push(`Ticket ${tktId} already in group`);
          } else {
            errors.push(`Failed to add ${tktId}: ${msg}`);
          }
        }
      }

      // Update group timestamp
      queries.updateWorkGroup(c.db, group.id, { updatedAt: now });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            groupId,
            added,
            errors: errors.length > 0 ? errors : undefined,
            warning,
          }, null, 2),
        }],
      };
    },
  );

  // ─── remove_tickets_from_group ──────────────────────────────
  server.tool(
    "remove_tickets_from_group",
    "Remove tickets from a work group",
    {
      groupId: z.string().min(1).describe("Work group ID (WG-...)"),
      ticketIds: z.array(z.string().min(1)).min(1).max(50).describe("Ticket IDs (TKT-...) to remove"),
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ groupId, ticketIds, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved.ok) {
        return errText(resolved.error);
      }

      const access = checkToolAccess("remove_tickets_from_group", resolved.agent.role, resolved.agent.trustTier);
      if (!access.allowed) {
        return errJson({ denied: true, reason: access.reason });
      }

      const group = queries.getWorkGroupByGroupId(c.db, groupId);
      if (!group) {
        return errJson({ error: `Work group ${groupId} not found` });
      }

      const now = new Date().toISOString();
      const removed: string[] = [];
      const errors: string[] = [];

      for (const tktId of ticketIds) {
        const ticket = queries.getTicketByTicketId(c.db, tktId);
        if (!ticket) {
          errors.push(`Ticket ${tktId} not found`);
          continue;
        }
        queries.removeTicketFromWorkGroup(c.db, group.id, ticket.id);
        removed.push(tktId);
      }

      // Update group timestamp
      queries.updateWorkGroup(c.db, group.id, { updatedAt: now });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            groupId,
            removed,
            errors: errors.length > 0 ? errors : undefined,
          }, null, 2),
        }],
      };
    },
  );

  // ─── list_work_groups ───────────────────────────────────────
  server.tool(
    "list_work_groups",
    "List work groups with aggregate progress summaries",
    {
      status: z.enum(["open", "completed", "cancelled"]).optional().describe("Filter by status"),
      tag: z.string().optional().describe("Filter by tag"),
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ status, tag, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved.ok) {
        return errText(resolved.error);
      }

      const access = checkToolAccess("list_work_groups", resolved.agent.role, resolved.agent.trustTier);
      if (!access.allowed) {
        return errJson({ denied: true, reason: access.reason });
      }

      const groups = queries.listWorkGroups(c.db, c.repoId, { status, tag });

      const results = groups.map((g) => {
        const progress = queries.getWorkGroupProgress(c.db, g.id);
        const tags = g.tagsJson ? JSON.parse(g.tagsJson) as string[] : [];

        // Derive display status: show "in_progress" when any ticket is active
        let displayStatus = g.status;
        if (g.status === "open" && progress.totalTickets > 0) {
          const activeStatuses = ["in_progress", "in_review", "ready_for_commit"];
          const hasActive = activeStatuses.some((s) => (progress.byStatus[s] ?? 0) > 0);
          if (hasActive) displayStatus = "in_progress";
        }

        return {
          groupId: g.groupId,
          title: g.title,
          description: g.description,
          status: g.status,
          displayStatus,
          createdBy: g.createdBy,
          tags,
          ...progress,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
        };
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: results.length,
            workGroups: results,
          }, null, 2),
        }],
      };
    },
  );
}

// autoCompleteWorkGroups moved to ../work-groups/completion.ts
export { autoCompleteWorkGroups } from "../work-groups/completion.js";
