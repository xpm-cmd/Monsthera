import { randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { MessageType } from "../../schemas/coordination.js";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import { safeParseJsonObject } from "../core/input-hardening.js";

export type Topology = "hub-spoke" | "hybrid" | "mesh";
export type MessagePriority = "critical" | "normal" | "low";

const PRIORITY_ORDER: Record<MessagePriority, number> = {
  critical: 0,
  normal: 1,
  low: 2,
};

/** Message types safe to coalesce (merge within a time window). */
const COALESCEABLE_TYPES = new Set<string>(["status_update"]);

export interface BusMessage {
  id: string;
  from: string;
  to: string | null;
  type: MessageType;
  payload: Record<string, unknown>;
  timestamp: string;
  priority: MessagePriority;
  laneId: string | null;
}

export interface BusOptions {
  coalesceWindowMs?: number;         // default 0 (disabled)
  maxQueueDepthPerAgent?: number;    // default 100
}

export class CoordinationBus {
  private messages: BusMessage[] = [];
  private topology: Topology;
  private maxHistory: number;
  private db: BetterSQLite3Database<typeof schema> | null;
  private repoId: number | null;
  private coalesceWindowMs: number;
  private maxQueueDepthPerAgent: number;

  constructor(
    topology: Topology = "hub-spoke",
    maxHistory = 200,
    db?: BetterSQLite3Database<typeof schema>,
    repoId?: number,
    opts?: BusOptions,
  ) {
    this.topology = topology;
    this.maxHistory = maxHistory;
    this.db = db ?? null;
    this.repoId = repoId ?? null;
    this.coalesceWindowMs = opts?.coalesceWindowMs ?? 0;
    this.maxQueueDepthPerAgent = opts?.maxQueueDepthPerAgent ?? 100;
  }

  send(msg: Omit<BusMessage, "id" | "timestamp" | "priority" | "laneId"> & { priority?: MessagePriority; laneId?: string | null }): BusMessage & { backpressure?: boolean } {
    const priority = msg.priority ?? "normal";
    const laneId = msg.laneId ?? null;

    // Coalescing: merge with recent message from same agent if within window
    if (this.coalesceWindowMs > 0 && COALESCEABLE_TYPES.has(msg.type) && !this.db) {
      const now = Date.now();
      const windowStart = now - this.coalesceWindowMs;

      for (let i = this.messages.length - 1; i >= 0; i--) {
        const existing = this.messages[i]!;
        if (new Date(existing.timestamp).getTime() < windowStart) break;

        if (
          existing.from === msg.from &&
          existing.type === msg.type &&
          existing.laneId === laneId
        ) {
          // Merge payloads (newer wins on conflict)
          existing.payload = { ...existing.payload, ...msg.payload };
          existing.timestamp = new Date().toISOString();
          existing.priority = priority;
          return { ...existing, backpressure: this.checkBackpressure(existing.to) };
        }
      }
    }

    const full: BusMessage = {
      ...msg,
      id: `msg-${randomUUID().slice(0, 12)}`,
      timestamp: new Date().toISOString(),
      priority,
      laneId,
    };

    if (this.db && this.repoId !== null) {
      // Embed priority and laneId in payload as __meta for DB persistence
      const persistPayload = {
        ...full.payload,
        __meta: { priority: full.priority, laneId: full.laneId },
      };
      queries.insertCoordinationMessage(this.db, {
        repoId: this.repoId,
        messageId: full.id,
        fromAgentId: full.from,
        toAgentId: full.to,
        type: full.type,
        payloadJson: JSON.stringify(persistPayload),
        timestamp: full.timestamp,
      });
      return { ...full, backpressure: this.checkBackpressure(full.to) };
    }

    this.messages.push(full);

    // Trim old messages
    if (this.messages.length > this.maxHistory) {
      this.messages = this.messages.slice(-this.maxHistory);
    }

    return { ...full, backpressure: this.checkBackpressure(full.to) };
  }

  /** Get messages visible to a given agent. */
  getMessages(
    agentId: string,
    since?: string,
    limit = 50,
    opts?: {
      laneId?: string;
      minPriority?: MessagePriority;
    },
  ): BusMessage[] {
    const source = this.db && this.repoId !== null
      ? queries.getCoordinationMessagesByRepo(this.db, this.repoId, { since }).map((m) => {
        const raw = safeParseJsonObject(m.payloadJson) ?? {};
        // Extract __meta if present (DB-persisted priority/laneId)
        const meta = raw.__meta as { priority?: string; laneId?: string | null } | undefined;
        const { __meta: _, ...payload } = raw;
        return {
          id: m.messageId,
          from: m.fromAgentId,
          to: m.toAgentId,
          type: m.type as MessageType,
          payload,
          timestamp: m.timestamp,
          priority: (meta?.priority as MessagePriority) ?? "normal",
          laneId: meta?.laneId ?? null,
        };
      })
      : this.messages;

    let filtered = source.filter((m) => {
      // Visibility rules
      if (m.to === null) { /* broadcast — visible to all */ }
      else if (m.to === agentId) { /* direct TO this agent */ }
      else if (this.topology === "mesh" && m.from !== agentId) { /* mesh visibility */ }
      else return false;

      // Lane filter
      if (opts?.laneId && m.laneId !== null && m.laneId !== opts.laneId) return false;

      // Priority filter
      if (opts?.minPriority) {
        if (PRIORITY_ORDER[m.priority] > PRIORITY_ORDER[opts.minPriority]) return false;
      }

      return true;
    });

    if (since && !this.db) {
      filtered = filtered.filter((m) => m.timestamp > since);
    }

    // Sort by priority (critical first), stable within same priority
    filtered.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

    return filtered.slice(-limit);
  }

  getTopology(): Topology {
    return this.topology;
  }

  clear(): void {
    if (this.db) return;
    this.messages = [];
  }

  /** Check if target agent is over backpressure threshold. */
  private checkBackpressure(to: string | null): boolean {
    if (to === null) return false;

    const source = this.db ? null : this.messages;
    if (!source) return false; // Skip for DB mode (expensive count)

    let count = 0;
    for (const m of source) {
      if (m.to === to) count++;
    }
    return count > this.maxQueueDepthPerAgent;
  }
}

