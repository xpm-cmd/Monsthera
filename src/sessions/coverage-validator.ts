/**
 * Handoff coverage validator.
 *
 * The LLM-side rubric (`buildSelfEvalPrompt`) measures count-based proxies
 * (decisionCount, blockerCount, nextStepCount). Those proxies correlate with
 * quality but don't directly answer the five questions a cold-start agent
 * actually has when picking up the work:
 *
 *   1. Where am I?            — state of the workstream
 *   2. Why are we here?       — intent / parent goal
 *   3. What do I do next?     — executable action (file:line or command)
 *   4. What must I not break? — constraints, blockers, deferred items
 *   5. How do I verify?       — concrete test/check command
 *
 * This module inspects the rendered handoff markdown and reports which of
 * the five dimensions are not visibly answered. The result is surfaced in a
 * `## Coverage` section appended to the article body — transparent
 * self-criticism that the next agent can read. The validator never blocks
 * persistence; it's advisory.
 */

export type CoverageDimension =
  | "state"
  | "intent"
  | "executable-action"
  | "constraints"
  | "verification";

export const COVERAGE_DIMENSIONS: readonly CoverageDimension[] = [
  "state",
  "intent",
  "executable-action",
  "constraints",
  "verification",
] as const;

export interface CoverageGap {
  readonly dimension: CoverageDimension;
  readonly question: string;
  readonly suggestion: string;
}

interface DimensionCheck {
  readonly dimension: CoverageDimension;
  readonly question: string;
  readonly suggestion: string;
  /** Returns true when the body satisfies this dimension. */
  readonly satisfied: (body: string) => boolean;
}

// ─── Heuristics ──────────────────────────────────────────────────────────────

/** True if the article has a `## Hypergraph` section with code/commit content. */
function hasState(body: string): boolean {
  // Either an explicit Hypergraph section with non-zero events/commits/code, OR a
  // commit list anywhere in the body. The state question is "where am I" — knowing
  // what changed is half the answer.
  return /## Hypergraph/i.test(body) || /\bcommit:[a-f0-9]{7,}/i.test(body);
}

/** True if the preamble has a non-empty `> Intent:` line. */
function hasIntent(body: string): boolean {
  return /^> Intent:\s+\S+/m.test(body);
}

/**
 * True if the body mentions an executable hint anywhere: a `file.ext` or
 * `file.ext:line` reference, or a backticked command. The LLM scatters
 * specificity across sections — what matters is signal-presence, not which
 * heading carries it. A handoff with no file path anywhere is genuinely thin.
 *
 * Both backticked and bare-prose forms credit. The bare-prose form requires
 * a high-specificity suffix (`:line` for file refs, a recognizable subcommand
 * for CLI verbs) to avoid crediting casual prose like "see foo.ts" or "run
 * the tests". This is defense-in-depth for the case where the LLM elides
 * backticks even when the agent's `--note` had them.
 */
function hasExecutableAction(body: string): boolean {
  // backticked file path — `src/foo.ts`, `tests/bar.ts:42`
  if (/`[a-zA-Z_][\w./-]*\.(ts|tsx|js|jsx|mjs|cjs|md|json|sql|sh|py|rb|go|rs)(:[0-9]+)?`/.test(body)) return true;
  // backticked command starting with a known CLI verb
  if (/`(pnpm|npm|monsthera|gh|git|node|tsx|vitest)\b[^`]*`/.test(body)) return true;
  // bare file:line — require explicit `:digits` suffix so "see foo.ts for context" doesn't match
  if (/\b[a-zA-Z_][\w./-]*\.(ts|tsx|js|jsx|mjs|cjs|md|json|sql|sh|py|rb|go|rs):[0-9]+\b/.test(body)) return true;
  // bare CLI invocation — require recognizable subcommand so "run the tests" doesn't match
  if (/\b(pnpm|monsthera|vitest)\s+(test|typecheck|build|doctor|run|lint|status|exec)\b/.test(body)) return true;
  return false;
}

/**
 * True if the body explicitly surfaces a constraint, blocker, deferred item,
 * or open question — either as a section heading OR as keyworded prose.
 * The LLM often dissolves "watch out for X" into narrative; that's still a
 * legitimate constraint signal worth crediting.
 */
function hasConstraints(body: string): boolean {
  if (/^#{2,3}\s+(Blockers|Deferred|Open questions|Constraints|Watch-?outs?)\b/im.test(body)) return true;
  if (/\b(blocked? by|deferred|gotcha|watch[- ]?out|regress(ed|es|ing|ion|ions|ive)?|invariant|do not break|must not)\b/i.test(body)) return true;
  return false;
}

/**
 * True if any executable verification command is named — `pnpm test`, `monsthera doctor`,
 * `pnpm typecheck`, etc. Looks across the entire body, not just one section.
 *
 * Backticked form is the high-confidence signal. Bare-prose form is the
 * defense-in-depth case: requires the verb followed by a recognizable
 * argument-shaped token so prose like "run the tests" doesn't credit.
 */
function hasVerification(body: string): boolean {
  // backticked form — high confidence
  if (/`(pnpm (test|typecheck|build|run)|monsthera (doctor|status|lint)|git (status|diff)|vitest|gh (pr|run|status))\b[^`]*`/.test(body)) return true;
  // bare with argv-shaped suffix — `pnpm test tests/foo.test.ts`, `vitest tests/foo`, etc.
  if (/\b(pnpm (test|typecheck|build|run)|monsthera (doctor|status|lint)|vitest)\s+[\w./-]+/.test(body)) return true;
  return false;
}

