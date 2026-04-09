import { createHash } from "node:crypto";
import type {
  V2Ticket,
  V2Verdict,
  V2CouncilAssignment,
  V2KnowledgeRecord,
  V2NoteRecord,
  MappedArticle,
  MappedKnowledgeArticle,
} from "./types.js";

// ─── Priority Mapping ────────────────────────────────────────────────────────

const PRIORITY_MAP: Record<string, string> = {
  p0: "critical",
  p1: "high",
  p2: "medium",
  p3: "low",
};

// ─── Template Inference ──────────────────────────────────────────────────────
// v2 had no explicit template field. We infer from tags and title heuristics.

function inferTemplate(ticket: V2Ticket): string {
  const lower = ticket.title.toLowerCase();
  const tagSet = new Set(ticket.tags.map((t) => t.toLowerCase()));

  if (tagSet.has("bug") || tagSet.has("bugfix") || lower.startsWith("fix")) return "bugfix";
  if (tagSet.has("refactor") || lower.startsWith("refactor")) return "refactor";
  if (tagSet.has("spike") || tagSet.has("research") || lower.startsWith("spike")) return "spike";
  return "feature";
}

// ─── Content Builder ─────────────────────────────────────────────────────────
// Assembles v3 Markdown body from the v2 ticket body, verdicts, and assignments.

function buildContent(
  ticket: V2Ticket,
  verdicts: readonly V2Verdict[],
  assignments: readonly V2CouncilAssignment[],
): string {
  const sections: string[] = [];

  // Original ticket body
  if (ticket.body.trim()) {
    sections.push(ticket.body.trim());
  }

  if (ticket.acceptance_criteria?.trim()) {
    sections.push(`## Acceptance Criteria\n\n${ticket.acceptance_criteria.trim()}`);
  }

  // Council assignments summary
  if (assignments.length > 0) {
    const lines = assignments.map(
      (a) => `- **${a.council_member}** as ${a.role} (assigned ${a.assigned_at})`,
    );
    sections.push(`## Council Assignments\n\n${lines.join("\n")}`);
  }

  // Verdicts become enrichment-style sections
  for (const verdict of verdicts) {
    const header = `## Verdict: ${verdict.council_member}`;
    const meta = `<!-- status: ${verdict.outcome} -->`;
    sections.push(`${header}\n\n${meta}\n\n${verdict.reasoning.trim()}`);
  }

  return sections.join("\n\n---\n\n");
}

// ─── Migration Hash ──────────────────────────────────────────────────────────

export function computeMigrationHash(v2Id: string): string {
  return createHash("sha256").update(v2Id).digest("hex");
}

function inferPhase(ticket: V2Ticket): MappedArticle["phase"] {
  switch (ticket.status) {
    case "in-progress":
      return "implementation";
    case "resolved":
    case "closed":
      return "done";
    case "wontfix":
      return "cancelled";
    case "open":
    default:
      return "planning";
  }
}

function deriveKnowledgeTitle(note: V2NoteRecord): string {
  const firstLine = note.content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (firstLine) {
    return firstLine.replace(/^#+\s*/, "").trim();
  }

  return note.key
    .split(":")
    .map((part) => part.replaceAll(/[-_]/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ─── Public Mapper ───────────────────────────────────────────────────────────

/**
 * Map a v2 ticket (with its verdicts and assignments) to a v3 MappedArticle.
 * This is a pure function — no I/O, no side effects.
 */
export function mapTicketToArticle(
  ticket: V2Ticket,
  verdicts: readonly V2Verdict[],
  assignments: readonly V2CouncilAssignment[],
): MappedArticle {
  return {
    scope: "work",
    v2Id: ticket.id,
    title: ticket.title,
    template: inferTemplate(ticket),
    phase: inferPhase(ticket),
    priority: PRIORITY_MAP[ticket.priority] ?? "medium",
    content: buildContent(ticket, verdicts, assignments),
    tags: [...ticket.tags],
    codeRefs: [...ticket.codeRefs],
    assignee: ticket.assignee,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
    completedAt: ticket.resolved_at,
    aliases: [ticket.id],
    migrationHash: computeMigrationHash(ticket.id),
  };
}

export function mapKnowledgeToArticle(record: V2KnowledgeRecord): MappedKnowledgeArticle {
  return {
    scope: "knowledge",
    sourceKind: "knowledge",
    sourceKey: record.key,
    title: record.title,
    category: record.type,
    content: record.content,
    tags: [...record.tags, `scope:${record.scope}`, `source-key:${record.key}`],
    codeRefs: [],
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    migrationHash: computeMigrationHash(`knowledge:${record.key}`),
  };
}

export function mapNoteToArticle(record: V2NoteRecord): MappedKnowledgeArticle {
  return {
    scope: "knowledge",
    sourceKind: "note",
    sourceKey: record.key,
    title: deriveKnowledgeTitle(record),
    category: record.type,
    content: record.content,
    tags: [...record.tags, `source-key:${record.key}`],
    codeRefs: [...record.codeRefs],
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    migrationHash: computeMigrationHash(`note:${record.key}`),
  };
}
