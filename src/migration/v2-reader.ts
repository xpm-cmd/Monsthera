import { DatabaseSync } from "node:sqlite";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { StorageError } from "../core/errors.js";
import type {
  V2SourceReader,
  V2Ticket,
  V2Verdict,
  V2CouncilAssignment,
} from "./types.js";

interface TicketRow {
  id: string;
  title: string;
  body: string | null;
  status: V2Ticket["status"];
  priority: V2Ticket["priority"];
  assignee: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface VerdictRow {
  ticket_id: string;
  council_member: string;
  outcome: V2Verdict["outcome"];
  reasoning: string | null;
  created_at: string;
}

interface AssignmentRow {
  ticket_id: string;
  council_member: string;
  role: string;
  assigned_at: string;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((value) => String(value).trim())
        .filter(Boolean);
    }
  } catch {
    // Fall through to comma/newline parsing for legacy string columns.
  }

  return raw
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export class SqliteV2SourceReader implements V2SourceReader {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
  }

  async readTickets(): Promise<Result<V2Ticket[], StorageError>> {
    try {
      const rows = this.db.prepare(
        "SELECT id, title, body, status, priority, assignee, tags, created_at, updated_at, resolved_at FROM tickets ORDER BY created_at ASC",
      ).all() as unknown as TicketRow[];

      return ok(
        rows.map((row) => ({
          id: row.id,
          title: row.title,
          body: row.body ?? "",
          status: row.status,
          priority: row.priority,
          assignee: row.assignee,
          tags: parseTags(row.tags),
          created_at: row.created_at,
          updated_at: row.updated_at,
          resolved_at: row.resolved_at,
        })),
      );
    } catch (error) {
      return err(new StorageError(`Failed to read v2 tickets from ${this.dbPath}`, { cause: String(error) }));
    }
  }

  async readVerdicts(ticketId: string): Promise<Result<V2Verdict[], StorageError>> {
    try {
      const rows = this.db.prepare(
        "SELECT ticket_id, council_member, outcome, reasoning, created_at FROM verdicts WHERE ticket_id = ? ORDER BY created_at ASC",
      ).all(ticketId) as unknown as VerdictRow[];

      return ok(
        rows.map((row) => ({
          ticket_id: row.ticket_id,
          council_member: row.council_member,
          outcome: row.outcome,
          reasoning: row.reasoning ?? "",
          created_at: row.created_at,
        })),
      );
    } catch (error) {
      return err(new StorageError(`Failed to read verdicts for v2 ticket ${ticketId}`, { cause: String(error) }));
    }
  }

  async readAssignments(ticketId: string): Promise<Result<V2CouncilAssignment[], StorageError>> {
    try {
      const rows = this.db.prepare(
        "SELECT ticket_id, council_member, role, assigned_at FROM council_assignments WHERE ticket_id = ? ORDER BY assigned_at ASC",
      ).all(ticketId) as unknown as AssignmentRow[];

      return ok(
        rows.map((row) => ({
          ticket_id: row.ticket_id,
          council_member: row.council_member,
          role: row.role,
          assigned_at: row.assigned_at,
        })),
      );
    } catch (error) {
      return err(new StorageError(`Failed to read council assignments for v2 ticket ${ticketId}`, { cause: String(error) }));
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
