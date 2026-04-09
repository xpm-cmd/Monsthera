import type { Result } from "../core/result.js";
import type { StorageError } from "../core/errors.js";

// ─── V2 Source Types ─────────────────────────────────────────────────────────
// These types model the v2 SQLite schema. They live exclusively in the
// migration boundary — the v3 core never imports them.

/** A v2 ticket as stored in SQLite */
export interface V2Ticket {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: "open" | "in-progress" | "resolved" | "closed" | "wontfix";
  readonly priority: "p0" | "p1" | "p2" | "p3";
  readonly assignee: string | null;
  readonly tags: readonly string[];
  readonly codeRefs: readonly string[];
  readonly acceptance_criteria?: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly resolved_at: string | null;
}

/** A v2 council verdict attached to a ticket */
export interface V2Verdict {
  readonly ticket_id: string;
  readonly council_member: string;
  readonly outcome: "approved" | "rejected" | "deferred";
  readonly reasoning: string;
  readonly created_at: string;
}

/** A v2 council assignment */
export interface V2CouncilAssignment {
  readonly ticket_id: string;
  readonly council_member: string;
  readonly role: string;
  readonly assigned_at: string;
}

/** A v2 knowledge article from the SQLite knowledge table */
export interface V2KnowledgeRecord {
  readonly key: string;
  readonly type: string;
  readonly scope: string;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

/** A v2 note from the SQLite notes table */
export interface V2NoteRecord {
  readonly key: string;
  readonly type: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly codeRefs: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

// ─── V2 Source Reader Interface ──────────────────────────────────────────────
// Abstracts over the actual SQLite connection so tests can supply in-memory data.

export interface V2SourceReader {
  /** Read all tickets from the v2 database */
  readTickets(): Promise<Result<V2Ticket[], StorageError>>;
  /** Read verdicts for a specific ticket */
  readVerdicts(ticketId: string): Promise<Result<V2Verdict[], StorageError>>;
  /** Read council assignments for a specific ticket */
  readAssignments(ticketId: string): Promise<Result<V2CouncilAssignment[], StorageError>>;
  /** Read all knowledge rows from the v2 database */
  readKnowledge?(): Promise<Result<V2KnowledgeRecord[], StorageError>>;
  /** Read all note rows from the v2 database */
  readNotes?(): Promise<Result<V2NoteRecord[], StorageError>>;
  /** Close the underlying connection */
  close(): Promise<void>;
}

// ─── Migration Result Types ──────────────────────────────────────────────────

/** What mode the migration runs in */
export type MigrationMode = "dry-run" | "validate" | "execute";
export type MigrationScope = "work" | "knowledge" | "all";

/** Result of mapping a single v2 ticket */
export interface MappedArticle {
  readonly scope: "work";
  readonly v2Id: string;
  readonly title: string;
  readonly template: string;
  readonly priority: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly codeRefs: readonly string[];
  readonly assignee?: string | null;
  readonly phase: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | null;
  readonly aliases: readonly string[];
  readonly migrationHash: string;
}

export interface MappedKnowledgeArticle {
  readonly scope: "knowledge";
  readonly sourceKind: "knowledge" | "note";
  readonly sourceKey: string;
  readonly title: string;
  readonly category: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly codeRefs: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly migrationHash: string;
}

/** Outcome for a single ticket in a migration run */
export interface MigrationItemResult {
  readonly scope: "work" | "knowledge";
  readonly sourceId: string;
  readonly v3Id?: string;
  readonly status: "created" | "skipped" | "failed";
  readonly reason?: string;
}

/** Summary of a migration run */
export interface MigrationReport {
  readonly mode: MigrationMode;
  readonly scope: MigrationScope;
  readonly total: number;
  readonly created: number;
  readonly skipped: number;
  readonly failed: number;
  readonly items: readonly MigrationItemResult[];
}
