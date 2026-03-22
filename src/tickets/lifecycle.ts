import type { Database as DatabaseType } from "better-sqlite3";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as tables from "../db/schema.js";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import type { MonstheraConfig } from "../core/config.js";
import { parseStringArrayJson } from "../core/input-hardening.js";
import type { InsightStream } from "../core/insight-stream.js";
import type { SearchRouter } from "../search/router.js";
import type { CoordinationBus } from "../coordination/bus.js";
import type { TicketStatus as TicketStatusType } from "../../schemas/ticket.js";
import { getAgentPresenceSummary } from "../agents/registry.js";
import { recordDashboardEvent } from "../core/events.js";
import { spawnRepairTicket } from "./repair-spawner.js";
import { assignTicketRecord, commentTicketRecord, updateTicketStatusRecord } from "./service.js";
import {
  shouldAutoTriage,
  shouldAutoClose,
  shouldAutoReview,
  shouldAutoUnblock,
} from "./lifecycle-rules.js";

type DB = BetterSQLite3Database<typeof schema>;
const TERMINAL_TICKET_STATUSES = new Set(["resolved", "closed", "wont_fix"]);
const ORPHAN_REPAIR_STATUSES = new Set(["approved", "in_progress"]);
const REPAIR_TAG_PREFIX = "repair:";
const PARENT_TAG_PREFIX = "parent:";

function isLifecycleActorLabel(actorLabel?: string | null): boolean {
  if (!actorLabel) return false;
  return actorLabel.startsWith("lifecycle-")
    || actorLabel.startsWith("system:lifecycle-");
}

export interface LifecycleHook {
  onTicketCreated(event: { ticketId: string; severity: string; priority: number }): void;
  onTicketStatusChanged(event: { ticketId: string; previousStatus: string; status: string; actorLabel?: string }): void;
  onPatchLinked(event: { ticketId: string; patchState: string }): void;
}

export interface LifecycleContext {
  config: MonstheraConfig;
  db: DB;
  sqlite: DatabaseType;
  repoId: number;
  repoPath: string;
  insight: InsightStream;
  searchRouter: SearchRouter;
  bus: CoordinationBus;
}

export class TicketLifecycleReactor implements LifecycleHook {
  constructor(private ctx: LifecycleContext) {}

  private get lifecycle() {
    return this.ctx.config.lifecycle;
  }

  onTicketCreated(event: { ticketId: string; severity: string; priority: number }): void {
    if (!this.lifecycle?.enabled) return;

    const result = shouldAutoTriage(
      { status: "backlog", severity: event.severity, priority: event.priority },
      this.lifecycle,
    );

    if (result.shouldFire) {
      this.applyTransition(event.ticketId, result.targetStatus, "lifecycle-auto-triage", result.reason);
    }
  }

  onTicketStatusChanged(event: { ticketId: string; previousStatus: string; status: string; actorLabel?: string }): void {
    if (!this.lifecycle?.enabled) return;

    // When a ticket reaches a terminal state, check if any blocked tickets can be unblocked
    if (!TERMINAL_TICKET_STATUSES.has(event.status)) return;

    this.handleResolvedRepairTicket(event.ticketId, event.status);
    if (this.isLifecycleActor(event)) return;

    this.checkCascadeUnblock(event.ticketId);
  }

  onPatchLinked(event: { ticketId: string; patchState: string }): void {
    if (!this.lifecycle?.enabled) return;

    const ticket = queries.getTicketByTicketId(this.ctx.db, event.ticketId, this.ctx.repoId);
    if (!ticket) return;

    const result = shouldAutoReview({ status: ticket.status }, event.patchState, this.lifecycle);

    if (result.shouldFire) {
      this.applyTransition(event.ticketId, result.targetStatus, "lifecycle-auto-review", result.reason);
    }
  }

