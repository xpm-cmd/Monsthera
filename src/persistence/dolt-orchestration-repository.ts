import type { Pool, RowDataPacket } from "mysql2/promise";
import { ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { StorageError } from "../core/errors.js";
import { timestamp, workId, agentId } from "../core/types.js";
import type { Timestamp, WorkId } from "../core/types.js";
import type {
  OrchestrationEvent,
  OrchestrationEventRepository,
  OrchestrationEventType,
} from "../orchestration/repository.js";
import { executeQuery, executeMutation } from "./connection.js";
import { toIsoTimestamp } from "./sql-datetime.js";

interface OrchestrationEventRow extends RowDataPacket {
  id: number | string;
  work_id: string;
  event_type: string;
  agent_id?: string | null;
  details: string | Record<string, unknown> | null;
  created_at: string | Date;
}

export class DoltOrchestrationRepository implements OrchestrationEventRepository {
  constructor(private readonly pool: Pool) {}

  async logEvent(
    event: Omit<OrchestrationEvent, "id" | "createdAt">,
  ): Promise<Result<OrchestrationEvent, StorageError>> {
    const createdAt = timestamp();

    // The schema's id column is INT AUTO_INCREMENT. The repository used to
    // insert a generated "evt-*" string here and return it — real Dolt
    // coerced it on write, so the id callers received did not exist in the
    // database (found by the F1 real-Dolt smoke; mocks never noticed).
    // Let the database assign the id and return the persisted one.
    const insertSql = `
      INSERT INTO orchestration_events (work_id, event_type, agent_id, details, created_at)
      VALUES (?, ?, ?, ?, ?)
    `;

    const insertResult = await executeMutation(this.pool, insertSql, [
      event.workId,
      event.eventType,
      event.agentId ?? null,
      JSON.stringify(event.details),
      createdAt,
    ]);

    if (!insertResult.ok) return insertResult;

    const logged: OrchestrationEvent = {
      id: String(insertResult.value.insertId),
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

  async findInWindow(
    start: Timestamp,
    end: Timestamp,
    limit?: number,
  ): Promise<Result<OrchestrationEvent[], StorageError>> {
    const baseSql =
      "SELECT * FROM orchestration_events WHERE created_at BETWEEN ? AND ? ORDER BY created_at ASC";
    const sql = limit != null ? `${baseSql} LIMIT ?` : baseSql;
    const params: unknown[] = limit != null ? [start, end, limit] : [start, end];

    const queryResult = await executeQuery(this.pool, sql, params);
    if (!queryResult.ok) return queryResult;

    const rows = queryResult.value as OrchestrationEventRow[];
    const events = rows.map((row) => this.parseEventRow(row));
    return ok(events);
  }

  private parseEventRow(row: OrchestrationEventRow): OrchestrationEvent {
    const details = typeof row.details === "string"
      ? JSON.parse(row.details) as Record<string, unknown>
      : (row.details ?? {});

    return {
      id: String(row.id),
      workId: workId(row.work_id),
      eventType: row.event_type as OrchestrationEventType,
      agentId: row.agent_id ? agentId(row.agent_id) : undefined,
      details,
      createdAt: toIsoTimestamp(row.created_at),
    };
  }
}
