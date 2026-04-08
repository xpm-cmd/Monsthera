import { ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import { generateId, timestamp } from "../core/types.js";
import type { WorkId } from "../core/types.js";
import type { StorageError } from "../core/errors.js";
import type {
  OrchestrationEvent,
  OrchestrationEventRepository,
  OrchestrationEventType,
} from "./repository.js";

export class InMemoryOrchestrationEventRepository implements OrchestrationEventRepository {
  private static readonly MAX_EVENTS = 10_000;
  private events: OrchestrationEvent[] = [];

  async logEvent(
    event: Omit<OrchestrationEvent, "id" | "createdAt">,
  ): Promise<Result<OrchestrationEvent, StorageError>> {
    // Evict oldest events if at capacity
    if (this.events.length >= InMemoryOrchestrationEventRepository.MAX_EVENTS) {
      this.events = this.events.slice(-Math.floor(InMemoryOrchestrationEventRepository.MAX_EVENTS * 0.9));
    }

    const logged: OrchestrationEvent = {
      id: generateId("evt"),
      workId: event.workId,
      eventType: event.eventType,
      agentId: event.agentId,
      details: event.details,
      createdAt: timestamp(),
    };
    this.events.push(logged);
    return ok(logged);
  }

  async findByWorkId(workId: WorkId): Promise<Result<OrchestrationEvent[], StorageError>> {
    return ok(this.events.filter((e) => e.workId === workId));
  }

  async findByType(type: OrchestrationEventType): Promise<Result<OrchestrationEvent[], StorageError>> {
    return ok(this.events.filter((e) => e.eventType === type));
  }

  async findRecent(limit: number): Promise<Result<OrchestrationEvent[], StorageError>> {
    const sorted = [...this.events].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return ok(sorted.slice(0, limit));
  }
}
