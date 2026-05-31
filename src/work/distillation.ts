import { WorkTemplate } from "../core/types.js";
import type { WorkArticle } from "./repository.js";

/**
 * Work→knowledge distillation (PR-6). Pure helpers that turn a completed work
 * article into a durable `solution`/`decision` knowledge article. Deterministic
 * by design — runs inline on the `done` transition with no LLM (the advance is
 * interactive; richer LLM synthesis belongs in a later async enrichment step).
 */

/** Deterministic slug for the distilled article — the basis for idempotency. */
export function distilledSlug(workId: string): string {
  return `distilled-${workId}`;
}

/**
 * Pick the knowledge category. Verdict-bearing or spike work reads as a
 * `decision`; feature/bugfix/refactor as a `solution`.
 */
export function deriveDistilledCategory(article: WorkArticle): "solution" | "decision" {
  const last = article.phaseHistory[article.phaseHistory.length - 1];
  const verdicts = last?.metadata?.["verdicts"];
  if (Array.isArray(verdicts) && verdicts.length > 0) return "decision";
  if (article.template === WorkTemplate.SPIKE) return "decision";
  return "solution";
}

/** Title for the distilled article. */
export function buildDistilledTitle(article: WorkArticle, category: "solution" | "decision"): string {
  const label = category === "decision" ? "Decision" : "Solution";
  return `${label}: ${article.title}`;
}

/**
 * Render the distilled body deterministically from the work content plus the
 * conventional phase-history metadata (ADR-011: success_test, verdicts,
 * blockers, verify_count, fabrications).
 */
export function buildDistilledBody(article: WorkArticle): string {
  const lines: string[] = [`> Distilled from work [${article.id}] on completion. Origin: \`distilled\`.`, ""];

  if (article.content.trim().length > 0) {
    lines.push(article.content.trim(), "");
  }

  const outcome = summarizeOutcome(article);
  if (outcome.length > 0) {
    lines.push("## Outcome", ...outcome, "");
  }

  if (article.codeRefs.length > 0) {
    lines.push("## Code", ...article.codeRefs.map((ref) => `- \`${ref}\``), "");
  }

  return lines.join("\n").trimEnd() + "\n";
}

/** Pull conventional metadata off the most recent phase-history entry that carries any. */
function summarizeOutcome(article: WorkArticle): string[] {
  const entry = [...article.phaseHistory].reverse().find((e) => e.metadata && Object.keys(e.metadata).length > 0);
  const meta = entry?.metadata;
  if (!meta) return [];

  const out: string[] = [];
  const push = (label: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length > 0) out.push(`- **${label}:** ${value.join(", ")}`);
    } else {
      out.push(`- **${label}:** ${String(value)}`);
    }
  };

  push("Success test", meta["success_test"]);
  push("Verdicts", meta["verdicts"]);
  push("Blockers", meta["blockers"]);
  push("Verify count", meta["verify_count"]);
  push("Fabrications", meta["fabrications"]);
  return out;
}
