import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PhraseAntiExampleFinding, TokenDriftFinding } from "../lint.js";
import type { AntiExamplePhrase, AntiExampleToken } from "../policy-loader.js";
import { extractLineForIndex } from "./shared.js";

// ─── Anti-example matchers ────────────────────────────────────────────────
// Phrase anti-examples + token drift share the matchers, forward guards,
// and Levenshtein helpers below. Bodies are moved verbatim from the
// original src/work/lint.ts.

/**
 * Per-token state compiled once per scan. `canonical` is the set of
 * known-good tokens found in the canonical-source files (by running the
 * same `pattern` against them) — prose matches outside this set are drift.
 * `ready` is false when resolution is skipped (no `repoRoot` supplied, or
 * the pattern failed to compile); the scanner emits no findings for a
 * non-ready token rule.
 */
export interface TokenContext {
  readonly rule: AntiExampleToken;
  readonly regex: RegExp;
  readonly canonical: ReadonlySet<string>;
  readonly ready: boolean;
}

/**
 * Any of these markers on a line excludes it from the phrase-anti-example
 * matcher so a registry article (which must quote the wrong form verbatim)
 * does not self-flag. Case-insensitive; whole-substring match on the line.
 */
const FORWARD_GUARD_MARKERS = [
  "do not",
  "anti-example",
  "anti example",
  "stale",
  "<!-- anti-example -->",
];

function lineHasForwardGuard(line: string): boolean {
  const lower = line.toLowerCase();
  return FORWARD_GUARD_MARKERS.some((m) => lower.includes(m));
}

export function scanPhraseAntiExamples(
  body: string,
  file: string,
  phrases: readonly AntiExamplePhrase[],
): readonly PhraseAntiExampleFinding[] {
  if (phrases.length === 0) return [];

  const findings: PhraseAntiExampleFinding[] = [];
  // Strip fenced blocks at the body level (they span multiple lines, so
  // a line-only strip cannot reach them) but leave HTML comments and
  // inline code in place — the per-line pass below runs forward-guard
  // on the original line so markers like `<!-- anti-example -->` keep
  // working as intended.
  const bodyWithoutFences = stripFencedBlocks(body);
  const lines = bodyWithoutFences.split("\n");

  for (const line of lines) {
    // Forward-guard check runs on the ORIGINAL line so markers like
    // `<!-- anti-example -->` stay visible. The match itself then runs
    // on a line stripped of inline code so a registry article quoting
    // the wrong form in backticks (markdown table cells) does not
    // self-flag.
    if (lineHasForwardGuard(line)) continue;
    const stripped = stripInlineCode(line);
    const stripLower = stripped.toLowerCase();

    for (const phrase of phrases) {
      const needle = phrase.phrase.toLowerCase();
      if (!stripLower.includes(needle)) continue;

      findings.push({
        file,
        severity: "error",
        rule: "phrase_anti_example",
        phrase: phrase.phrase,
        corrected: phrase.corrected,
        lineHint: line.trim(),
        ...(phrase.sinceCommit ? { sinceCommit: phrase.sinceCommit } : {}),
      });
    }
  }

  return findings;
}

/**
 * Remove inline backtick-delimited code and HTML comments from a single
 * line so phrases quoted as literals (e.g. in a markdown table) do not
 * trigger the phrase matcher. Fenced blocks are handled separately at
 * the body level by `stripFencedBlocks`.
 */
function stripInlineCode(line: string): string {
  let out = line.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/(`{1,3})(?:(?!\1).)+?\1/g, "");
  return out;
}

/** Remove fenced code blocks only; preserves other text verbatim. */
function stripFencedBlocks(content: string): string {
  return content.replace(
    /^([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[ \t]*$/gm,
    "",
  );
}

export function scanTokenDrift(
  body: string,
  file: string,
  contexts: readonly TokenContext[],
): readonly TokenDriftFinding[] {
  if (contexts.length === 0) return [];

  const findings: TokenDriftFinding[] = [];

  for (const ctx of contexts) {
    if (!ctx.ready) continue;

    for (const match of body.matchAll(ctx.regex)) {
      const token = match[0];
      if (ctx.canonical.has(token)) continue;

      const suggestion = closestByLevenshtein(token, ctx.canonical);
      findings.push({
        file,
        severity: "error",
        rule: "token_drift",
        token,
        pattern: ctx.rule.pattern,
        canonicalSource: ctx.rule.canonicalSource,
        lineHint: extractLineForIndex(body, match.index ?? 0),
        ...(suggestion ? { suggestion } : {}),
      });
    }
  }

  return findings;
}

export async function resolveTokenContexts(
  tokens: readonly AntiExampleToken[],
  repoRoot: string | undefined,
): Promise<readonly TokenContext[]> {
  if (tokens.length === 0) return [];

  const contexts: TokenContext[] = [];
  for (const rule of tokens) {
    const compiled = safeCompile(rule.pattern);
    if (!compiled) {
      contexts.push({ rule, regex: /$./g, canonical: new Set(), ready: false });
      continue;
    }

    if (!repoRoot) {
      contexts.push({ rule, regex: compiled, canonical: new Set(), ready: false });
      continue;
    }

    const canonical = await collectCanonicalTokens(rule.canonicalSource, repoRoot, compiled);
    contexts.push({ rule, regex: compiled, canonical, ready: true });
  }
  return contexts;
}

function safeCompile(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "g");
  } catch {
    return undefined;
  }
}

/**
 * Build the canonical-name set for a token rule by running the same
 * pattern against the files matched by `sourceGlob` (relative to
 * `repoRoot`). Uses `fs.glob` (stable in Node 22+) so behaviour matches
 * the rest of the codebase that targets Node 22+.
 *
 * Any unreadable file is skipped silently — a missing canonical source
 * tree degrades to "no canonical names known", which means every prose
 * match would flag. That is usually the right signal (misconfigured
 * rule); the caller can always filter by `canonicalSource` in triage.
 */
async function collectCanonicalTokens(
  sourceGlob: string,
  repoRoot: string,
  regex: RegExp,
): Promise<ReadonlySet<string>> {
  const canonical = new Set<string>();
  const iterable = fs.glob(sourceGlob, { cwd: repoRoot });
  for await (const rel of iterable) {
    const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    const text = await fs.readFile(abs, "utf-8").catch(() => null);
    if (text === null) continue;
    for (const m of text.matchAll(regex)) {
      canonical.add(m[0]);
    }
  }
  return canonical;
}

function closestByLevenshtein(needle: string, candidates: ReadonlySet<string>): string | undefined {
  if (candidates.size === 0) return undefined;

  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const d = levenshtein(needle, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }

  // Only suggest when the edit distance is within roughly half the
  // needle's length; beyond that the "suggestion" is more distracting
  // than helpful.
  if (best !== undefined && bestDist <= Math.max(2, Math.floor(needle.length / 2))) {
    return best;
  }
  return undefined;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0;
  }

  return prev[b.length] ?? 0;
}
