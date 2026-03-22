import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { MonstheraContext } from "../core/context.js";
import { AgentIdSchema, SessionIdSchema } from "../core/input-hardening.js";
import { resolveAgent } from "./resolve-agent.js";
import { checkToolAccess } from "../trust/tiers.js";
import { errJson, errText } from "./response-helpers.js";
import * as queries from "../db/queries.js";
import { computeWaves, preflightWorkGroup, getReadyTickets, type TicketNode, type WavePlan } from "../waves/scheduler.js";
import { placeNewTickets, type RefreshCandidate, type WaveSlot, type RefreshResult } from "../waves/auto-refresh.js";
import { createIntegrationBranch, mergeIntegrationToMain } from "../waves/integration-branch.js";
import { processWaveMergeQueue, type MergeQueueEntry } from "../waves/merge-queue.js";
import type { MessageType } from "../../schemas/coordination.js";

type GetContext = () => Promise<MonstheraContext>;

export function registerWaveTools(server: McpServer, getContext: GetContext): void {
  // ─── compute_waves ──────────────────────────────────────────
  server.tool(
    "compute_waves",
    "Compute wave execution plan for a work group based on ticket dependencies",
    {
      groupId: z.string().min(1).describe("Work group ID (WG-...)"),
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ groupId, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved.ok) {
        return errText(resolved.error);
      }

      const access = checkToolAccess("compute_waves", resolved.agent.role, resolved.agent.trustTier);
      if (!access.allowed) {
        return errJson({ denied: true, reason: access.reason });
      }

      const group = queries.getWorkGroupByGroupId(c.db, groupId);
      if (!group) {
        return errJson({ error: `Work group ${groupId} not found` });
      }

      // Get all tickets in the group
      const groupTickets = queries.getWorkGroupTickets(c.db, group.id);
      if (groupTickets.length === 0) {
        return errJson({ error: "Work group has no tickets" });
      }

      // Build a set of ticket internal IDs in this group for filtering edges
      const ticketInternalIds = new Set(groupTickets.map((gt) => gt.tickets.id));
      const ticketIdMap = new Map(groupTickets.map((gt) => [gt.tickets.id, gt.tickets.ticketId]));

      // Collect "blocks" edges where BOTH tickets are in the group
      const blocksEdges: Array<{ blocker: string; blocked: string }> = [];

      for (const gt of groupTickets) {
        const deps = queries.getTicketDependencies(c.db, gt.tickets.id);
        // outgoing: from this ticket -> to another
        for (const dep of deps.outgoing) {
          if (dep.relationType === "blocks" && ticketInternalIds.has(dep.toTicketId)) {
            const blocker = ticketIdMap.get(gt.tickets.id)!;
            const blocked = ticketIdMap.get(dep.toTicketId)!;
            blocksEdges.push({ blocker, blocked });
          }
        }
      }

      // Build TicketNode[] from ticket data
      const nodes: TicketNode[] = groupTickets.map((gt) => ({
        ticketId: gt.tickets.ticketId,
        affectedPaths: gt.tickets.affectedPathsJson
          ? (JSON.parse(gt.tickets.affectedPathsJson) as string[])
          : [],
      }));

      // Run preflight validation (with maxPerWave from convoy config)
      const maxPerWave = c.config.convoy?.maxTicketsPerWave;
      const preflight = preflightWorkGroup(nodes, blocksEdges, maxPerWave);

      if (!preflight.valid) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              groupId,
              error: "cycle_detected",
              cycleTicketIds: preflight.cycleTicketIds,
            }, null, 2),
          }],
        };
      }

      const plan = preflight.plan!;
      const now = new Date().toISOString();

      // Persist wave plan JSON
      const wavePlanForStorage = {
        waves: plan.waves,
        waveCount: plan.waveCount,
        ticketWaveMap: Object.fromEntries(plan.ticketWaveMap),
        blockers: Object.fromEntries(
          Array.from(plan.blockers.entries()).map(([k, v]) => [k, v]),
        ),
      };

      queries.updateWorkGroupConvoy(c.db, group.id, {
        wavePlanJson: JSON.stringify(wavePlanForStorage),
        updatedAt: now,
      });

      // Set wave assignments for each ticket
      const assignments: Array<{ ticketId: number; waveNumber: number }> = [];
      for (const gt of groupTickets) {
        const waveNum = plan.ticketWaveMap.get(gt.tickets.ticketId);
        if (waveNum !== undefined) {
          assignments.push({ ticketId: gt.tickets.id, waveNumber: waveNum });
        }
      }
      queries.setWaveAssignments(c.db, group.id, assignments);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            groupId,
            waveCount: plan.waveCount,
            waves: plan.waves.map((w, i) => ({ wave: i, tickets: w })),
            fileOverlapWarnings: preflight.fileOverlapWarnings,
          }, null, 2),
        }],
      };
    },
  );

  // ─── launch_convoy ──────────────────────────────────────────
  server.tool(
    "launch_convoy",
    "Launch a wave convoy: create integration branch and dispatch first wave",
    {
      groupId: z.string().min(1).describe("Work group ID (WG-...)"),
      testCommand: z.string().optional().describe("Test command to run during merge validation"),
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ groupId, testCommand: _testCommand, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved.ok) {
        return errText(resolved.error);
      }

      const access = checkToolAccess("launch_convoy", resolved.agent.role, resolved.agent.trustTier);
      if (!access.allowed) {
        return errJson({ denied: true, reason: access.reason });
      }

      const group = queries.getWorkGroupByGroupId(c.db, groupId);
      if (!group) {
        return errJson({ error: `Work group ${groupId} not found` });
      }

      if (!group.wavePlanJson) {
        return errJson({ error: "No wave plan computed. Run compute_waves first." });
      }

      if (group.status !== "open") {
        return errJson({ error: `Work group status is '${group.status}', must be 'open' to launch` });
      }

      if (group.launchedAt) {
        return errJson({ error: "Convoy already launched", launchedAt: group.launchedAt });
      }

      // Create integration branch
      const { branchName } = await createIntegrationBranch(c.repoPath, groupId);

      const now = new Date().toISOString();

      // Update group with convoy info
      queries.updateWorkGroupConvoy(c.db, group.id, {
        currentWave: 0,
        integrationBranch: branchName,
        launchedAt: now,
        updatedAt: now,
      });

      // Mark wave-0 tickets as dispatched
      const wave0Tickets = queries.getWaveTickets(c.db, group.id, 0);
      for (const t of wave0Tickets) {
        queries.updateTicketWaveStatus(c.db, group.id, t.ticketId, "dispatched");
      }

      // Send coordination message
      c.bus.send({
        from: agentId,
        to: null,
        type: "broadcast" as MessageType,
        payload: {
          kind: "wave_dispatched",
          groupId,
          wave: 0,
          tickets: wave0Tickets.map((t) => t.ticketPublicId),
        },
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            groupId,
            launched: true,
            integrationBranch: branchName,
            currentWave: 0,
            dispatchedTickets: wave0Tickets.map((t) => t.ticketPublicId),
          }, null, 2),
        }],
      };
    },
  );

  // ─── advance_wave ───────────────────────────────────────────
  server.tool(
    "advance_wave",
    "Check wave completion, process merge queue, and advance to next wave",
    {
      groupId: z.string().min(1).describe("Work group ID (WG-...)"),
      testCommand: z.string().optional().describe("Test command to validate merges"),
      testTimeoutMs: z.number().int().positive().optional().describe("Test timeout in milliseconds (default: 120000)"),
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ groupId, testCommand, testTimeoutMs, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved.ok) {
        return errText(resolved.error);
      }

      const access = checkToolAccess("advance_wave", resolved.agent.role, resolved.agent.trustTier);
      if (!access.allowed) {
        return errJson({ denied: true, reason: access.reason });
      }

      const group = queries.getWorkGroupByGroupId(c.db, groupId);
      if (!group) {
        return errJson({ error: `Work group ${groupId} not found` });
      }

      if (!group.launchedAt || group.currentWave === null || group.currentWave === undefined) {
        return errJson({ error: "Convoy not launched. Run launch_convoy first." });
      }

      if (!group.integrationBranch) {
        return errJson({ error: "No integration branch found" });
      }

      const currentWave = group.currentWave;
      const complete = queries.isWaveComplete(c.db, group.id, currentWave);

      if (!complete) {
        // Return pending info
        const waveTickets = queries.getWaveTickets(c.db, group.id, currentWave);
        const pending = waveTickets.filter((t) => t.waveStatus !== "merged");
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              groupId,
              currentWave,
              complete: false,
              pendingTickets: pending.map((t) => ({
                ticketId: t.ticketPublicId,
                waveStatus: t.waveStatus,
                ticketStatus: t.status,
              })),
            }, null, 2),
          }],
        };
      }

      // Wave is complete — process merge queue
      const waveTickets = queries.getWaveTickets(c.db, group.id, currentWave);

      // Build MergeQueueEntry[] — find agent branches from assignee sessions
      const entries: MergeQueueEntry[] = [];
      const branchErrors: string[] = [];

      for (const t of waveTickets) {
        // Look up the ticket's assignee and their session worktree branch
        const ticket = queries.getTicketByTicketId(c.db, t.ticketPublicId);
        if (!ticket || !ticket.assigneeAgentId) {
          branchErrors.push(`${t.ticketPublicId}: no assignee`);
          continue;
        }

        // Find an active session for the assignee
        const sessions = queries.getActiveSessions(c.db);
        const agentSession = sessions.find((s) => s.agentId === ticket.assigneeAgentId);
        if (!agentSession) {
          branchErrors.push(`${t.ticketPublicId}: no active session for assignee ${ticket.assigneeAgentId}`);
          continue;
        }

        const worktree = queries.getSessionWorktree(c.db, agentSession.id);
        if (!worktree) {
          branchErrors.push(`${t.ticketPublicId}: no worktree branch for session ${agentSession.id}`);
          continue;
        }

        entries.push({
          ticketId: t.ticketPublicId,
          agentBranch: worktree.worktreeBranch,
          commitMessage: `merge: ${t.ticketPublicId} — ${t.title}`,
        });
      }

      // Process the merge queue
      const mergeResult = await processWaveMergeQueue(
        c.repoPath,
        group.integrationBranch,
        entries,
        { testCommand, testTimeoutMs },
      );

      // Update wave_status for each ticket based on merge result
      const now = new Date().toISOString();
      for (const t of waveTickets) {
        if (mergeResult.merged.includes(t.ticketPublicId)) {
          queries.updateTicketWaveStatus(c.db, group.id, t.ticketId, "merged");
        } else if (mergeResult.conflicted.includes(t.ticketPublicId)) {
          queries.updateTicketWaveStatus(c.db, group.id, t.ticketId, "conflict");
        } else if (mergeResult.testFailed.includes(t.ticketPublicId)) {
          queries.updateTicketWaveStatus(c.db, group.id, t.ticketId, "test_failed");
        }
      }

      // --- Auto-refresh: scan for new approved tickets ---
      const autoRefreshResult = await scanAndAbsorbNewTickets(c, group, currentWave);

      // Re-read wave plan (may have been extended by auto-refresh)
      const freshGroup = queries.getWorkGroupByGroupId(c.db, groupId)!;
      const wavePlan = JSON.parse(freshGroup.wavePlanJson ?? group.wavePlanJson!) as {
        waveCount: number;
        waves: string[][];
      };

      const nextWave = currentWave + 1;

      if (nextWave < wavePlan.waveCount) {
        // Advance to next wave
        queries.updateWorkGroupConvoy(c.db, group.id, {
          currentWave: nextWave,
          updatedAt: now,
        });

        // Dispatch next wave tickets
        const nextWaveTickets = queries.getWaveTickets(c.db, group.id, nextWave);
        for (const t of nextWaveTickets) {
          queries.updateTicketWaveStatus(c.db, group.id, t.ticketId, "dispatched");
        }

        // Send coordination message
        c.bus.send({
          from: agentId,
          to: null,
          type: "broadcast" as MessageType,
          payload: {
            kind: "wave_dispatched",
            groupId,
            wave: nextWave,
            tickets: nextWaveTickets.map((t) => t.ticketPublicId),
          },
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              groupId,
              completedWave: currentWave,
              mergeResult: {
                merged: mergeResult.merged,
                conflicted: mergeResult.conflicted,
                testFailed: mergeResult.testFailed,
                testsPassed: mergeResult.testsPassed,
                bisectCulprit: mergeResult.bisectCulprit,
              },
              branchErrors: branchErrors.length > 0 ? branchErrors : undefined,
              advanced: true,
              nextWave,
              dispatchedTickets: nextWaveTickets.map((t) => t.ticketPublicId),
              autoRefresh: autoRefreshResult ?? undefined,
            }, null, 2),
          }],
        };
      } else {
        // All waves done — merge integration to main and mark completed
        const finalMerge = await mergeIntegrationToMain(
          c.repoPath,
          group.integrationBranch,
          `convoy: merge ${groupId} integration branch`,
        );

        queries.updateWorkGroup(c.db, group.id, {
          status: "completed",
          updatedAt: now,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              groupId,
              completedWave: currentWave,
              mergeResult: {
                merged: mergeResult.merged,
                conflicted: mergeResult.conflicted,
                testFailed: mergeResult.testFailed,
                testsPassed: mergeResult.testsPassed,
                bisectCulprit: mergeResult.bisectCulprit,
              },
              branchErrors: branchErrors.length > 0 ? branchErrors : undefined,
              allWavesComplete: true,
              autoRefresh: autoRefreshResult ?? undefined,
              finalMerge: {
                merged: finalMerge.merged,
                commitSha: finalMerge.commitSha,
                conflicts: finalMerge.conflicts,
              },
              groupStatus: "completed",
            }, null, 2),
          }],
        };
      }
    },
  );

  // ─── get_wave_status ────────────────────────────────────────
  server.tool(
    "get_wave_status",
    "Get wave execution status for a work group",
    {
      groupId: z.string().min(1).describe("Work group ID (WG-...)"),
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ groupId, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved.ok) {
        return errText(resolved.error);
      }

      const access = checkToolAccess("get_wave_status", resolved.agent.role, resolved.agent.trustTier);
      if (!access.allowed) {
        return errJson({ denied: true, reason: access.reason });
      }

      const group = queries.getWorkGroupByGroupId(c.db, groupId);
      if (!group) {
        return errJson({ error: `Work group ${groupId} not found` });
      }

      if (!group.wavePlanJson) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              groupId,
              hasWavePlan: false,
              launched: false,
            }, null, 2),
          }],
        };
      }

      const wavePlan = JSON.parse(group.wavePlanJson) as {
        waveCount: number;
        waves: string[][];
        ticketWaveMap: Record<string, number>;
        blockers: Record<string, string[]>;
      };

      const launched = !!group.launchedAt;
      const currentWave = group.currentWave ?? null;

      // Build per-wave summaries
      const waveSummaries = wavePlan.waves.map((waveTicketIds, waveIdx) => {
        const waveTickets = queries.getWaveTickets(c.db, group.id, waveIdx);
        const byWaveStatus: Record<string, number> = {};
        for (const t of waveTickets) {
          const ws = t.waveStatus ?? "pending";
          byWaveStatus[ws] = (byWaveStatus[ws] ?? 0) + 1;
        }
        return {
          wave: waveIdx,
          ticketCount: waveTicketIds.length,
          ticketIds: waveTicketIds,
          byWaveStatus,
        };
      });

      // For current wave: detailed per-ticket status
      let currentWaveDetails: Array<{
        ticketId: string;
        title: string;
        ticketStatus: string;
        waveStatus: string | null;
      }> | undefined;

      let readyTickets: string[] | undefined;

      if (launched && currentWave !== null && currentWave < wavePlan.waveCount) {
        const waveTickets = queries.getWaveTickets(c.db, group.id, currentWave);
        currentWaveDetails = waveTickets.map((t) => ({
          ticketId: t.ticketPublicId,
          title: t.title,
          ticketStatus: t.status,
          waveStatus: t.waveStatus,
        }));

        // Reconstruct WavePlan for getReadyTickets
        const ticketWaveMap = new Map(Object.entries(wavePlan.ticketWaveMap).map(([k, v]) => [k, v]));
        const blockersMap = new Map(Object.entries(wavePlan.blockers).map(([k, v]) => [k, v]));
        const reconstructedPlan: WavePlan = {
          waves: wavePlan.waves,
          waveCount: wavePlan.waveCount,
          ticketWaveMap,
          blockers: blockersMap,
        };

        // Build ticket statuses map
        const groupTickets = queries.getWorkGroupTickets(c.db, group.id);
        const ticketStatuses = new Map<string, string>();
        for (const gt of groupTickets) {
          ticketStatuses.set(gt.tickets.ticketId, gt.tickets.status);
        }

        readyTickets = getReadyTickets(reconstructedPlan, currentWave, ticketStatuses);
      }

      // Auto-refresh info: show pending candidates
      let autoRefreshInfo: {
        enabled: boolean;
        maxTicketsPerWave: number;
        pendingCandidates: number;
        candidateTicketIds: string[];
      } | undefined;

      if (launched) {
        const convoyConfig = c.config.convoy;
        const candidates = queries.getApprovedTicketsNotInGroup(c.db, c.repoId, group.id);
        autoRefreshInfo = {
          enabled: convoyConfig?.autoRefresh ?? true,
          maxTicketsPerWave: convoyConfig?.maxTicketsPerWave ?? 5,
          pendingCandidates: candidates.length,
          candidateTicketIds: candidates.map((t) => t.ticketId),
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            groupId,
            groupStatus: group.status,
            hasWavePlan: true,
            launched,
            launchedAt: group.launchedAt ?? null,
            integrationBranch: group.integrationBranch ?? null,
            currentWave,
            waveCount: wavePlan.waveCount,
            waves: waveSummaries,
            currentWaveDetails,
            readyTickets,
            autoRefresh: autoRefreshInfo,
          }, null, 2),
        }],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Auto-refresh helper
