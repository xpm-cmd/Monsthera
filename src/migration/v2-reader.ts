import { createRequire } from "node:module";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { StorageError } from "../core/errors.js";
import type { DatabaseSync } from "node:sqlite";
import type {
  V2SourceReader,
  V2Ticket,
  V2Verdict,
  V2CouncilAssignment,
  V2KnowledgeRecord,
  V2NoteRecord,
} from "./types.js";

const require = createRequire(import.meta.url);

function loadNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

interface TicketRow {
  id: string;
  title: string;
  body: string | null;
  status: V2Ticket["status"];
  priority: V2Ticket["priority"];
  assignee: string | null;
  tags: string | null;
  code_refs?: string | null;
  acceptance_criteria?: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface CurrentTicketRow {
  id: string;
  title: string;
  body: string | null;
  status: string;
  severity: string | null;
  priority: number | null;
  assignee: string | null;
  tags: string | null;
  code_refs: string | null;
  acceptance_criteria: string | null;
  created_at: string;
  updated_at: string;
}

interface VerdictRow {
  ticket_id: string;
  council_member: string;
  outcome: V2Verdict["outcome"];
  reasoning: string | null;
  created_at: string;
}

interface CurrentVerdictRow {
  ticket_id: string;
  agent_id: string;
  specialization: string;
  verdict: string;
  reasoning: string | null;
  created_at: string;
}

interface AssignmentRow {
  ticket_id: string;
  council_member: string;
  role: string;
  assigned_at: string;
}

interface CurrentAssignmentRow {
  ticket_id: string;
  agent_id: string;
  specialization: string;
  assigned_at: string;
}

interface KnowledgeRow {
  key: string;
  type: string;
  scope: string;
  title: string;
  content: string;
  tags_json: string | null;
  created_at: string;
  updated_at: string;
}

interface NoteRow {
  key: string;
  type: string;
  content: string;
  metadata_json: string | null;
  linked_paths_json: string | null;
  created_at: string;
  updated_at: string;
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

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeStatus(status: string): V2Ticket["status"] {
  const normalized = status.trim().toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "resolved":
      return "resolved";
    case "closed":
      return "closed";
    case "wont-fix":
      return "wontfix";
    case "technical-analysis":
    case "blocked":
    case "in-progress":
      return "in-progress";
    case "backlog":
    case "open":
    default:
      return "open";
  }
}

function normalizePriority(severity: string | null, priority: number | null): V2Ticket["priority"] {
  switch (severity?.trim().toLowerCase()) {
    case "critical":
      return "p0";
    case "high":
      return "p1";
    case "medium":
      return "p2";
    case "low":
      return "p3";
    default:
      break;
  }

  if (priority === null) return "p2";
  if (priority >= 9) return "p0";
  if (priority >= 7) return "p1";
  if (priority >= 4) return "p2";
  return "p3";
}

function normalizeOutcome(verdict: string): V2Verdict["outcome"] {
  const normalized = verdict.trim().toLowerCase();
  switch (normalized) {
    case "pass":
    case "approved":
      return "approved";
    case "fail":
    case "rejected":
      return "rejected";
    case "abstain":
    case "deferred":
    default:
      return "deferred";
  }
}

export class SqliteV2SourceReader implements V2SourceReader {
  private readonly db: DatabaseSync;
  private readonly dialect: "legacy" | "current";

  constructor(private readonly dbPath: string) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.dialect = this.hasTable("review_verdicts") ? "current" : "legacy";
  }

  private hasTable(name: string): boolean {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      | { name: string }
      | undefined;
    return row !== undefined;
  }

