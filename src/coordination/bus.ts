import { randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { MessageType } from "../../schemas/coordination.js";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";

export type Topology = "hub-spoke" | "hybrid" | "mesh";

export interface BusMessage {
  id: string;
  from: string;
  to: string | null;
  type: MessageType;
  payload: Record<string, unknown>;
  timestamp: string;
}

export class CoordinationBus {
  private messages: BusMessage[] = [];
  private topology: Topology;
  private maxHistory: number;
  private db: BetterSQLite3Database<typeof schema> | null;
  private repoId: number | null;

  constructor(
    topology: Topology = "hub-spoke",
    maxHistory = 200,
    db?: BetterSQLite3Database<typeof schema>,
    repoId?: number,
  ) {
    this.topology = topology;
    this.maxHistory = maxHistory;
    this.db = db ?? null;
    this.repoId = repoId ?? null;
  }

  send(msg: Omit<BusMessage, "id" | "timestamp">): BusMessage {
    const full: BusMessage = {
      ...msg,
      id: `msg-${randomUUID().slice(0, 12)}`,
      timestamp: new Date().toISOString(),
    };

    if (this.db && this.repoId !== null) {
      queries.insertCoordinationMessage(this.db, {
        repoId: this.repoId,
        messageId: full.id,
        fromAgentId: full.from,
        toAgentId: full.to,
        type: full.type,
        payloadJson: JSON.stringify(full.payload),
        timestamp: full.timestamp,
      });
      return full;
    }

    this.messages.push(full);

    // Trim old messages
    if (this.messages.length > this.maxHistory) {
      this.messages = this.messages.slice(-this.maxHistory);
    }

    return full;
  }

  /** Get messages visible to a given agent. */
  getMessages(agentId: string, since?: string, limit = 50): BusMessage[] {
    const source = this.db && this.repoId !== null
      ? queries.getCoordinationMessagesByRepo(this.db, this.repoId, { since }).map((m) => ({
        id: m.messageId,
        from: m.fromAgentId,
        to: m.toAgentId,
        type: m.type as MessageType,
        payload: JSON.parse(m.payloadJson) as Record<string, unknown>,
        timestamp: m.timestamp,
      }))
      : this.messages;

    let filtered = source.filter((m) => {
      // Broadcasts visible to all (including own broadcasts)
      if (m.to === null) return true;
      // Direct messages TO this agent
      if (m.to === agentId) return true;
      // In mesh topology, all messages visible except own outbound directs
      if (this.topology === "mesh" && m.from !== agentId) return true;
      return false;
    });

    if (since && !this.db) {
      filtered = filtered.filter((m) => m.timestamp > since);
    }

    return filtered.slice(-limit);
  }

  getTopology(): Topology {
    return this.topology;
  }

  clear(): void {
    if (this.db) return;
    this.messages = [];
  }
}
