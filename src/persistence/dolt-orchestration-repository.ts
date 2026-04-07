import type { Pool, RowDataPacket } from "mysql2/promise";
import { ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import { StorageError } from "../core/errors.js";
import { generateId, timestamp, workId, agentId } from "../core/types.js";
import type { WorkId, AgentId, Timestamp } from "../core/types.js";
import type {
  OrchestrationEvent,
  OrchestrationEventRepository,
  OrchestrationEventType,
} from "../orchestration/repository.js";
import { executeQuery, executeMutation } from "./connection.js";

interface OrchestrationEventRow extends RowDataPacket {
  id: string;
  work_id: string;
  event_type: string;
  agent_id?: string | null;
  details: string;
  created_at: string;
}

export class DoltOrchestrationRepository implements OrchestrationEventRepository {
  constructor(private readonly pool: Pool) {}

  async logEvent(
    event: Omit<OrchestrationEvent, "id" | "createdAt">,
  ): Promise<Result<OrchestrationEvent, StorageError>> {
    const id = generateId("evt");
    const createdAt = timestamp();

    const insertSql = `
      INSERT INTO orchestration_events (id, work_id, event_type, agent_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    const insertResult = await executeMutation(this.pool, insertSql, [
      id,
      event.workId,
      event.eventType,
      event.agentId ?? null,
      JSON.stringify(event.details),
      createdAt,
    ]);

    if (!insertResult.ok) return insertResult;

    const logged: OrchestrationEvent = {
      id,
      workId: event.workId,
      eventType: event.eventType,
      agentId: event.agentId,
      details: event.details,
      createdAt,
    };

    return ok(logged);
  }

  async findByWorkId(workId: WorkId): Promise<Result<OrchestrationEvent[], StorageError>> {
    const queryResult = await executeQuery(
      this.pool,
      "SELECT * FROM orchestration_events WHERE work_id = ? ORDER BY created_at ASC",
      [workId],
    );

    if (!queryResult.ok) return queryResult;

    const rows = queryResult.value as OrchestrationEventRow[];
    const events = rows.map((row) => this.parseEventRow(row));

    return ok(events);
  }

  async findByType(type: OrchestrationEventType): Promise<Result<OrchestrationEvent[], StorageError>> {
    const queryResult = await executeQuery(
      this.pool,
      "SELECT * FROM orchestration_events WHERE event_type = ? ORDER BY created_at DESC",
      [type],
    );

    if (!queryResult.ok) return queryResult;

    const rows = queryResult.value as OrchestrationEventRow[];
    const events = rows.map((row) => this.parseEventRow(row));

    return ok(events);
  }

  async findRecent(limit: number): Promise<Result<OrchestrationEvent[], StorageError>> {
    const queryResult = await executeQuery(
      this.pool,
      "SELECT * FROM orchestration_events ORDER BY created_at DESC LIMIT ?",
      [limit],
    );

    if (!queryResult.ok) return queryResult;

    const rows = queryResult.value as OrchestrationEventRow[];
    const events = rows.map((row) => this.parseEventRow(row));

    return ok(events);
  }

  private parseEventRow(row: OrchestrationEventRow): OrchestrationEvent {
    return {
      id: row.id,
      workId: workId(row.work_id),
      eventType: row.event_type as OrchestrationEventType,
      agentId: row.agent_id ? agentId(row.agent_id) : undefined,
      details: JSON.parse(row.details) as Record<string, unknown>,
      createdAt: timestamp(row.created_at),
    };
  }
}
