import { createHash } from "node:crypto";
import type { V2Ticket, V2Verdict, V2CouncilAssignment, MappedArticle } from "./types.js";

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
    v2Id: ticket.id,
    title: ticket.title,
    template: inferTemplate(ticket),
    priority: PRIORITY_MAP[ticket.priority] ?? "medium",
    content: buildContent(ticket, verdicts, assignments),
    tags: [...ticket.tags],
    aliases: [ticket.id],
    migrationHash: computeMigrationHash(ticket.id),
  };
}