  sweep(): void {
    if (!this.lifecycle?.enabled) return;
    const now = Date.now();

    this.repairOrphanedAssignedTickets(now);

    // Auto-close resolved tickets past their age threshold
    if (this.lifecycle.autoCloseResolvedAfterMs > 0) {
      const resolved = queries.getTicketsByRepo(this.ctx.db, this.ctx.repoId, { status: "resolved" });
      for (const ticket of resolved) {
        const result = shouldAutoClose(
          { status: ticket.status, updatedAt: ticket.updatedAt },
          this.lifecycle,
          now,
        );
        if (result.shouldFire) {
          this.applyTransition(ticket.ticketId, result.targetStatus, "lifecycle-auto-close", result.reason);
        }
      }
    }

    // Auto-unblock blocked tickets whose blockers are all terminal
    if (this.lifecycle.autoCascadeBlocked) {
      const blocked = queries.getBlockedTicketsByRepo(this.ctx.db, this.ctx.repoId);
      for (const ticket of blocked) {
        this.checkUnblockTicket(ticket);
      }
    }
  }

  private repairOrphanedAssignedTickets(nowMs: number): void {
    const tickets = queries.getTicketsByRepo(this.ctx.db, this.ctx.repoId)
      .filter((ticket) => ORPHAN_REPAIR_STATUSES.has(ticket.status) && ticket.assigneeAgentId);

    for (const ticket of tickets) {
      const assigneeAgentId = ticket.assigneeAgentId;
      if (!assigneeAgentId) continue;

      const presence = getAgentPresenceSummary(this.ctx.db, assigneeAgentId, nowMs);
      if (presence.hasLiveOwnershipEvidence) continue;

      const clearResult = assignTicketRecord(
        { ...this.baseSystemContext("lifecycle-repair-orphaned-assignee"), system: true },
        {
          ticketId: ticket.ticketId,
          assigneeAgentId: null,
          actorLabel: "lifecycle-repair-orphaned-assignee",
        },
      );
      if (!clearResult.ok) {
        this.spawnLifecycleRepairTicket(
          ticket,
          `Lifecycle assignee repair failed while clearing ${assigneeAgentId}: ${clearResult.message}`,
        );
        continue;
      }

      const comment = `Lifecycle repair cleared stale assignee ${assigneeAgentId} after all live sessions expired.`;
      commentTicketRecord(
        { ...this.baseSystemContext("lifecycle-repair-orphaned-assignee"), system: true },
        {
          ticketId: ticket.ticketId,
          content: `[Lifecycle] ${comment}`,
          actorLabel: "lifecycle-repair-orphaned-assignee",
        },
      );

      if (ticket.status === "in_progress") {
        const requeueResult = updateTicketStatusRecord(
          { ...this.baseSystemContext("lifecycle-repair-orphaned-assignee"), system: true },
          {
            ticketId: ticket.ticketId,
            status: "approved",
            comment: `${comment} Ticket re-queued to approved for reassignment.`,
            actorLabel: "lifecycle-repair-orphaned-assignee",
          },
        );
        if (!requeueResult.ok) {
          this.spawnLifecycleRepairTicket(
            ticket,
            `Lifecycle assignee repair failed while re-queuing ${ticket.ticketId}: ${requeueResult.message}`,
          );
          continue;
        }
      }

      recordDashboardEvent(this.ctx.db, this.ctx.repoId, {
        type: "ticket_orphaned_owner_repaired",
        data: {
          ticketId: ticket.ticketId,
          previousStatus: ticket.status,
          repairedStatus: ticket.status === "in_progress" ? "approved" : ticket.status,
          previousAssigneeAgentId: assigneeAgentId,
          liveSessionCount: presence.liveSessionCount,
        },
      });
    }
  }

  private checkCascadeUnblock(resolvedTicketId: string): void {
    if (!this.lifecycle?.autoCascadeBlocked) return;

    const ticket = queries.getTicketByTicketId(this.ctx.db, resolvedTicketId, this.ctx.repoId);
    if (!ticket) return;

    // Find tickets that this one blocks (incoming "blocks" dependencies)
    const deps = queries.getTicketDependencies(this.ctx.db, ticket.id);
    const blockedTicketIds = deps.incoming
      .filter((d) => d.relationType === "blocks")
      .map((d) => d.fromTicketId);

    for (const blockedId of blockedTicketIds) {
      const blockedTicket = this.ctx.db
        .select()
        .from(tables.tickets)
        .where(eq(tables.tickets.id, blockedId))
        .get();
      if (blockedTicket && blockedTicket.status === "blocked") {
        this.checkUnblockTicket(blockedTicket);
      }
    }
  }