// ---------------------------------------------------------------------------

interface AutoRefreshOutput {
  absorbed: string[];
  filledExistingWaves: number;
  appendedNewWaves: number;
  deferred: string[];
  fileOverlapWarnings: RefreshResult["fileOverlapWarnings"];
}

async function scanAndAbsorbNewTickets(
  c: MonstheraContext,
  group: NonNullable<ReturnType<typeof queries.getWorkGroupByGroupId>>,
  currentWave: number,
): Promise<AutoRefreshOutput | null> {
  const convoyConfig = c.config.convoy;
  if (!convoyConfig?.autoRefresh) return null;

  const candidates = queries.getApprovedTicketsNotInGroup(c.db, c.repoId, group.id);
  if (candidates.length === 0) return null;

  const maxTicketsPerWave = convoyConfig.maxTicketsPerWave ?? 5;

  // Gather dependency info for each candidate
  const refreshCandidates: RefreshCandidate[] = [];
  for (const cand of candidates) {
    const deps = queries.getTicketDependencies(c.db, cand.id);
    const blockerTicketIds: string[] = [];
    for (const dep of deps.incoming) {
      if (dep.relationType === "blocks") {
        const blocker = queries.getTicketById(c.db, dep.fromTicketId);
        if (blocker) blockerTicketIds.push(blocker.ticketId);
      }
    }
    refreshCandidates.push({
      ticketId: cand.ticketId,
      internalId: cand.id,
      affectedPaths: cand.affectedPathsJson
        ? (JSON.parse(cand.affectedPathsJson) as string[])
        : [],
      blockerTicketIds,
    });
  }

  // Build existing wave slots from the current convoy state
  const slotInfo = queries.getWaveSlotInfo(c.db, group.id);
  const waveTicketsCache = new Map<number, Array<{ affectedPathsJson: string | null }>>();

  const existingWaves: WaveSlot[] = slotInfo.map((s) => {
    let status: WaveSlot["status"];
    if (s.allMerged) {
      status = "completed";
    } else if (s.anyDispatched) {
      status = "dispatched";
    } else {
      status = "pending";
    }

    // Fetch existing paths for overlap checking
    const waveTickets = queries.getWaveTickets(c.db, group.id, s.waveNumber!);
    waveTicketsCache.set(s.waveNumber!, waveTickets);

    const existingPaths = waveTickets.map((t) =>
      t.affectedPathsJson ? (JSON.parse(t.affectedPathsJson) as string[]) : [],
    );

    return {
      waveIndex: s.waveNumber!,
      currentCount: s.ticketCount,
      status,
      existingPaths,
    };
  });

  // Build convoy context
  const groupTickets = queries.getWorkGroupTickets(c.db, group.id);
  const convoyTicketIds = new Set(groupTickets.map((gt) => gt.tickets.ticketId));
  const convoyTicketWaveMap = new Map<string, number>();
  for (const gt of groupTickets) {
    const wgt = gt.work_group_tickets;
    if (wgt.waveNumber !== null) {
      convoyTicketWaveMap.set(gt.tickets.ticketId, wgt.waveNumber);
    }
  }

  // Place new tickets
  const result = placeNewTickets(
    refreshCandidates,
    existingWaves,
    currentWave,
    convoyTicketIds,
    convoyTicketWaveMap,
    maxTicketsPerWave,
  );

  if (result.placements.size === 0) return null;

  // Persist placements
  const now = new Date().toISOString();
  const absorbed: string[] = [];
  let filledExisting = 0;
  const existingMaxWave = existingWaves.length > 0
    ? Math.max(...existingWaves.map((w) => w.waveIndex))
    : -1;

  // Separate into fill (existing waves) vs append (new waves)
  const fillAssignments: Array<{ ticketInternalId: number; waveNumber: number }> = [];
  const appendAssignments: Array<{ ticketInternalId: number; waveNumber: number; addedAt: string }> = [];

  for (const [ticketId, waveIndex] of result.placements) {
    const cand = refreshCandidates.find((c) => c.ticketId === ticketId);
    if (!cand) continue;

    absorbed.push(ticketId);

    if (waveIndex <= existingMaxWave) {
      // Fill into existing wave — ticket needs to be added to group first
      fillAssignments.push({ ticketInternalId: cand.internalId, waveNumber: waveIndex });
      filledExisting++;
    } else {
      appendAssignments.push({ ticketInternalId: cand.internalId, waveNumber: waveIndex, addedAt: now });
    }
  }

  // Add tickets to work group and set wave assignments
  for (const fa of fillAssignments) {
    queries.addTicketToWorkGroup(c.db, group.id, fa.ticketInternalId, now);
    // Set wave number via direct update
    queries.setWaveAssignments(c.db, group.id, [{ ticketId: fa.ticketInternalId, waveNumber: fa.waveNumber }]);
  }

  if (appendAssignments.length > 0) {
    queries.appendWaveAssignments(c.db, group.id, appendAssignments);
  }

  // Update wavePlanJson with new waves and mappings
  const storedPlan = JSON.parse(group.wavePlanJson!) as {
    waves: string[][];
    waveCount: number;
    ticketWaveMap: Record<string, number>;
    blockers: Record<string, string[]>;
  };

  // Extend waves array for new appended waves
  for (const [ticketId, waveIndex] of result.placements) {
    while (storedPlan.waves.length <= waveIndex) {
      storedPlan.waves.push([]);
    }
    storedPlan.waves[waveIndex]!.push(ticketId);
    storedPlan.ticketWaveMap[ticketId] = waveIndex;

    // Add blocker info
    const cand = refreshCandidates.find((c) => c.ticketId === ticketId);
    if (cand && cand.blockerTicketIds.length > 0) {
      storedPlan.blockers[ticketId] = cand.blockerTicketIds;
    }
  }
  storedPlan.waveCount = storedPlan.waves.length;

  queries.updateWorkGroupConvoy(c.db, group.id, {
    wavePlanJson: JSON.stringify(storedPlan),
    updatedAt: now,
  });

  return {
    absorbed,
    filledExistingWaves: filledExisting,
    appendedNewWaves: result.newWavesAppended,
    deferred: result.deferred,
    fileOverlapWarnings: result.fileOverlapWarnings,
  };
}
