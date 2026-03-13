import type { Database as DatabaseType } from "better-sqlite3";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as tables from "../db/schema.js";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import type { AgoraConfig } from "../core/config.js";
import type { InsightStream } from "../core/insight-stream.js";
import type { SearchRouter } from "../search/router.js";
import type { CoordinationBus } from "../coordination/bus.js";
import type { TicketStatus as TicketStatusType } from "../../schemas/ticket.js";
import { recordDashboardEvent } from "../dashboard/events.js";
import { updateTicketStatusRecord } from "./service.js";
import {
  shouldAutoTriage,
  shouldAutoClose,
  shouldAutoReview,
  shouldAutoUnblock,
} from "./lifecycle-rules.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface LifecycleHook {
  onTicketCreated(event: { ticketId: string; severity: string; priority: number }): void;
  onTicketStatusChanged(event: { ticketId: string; previousStatus: string; status: string; actorLabel?: string }): void;
  onPatchLinked(event: { ticketId: string; patchState: string }): void;
}

export interface LifecycleContext {
  config: AgoraConfig;
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
    if (this.isLifecycleActor(event)) return;

    // When a ticket reaches a terminal state, check if any blocked tickets can be unblocked
    const terminalStatuses = new Set(["resolved", "closed", "wont_fix"]);
    if (!terminalStatuses.has(event.status)) return;

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

  private checkUnblockTicket(ticket: { id: number; ticketId: string; status: string }): void {
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
    const wasLifecycleBlocked = blockedEntry?.agentId?.includes("lifecycle-") === true
      || blockerIds.length > 0; // has explicit "blocks" dependencies

    const blockerStatuses = blockerIds.map((id) => {
      const t = this.ctx.db
        .select()
        .from(tables.tickets)
        .where(eq(tables.tickets.id, id))
        .get();
      return t?.status ?? "unknown";
    });

    const result = shouldAutoUnblock(
      { status: ticket.status },
      blockerStatuses,
      this.lifecycle!,
      wasLifecycleBlocked,
    );

    if (result.shouldFire) {
      this.applyTransition(ticket.ticketId, result.targetStatus, "lifecycle-auto-unblock", result.reason);
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
    }
  }

  private isLifecycleActor(event: { actorLabel?: string }): boolean {
    return event.actorLabel?.startsWith("lifecycle-") === true;
  }
}