  private checkUnblockTicket(ticket: {
    id: number;
    ticketId: string;
    title: string;
    status: string;
    severity: string;
    affectedPathsJson?: string | null;
  }): void {
    const deps = queries.getTicketDependencies(this.ctx.db, ticket.id);
    // "blockedBy" = outgoing with relationType "blocked_by", or incoming "blocks"
    const blockerIds = [
      ...deps.outgoing.filter((d) => d.relationType === "blocked_by").map((d) => d.toTicketId),
      ...deps.incoming.filter((d) => d.relationType === "blocks").map((d) => d.fromTicketId),
    ];

    if (blockerIds.length === 0) return;

    // Check provenance: was this ticket blocked by the lifecycle system?
    const history = queries.getTicketHistory(this.ctx.db, ticket.id);
    const blockedEntry = history
      .filter((h) => h.toStatus === "blocked")
      .pop(); // most recent
    const wasLifecycleBlocked = isLifecycleActorLabel(blockedEntry?.agentId);

    const blockerStatuses = blockerIds.map((id) => {
      const t = this.ctx.db
        .select()
        .from(tables.tickets)
        .where(eq(tables.tickets.id, id))
        .get();
      return t?.status ?? "unknown";
    });
    const allBlockersTerminal = blockerStatuses.length > 0
      && blockerStatuses.every((status) => TERMINAL_TICKET_STATUSES.has(status));

    const result = shouldAutoUnblock(
      { status: ticket.status },
      blockerStatuses,
      this.lifecycle!,
      wasLifecycleBlocked,
    );

    if (result.shouldFire) {
      this.applyTransition(ticket.ticketId, result.targetStatus, "lifecycle-auto-unblock", result.reason);
      return;
    }

    if (allBlockersTerminal && !wasLifecycleBlocked) {
      this.spawnLifecycleRepairTicket(ticket, "Auto-unblock suppressed because the latest blocked transition was not lifecycle-owned.");
    }
  }

  private applyTransition(ticketId: string, targetStatus: TicketStatusType, actorLabel: string, comment: string): void {
    const result = updateTicketStatusRecord({
      db: this.ctx.db,
      repoId: this.ctx.repoId,
      repoPath: this.ctx.repoPath,
      insight: this.ctx.insight,
      ticketQuorum: this.ctx.config.ticketQuorum,
      governance: this.ctx.config.governance,
      bus: this.ctx.bus,
      refreshTicketSearch: () => this.ctx.searchRouter?.rebuildTicketFts?.(this.ctx.repoId),
      refreshKnowledgeSearch: (knowledgeIds?: number[]) => {
        if (knowledgeIds && knowledgeIds.length > 0) {
          for (const knowledgeId of knowledgeIds) {
            this.ctx.searchRouter?.upsertKnowledgeFts?.(this.ctx.sqlite, knowledgeId);
          }
          return;
        }
        this.ctx.searchRouter?.rebuildKnowledgeFts?.(this.ctx.sqlite);
      },
      system: true,
      actorLabel,
    }, {
      ticketId,
      status: targetStatus,
      actorLabel,
      comment,
    });

    if (result.ok) {
      this.ctx.insight.info(`Lifecycle: ${ticketId} → ${targetStatus} (${actorLabel})`);
      recordDashboardEvent(this.ctx.db, this.ctx.repoId, {
        type: "ticket_auto_transitioned",
        data: { ticketId, status: targetStatus, rule: actorLabel, reason: comment },
      });
      return;
    }

    const ticket = queries.getTicketByTicketId(this.ctx.db, ticketId, this.ctx.repoId);
    if (!ticket) return;
    this.spawnLifecycleRepairTicket(
      ticket,
      `Lifecycle transition ${ticket.status} → ${targetStatus} failed (${actorLabel}): ${result.message}`,
    );
  }

