import { randomUUID } from "node:crypto";
import type { MessageType } from "../../schemas/coordination.js";

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

  constructor(topology: Topology = "hub-spoke", maxHistory = 200) {
    this.topology = topology;
    this.maxHistory = maxHistory;
  }

  send(msg: Omit<BusMessage, "id" | "timestamp">): BusMessage {
    const full: BusMessage = {
      ...msg,
      id: `msg-${randomUUID().slice(0, 12)}`,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(full);

    // Trim old messages
    if (this.messages.length > this.maxHistory) {
      this.messages = this.messages.slice(-this.maxHistory);
    }

    return full;
  }

  /** Get messages visible to a given agent. */
  getMessages(agentId: string, since?: string, limit = 50): BusMessage[] {
    let filtered = this.messages.filter((m) => {
      // Agent always sees own messages
      if (m.from === agentId) return true;
      // Broadcasts visible to all
      if (m.to === null) return true;
      // Direct messages to this agent
      if (m.to === agentId) return true;
      // In mesh topology, all messages visible
      if (this.topology === "mesh") return true;
      return false;
    });

    if (since) {
      filtered = filtered.filter((m) => m.timestamp > since);
    }

    return filtered.slice(-limit);
  }

  getTopology(): Topology {
    return this.topology;
  }

  clear(): void {
    this.messages = [];
  }
}
