import type { KnowledgeArticle } from "../knowledge/repository.js";
import type { WorkArticle } from "../work/repository.js";
import type { SearchResult } from "../search/repository.js";

// ─── Error formatting ────────────────────────────────────────────────────────

export function formatError(error: { code: string; message: string }): string {
  return `Error [${error.code}]: ${error.message}`;
}

// ─── Knowledge article ───────────────────────────────────────────────────────

export function formatArticle(article: KnowledgeArticle): string {
  const lines: string[] = [
    `ID:        ${article.id}`,
    `Title:     ${article.title}`,
    `Slug:      ${article.slug}`,
    `Category:  ${article.category}`,
    `Tags:      ${article.tags.length > 0 ? article.tags.join(", ") : "(none)"}`,
    `Code refs: ${article.codeRefs.length > 0 ? article.codeRefs.join(", ") : "(none)"}`,
    `Source:    ${article.sourcePath ?? "(manual)"}`,
    `Created:   ${article.createdAt}`,
    `Updated:   ${article.updatedAt}`,
    "",
    article.content,
  ];
  return lines.join("\n");
}

// ─── Work article ────────────────────────────────────────────────────────────

export function formatWorkArticle(work: WorkArticle): string {
  const lines: string[] = [
    `ID:        ${work.id}`,
    `Title:     ${work.title}`,
    `Template:  ${work.template}`,
    `Phase:     ${work.phase}`,
    `Priority:  ${work.priority}`,
    `Author:    ${work.author}`,
  ];

  if (work.assignee) lines.push(`Assignee:  ${work.assignee}`);
  if (work.lead) lines.push(`Lead:      ${work.lead}`);

  lines.push(`Tags:      ${work.tags.length > 0 ? work.tags.join(", ") : "(none)"}`);
  lines.push(`Code refs: ${work.codeRefs.length > 0 ? work.codeRefs.join(", ") : "(none)"}`);

  if (work.dependencies.length > 0) {
    lines.push(`Deps:      ${work.dependencies.join(", ")}`);
  }
  if (work.blockedBy.length > 0) {
    lines.push(`Blocked:   ${work.blockedBy.join(", ")}`);
  }

  if (work.enrichmentRoles.length > 0) {
    lines.push(`Enrichment:`);
    for (const e of work.enrichmentRoles) {
      lines.push(`  ${e.role}: ${e.status}${e.contributedAt ? ` (${e.contributedAt})` : ""}`);
    }
  }

  if (work.reviewers.length > 0) {
    lines.push(`Reviewers:`);
    for (const r of work.reviewers) {
      lines.push(`  ${r.agentId}: ${r.status}${r.reviewedAt ? ` (${r.reviewedAt})` : ""}`);
    }
  }

  lines.push(`Created:   ${work.createdAt}`);
  lines.push(`Updated:   ${work.updatedAt}`);
  if (work.completedAt) lines.push(`Completed: ${work.completedAt}`);

  if (work.content) {
    lines.push("", work.content);
  }

  return lines.join("\n");
}

// ─── Search results ──────────────────────────────────────────────────────────

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";

  const lines: string[] = [];
  for (const r of results) {
    lines.push(`[${r.type}] ${r.id}  ${r.title}  (score: ${r.score.toFixed(3)})`);
    if (r.snippet) {
      lines.push(`  ${r.snippet}`);
    }
  }
  return lines.join("\n");
}

// ─── Table ───────────────────────────────────────────────────────────────────

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    const colValues = rows.map((r) => (r[i] ?? "").length);
    return Math.max(h.length, ...colValues);
  });

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const sep = widths.map((w) => "-".repeat(w)).join("  ");

  const lines: string[] = [
    headers.map((h, i) => pad(h, widths[i]!)).join("  "),
    sep,
    ...rows.map((row) => row.map((cell, i) => pad(cell ?? "", widths[i]!)).join("  ")),
  ];

  return lines.join("\n");
}