  async readTickets(): Promise<Result<V2Ticket[], StorageError>> {
    try {
      if (this.dialect === "current") {
        const rows = this.db.prepare(
          "SELECT ticket_id AS id, title, description AS body, status, severity, priority, assignee_agent_id AS assignee, tags_json AS tags, affected_paths_json AS code_refs, acceptance_criteria, created_at, updated_at FROM tickets ORDER BY created_at ASC",
        ).all() as unknown as CurrentTicketRow[];

        return ok(
          rows.map((row) => ({
            id: row.id,
            title: row.title,
            body: row.body ?? "",
            status: normalizeStatus(row.status),
            priority: normalizePriority(row.severity, row.priority),
            assignee: row.assignee,
            tags: parseTags(row.tags),
            codeRefs: parseTags(row.code_refs),
            acceptance_criteria: row.acceptance_criteria,
            created_at: row.created_at,
            updated_at: row.updated_at,
            resolved_at: row.status === "resolved" || row.status === "wont_fix" ? row.updated_at : null,
          })),
        );
      }

      const rows = this.db.prepare(
        "SELECT id, title, body, status, priority, assignee, tags, NULL AS code_refs, NULL AS acceptance_criteria, created_at, updated_at, resolved_at FROM tickets ORDER BY created_at ASC",
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
          codeRefs: parseTags(row.code_refs ?? null),
          acceptance_criteria: row.acceptance_criteria ?? null,
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
      if (this.dialect === "current") {
        const rows = this.db.prepare(
          `SELECT t.ticket_id AS ticket_id, rv.agent_id, rv.specialization, rv.verdict, rv.reasoning, rv.created_at
           FROM review_verdicts rv
           JOIN tickets t ON t.id = rv.ticket_id
           WHERE t.ticket_id = ?
           ORDER BY rv.created_at ASC`,
        ).all(ticketId) as unknown as CurrentVerdictRow[];

        return ok(
          rows.map((row) => ({
            ticket_id: row.ticket_id,
            council_member: `${row.specialization} (${row.agent_id})`,
            outcome: normalizeOutcome(row.verdict),
            reasoning: row.reasoning ?? "",
            created_at: row.created_at,
          })),
        );
      }

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
      if (this.dialect === "current") {
        const rows = this.db.prepare(
          `SELECT t.ticket_id AS ticket_id, ca.agent_id, ca.specialization, ca.assigned_at
           FROM council_assignments ca
           JOIN tickets t ON t.id = ca.ticket_id
           WHERE t.ticket_id = ?
           ORDER BY ca.assigned_at ASC`,
        ).all(ticketId) as unknown as CurrentAssignmentRow[];

        return ok(
          rows.map((row) => ({
            ticket_id: row.ticket_id,
            council_member: row.agent_id,
            role: row.specialization,
            assigned_at: row.assigned_at,
          })),
        );
      }

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

  async readKnowledge(): Promise<Result<V2KnowledgeRecord[], StorageError>> {
    try {
      const rows = this.db.prepare(
        "SELECT key, type, scope, title, content, tags_json, created_at, updated_at FROM knowledge ORDER BY created_at ASC",
      ).all() as unknown as KnowledgeRow[];

      return ok(
        rows.map((row) => ({
          key: row.key,
          type: row.type,
          scope: row.scope,
          title: row.title,
          content: row.content,
          tags: parseTags(row.tags_json),
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
      );
    } catch (error) {
      return err(new StorageError(`Failed to read v2 knowledge from ${this.dbPath}`, { cause: String(error) }));
    }
  }

  async readNotes(): Promise<Result<V2NoteRecord[], StorageError>> {
    try {
      const rows = this.db.prepare(
        "SELECT key, type, content, metadata_json, linked_paths_json, created_at, updated_at FROM notes ORDER BY created_at ASC",
      ).all() as unknown as NoteRow[];

      return ok(
        rows.map((row) => {
          const metadata = parseJsonObject(row.metadata_json);
          const metadataTags = Object.entries(metadata)
            .filter(([, value]) => typeof value === "string" && String(value).trim().length > 0)
            .map(([key, value]) => `${key}:${String(value)}`);

          return {
            key: row.key,
            type: row.type,
            content: row.content,
            tags: metadataTags,
            codeRefs: parseTags(row.linked_paths_json),
            created_at: row.created_at,
            updated_at: row.updated_at,
          };
        }),
      );
    } catch (error) {
      return err(new StorageError(`Failed to read v2 notes from ${this.dbPath}`, { cause: String(error) }));
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