// ─── Dimension table ─────────────────────────────────────────────────────────

const CHECKS: readonly DimensionCheck[] = [
  {
    dimension: "state",
    question: "Where am I? (what's open, closed, just shipped)",
    suggestion: "Include a Hypergraph section with commits / code touched, or cite commit:<sha> in Decisions.",
    satisfied: hasState,
  },
  {
    dimension: "intent",
    question: "Why are we here? (the workstream goal)",
    suggestion: "Open the session with `--intent \"...\"` so the preamble carries it through.",
    satisfied: hasIntent,
  },
  {
    dimension: "executable-action",
    question: "What do I do next? (file:line or literal command)",
    suggestion: "First action should name a file:line, a backticked command, or a CLI invocation — not a generic verb.",
    satisfied: hasExecutableAction,
  },
  {
    dimension: "constraints",
    question: "What must I not break? (blockers, deferred items, invariants)",
    suggestion: "Add a Blockers or Deferred section — even an explicit `(none)` is more useful than silence.",
    satisfied: hasConstraints,
  },
  {
    dimension: "verification",
    question: "How do I verify?",
    suggestion: "Name a concrete check: `pnpm test`, `monsthera doctor`, or a manual command with expected output.",
    satisfied: hasVerification,
  },
];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Strip the structural Facts pointer section from the body before evaluation.
 * The Facts section (`## Facts (raw, for downstream LLM)`) always carries a
 * backticked `.facts.json` filename — a navigation artifact, not an
 * executable action. Including it in scope makes `hasExecutableAction`
 * credit every non-degraded handoff regardless of substantive content.
 *
 * Splitting on `## Facts` rather than the full heading text keeps the strip
 * robust to minor heading variations.
 */
function stripStructuralSections(body: string): string {
  const factsIdx = body.indexOf("## Facts");
  return factsIdx >= 0 ? body.slice(0, factsIdx) : body;
}

/**
 * Evaluate the rendered handoff body against the five-question framework.
 * Returns the list of dimensions that are not visibly answered. An empty
 * array means the body satisfies all five.
 */
export function evaluateHandoffCoverage(body: string): CoverageGap[] {
  const evaluable = stripStructuralSections(body);
  const gaps: CoverageGap[] = [];
  for (const check of CHECKS) {
    if (!check.satisfied(evaluable)) {
      gaps.push({
        dimension: check.dimension,
        question: check.question,
        suggestion: check.suggestion,
      });
    }
  }
  return gaps;
}

/**
 * Render a `## Coverage` section listing the gaps. Returns the empty string
 * when there are no gaps so callers can concatenate unconditionally.
 */
export function renderCoverageSection(gaps: readonly CoverageGap[]): string {
  if (gaps.length === 0) return "";
  const lines: string[] = [
    "## Coverage",
    "",
    "_This handoff did not visibly answer every question a cold-start agent will have. Listed below as advisory — the next agent can still proceed by reading the body, but consider filling these in next time you close. If `executable-action` or `verification` is flagged but the body mentions a file:line or test command in prose without backticks, that's the LLM dropping specificity — re-render is usually unnecessary, but tightening the `--note` template (with backticked file paths and `pnpm test ...` invocations) helps the next handoff._",
    "",
  ];
  for (const gap of gaps) {
    lines.push(`- \`${gap.dimension}\` — **${gap.question}** ${gap.suggestion}`);
  }
  return lines.join("\n");
}
