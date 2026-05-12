import type { SessionFacts } from "./schemas.js";
import type { LLMSummary } from "./llm-summarizer.js";

/**
 * Validate a single citation string against the facts payload.
 *
 * Citation shapes accepted by the prompt + checked here:
 *   - `evt:<event.id>`           — must appear in `facts.events[].id`
 *   - `work:<work.id>`           — must appear in `facts.workTouched[].id`
 *   - `knowledge:<slug-or-id>`   — must match either `facts.knowledgeTouched[].id`
 *                                  or `facts.knowledgeTouched[].slug`
 *   - `commit:<sha-prefix>`      — any commit sha that starts with the prefix
 *   - `path:<file>` or `path:<file>:<line>` — path must appear in
 *                                  `facts.codeTouched[].path` OR in any of the
 *                                  `signals.*` path entries
 *
 * Any other shape (including a bare ID with no prefix) is rejected. This is
 * the grounding line: the LLM cannot invent entities; at worst it cites
 * things that get pruned. False negatives (real entities pruned because the
 * LLM cited them in an unexpected shape) are preferred to false positives
 * (fabricated citations slipping through).
 */
export function citationsInFacts(citation: string, facts: SessionFacts): boolean {
  if (!citation || typeof citation !== "string") return false;
  const colon = citation.indexOf(":");
  if (colon === -1) return false;
  const prefix = citation.slice(0, colon);
  const tail = citation.slice(colon + 1);
  if (!tail) return false;

  switch (prefix) {
    case "evt":
      return facts.events.some((e) => e.id === tail);
    case "work":
      return facts.workTouched.some((w) => w.id === tail);
    case "knowledge":
      return facts.knowledgeTouched.some((k) => k.id === tail || k.slug === tail);
    case "commit":
      return facts.commits.some((c) => c.sha.startsWith(tail) || tail.startsWith(c.sha.slice(0, 8)));
    case "path": {
      // Strip optional :line suffix for path comparison
      const filePart = tail.includes(":") ? tail.slice(0, tail.lastIndexOf(":")) : tail;
      if (facts.codeTouched.some((c) => c.path === filePart)) return true;
      if (facts.signals.todosAdded.some((t) => t.path === filePart)) return true;
      if (facts.signals.questions.some((q) => q.path === filePart)) return true;
      return false;
    }
    default:
      return false;
  }
}

/**
 * Prune unresolved citations from an `LLMSummary`. Returns a new summary
 * with every `evidence: string[]` filtered to citations that exist in
 * `facts`. Free-text fields (`tldr`, `summary`, `surprises`, `deferred`,
 * `openQuestions`, `suggestedAgent`) pass through untouched — the LLM is
 * allowed prose in those, just not phantom evidence.
 */
export function pruneSummaryCitations(
  summary: LLMSummary,
  facts: SessionFacts,
): { summary: LLMSummary; prunedCount: number } {
  let prunedCount = 0;

  const filterEvidence = (evidence: readonly string[]): string[] => {
    const kept: string[] = [];
    for (const cite of evidence) {
      if (citationsInFacts(cite, facts)) {
        kept.push(cite);
      } else {
        prunedCount++;
      }
    }
    return kept;
  };

  const pruned: LLMSummary = {
    ...summary,
    decisions: summary.decisions.map((d) => ({ text: d.text, evidence: filterEvidence(d.evidence) })),
    blockers: summary.blockers.map((b) => ({ text: b.text, evidence: filterEvidence(b.evidence) })),
    nextSteps: summary.nextSteps.map((s) => ({
      action: s.action,
      evidence: filterEvidence(s.evidence),
      why: s.why,
    })),
  };

  return { summary: pruned, prunedCount };
}