  private isLifecycleActor(event: { actorLabel?: string }): boolean {
    return isLifecycleActorLabel(event.actorLabel);
  }

  private handleResolvedRepairTicket(ticketId: string, status: string): void {
    const ticket = queries.getTicketByTicketId(this.ctx.db, ticketId, this.ctx.repoId);
    if (!ticket) return;

    const tags = parseStringArrayJson(ticket.tagsJson, { maxItems: 50, maxItemLength: 200 });
    const repairTag = tags.find((tag) => tag.startsWith(REPAIR_TAG_PREFIX));
    if (!repairTag) return;

    const parentTicketId = this.getRepairParentTicketId(ticket.id, tags);
    if (!parentTicketId) return;

    const nextStep = repairTag === "repair:council_veto"
      ? "Resume in_review validation and reconsider the blocked veto path."
      : "Re-run the suppressed lifecycle path and validate that automation can continue.";
    commentTicketRecord(
      { ...this.baseSystemContext("repair-follow-up"), system: true },
      {
        ticketId: parentTicketId,
        content: `[Auto-Repair] Follow-up ${ticket.ticketId} reached ${status}. ${nextStep}`,
        agentId: "system",
        sessionId: "system",
      },
    );
    recordDashboardEvent(this.ctx.db, this.ctx.repoId, {
      type: "ticket_repair_resolved",
      data: { parentTicketId, repairTicketId: ticket.ticketId, status, source: repairTag.slice(REPAIR_TAG_PREFIX.length) },
    });
  }

  private getRepairParentTicketId(ticketInternalId: number, tags: string[]): string | null {
    const parentTag = tags.find((tag) => tag.startsWith(PARENT_TAG_PREFIX));
    if (parentTag) return parentTag.slice(PARENT_TAG_PREFIX.length);

    const deps = queries.getTicketDependencies(this.ctx.db, ticketInternalId);
    const parentDep = deps.incoming.find((dep) => dep.relationType === "relates_to");
    if (!parentDep) return null;
    return queries.getTicketById(this.ctx.db, parentDep.fromTicketId)?.ticketId ?? null;
  }

  private spawnLifecycleRepairTicket(
    ticket: {
      ticketId: string;
      title: string;
      severity: string;
      affectedPathsJson?: string | null;
    },
    reason: string,
  ): void {
    if (!this.ctx.config.repairSpawner?.enabled) return;

    void spawnRepairTicket(
      { ...this.baseSystemContext("repair:lifecycle-suppression"), system: true },
      {
        type: "lifecycle_suppression",
        parentTicketId: ticket.ticketId,
        parentTicketTitle: ticket.title,
        reason,
        affectedPaths: parseStringArrayJson(ticket.affectedPathsJson, {
          maxItems: 100,
          maxItemLength: 500,
        }),
        severity: ticket.severity,
      },
      this.ctx.config.repairSpawner,
    ).catch((error) => {
      this.ctx.insight.warn(`Lifecycle repair spawning failed for ${ticket.ticketId}: ${error}`);
    });
  }

  private baseSystemContext(actorLabel: string) {
    return {
      db: this.ctx.db,
      repoId: this.ctx.repoId,
      repoPath: this.ctx.repoPath,
      insight: this.ctx.insight,
      ticketQuorum: this.ctx.config.ticketQuorum,
      governance: this.ctx.config.governance,
      bus: this.ctx.bus,
      refreshTicketSearch: () => this.ctx.searchRouter?.rebuildTicketFts?.(this.ctx.repoId),
      refreshKnowledgeSearch: (knowledgeIds?: number[]) => {
        if (knowledgeIds && knowledgeIds.length > 0) {
          for (const knowledgeId of knowledgeIds) {
            this.ctx.searchRouter?.upsertKnowledgeFts?.(this.ctx.sqlite, knowledgeId);
          }
          return;
        }
        this.ctx.searchRouter?.rebuildKnowledgeFts?.(this.ctx.sqlite);
      },
      lifecycle: this,
      actorLabel,
    };
  }
}
