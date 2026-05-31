import type { ContextPackItem } from "./service.js";
import type { ThinkCitation, KnowledgeGap, ThinkLlmOutput } from "./think-schemas.js";
import { extractStatedCanonicalValues, normaliseCanonicalNumber } from "../work/guards.js";
import type { CanonicalValue } from "../work/policy-loader.js";

/** Inline citation marker, e.g. `[3]`. */
const MARKER_RE = /\[(\d+)\]/g;

/** Cap per-source body length in the prompt to keep the context bounded. */
const MAX_SOURCE_CHARS = 1200;

export const DEGRADED_ANSWER =
  "Synthesis unavailable (no LLM configured or reachable). The ranked sources are in `contextPack`; read them directly.";

export const EMPTY_ANSWER = "No sources matched this query — the knowledge base may not cover it yet.";

/**
 * Build the JSON-mode synthesis prompt. Sources are numbered `[1..N]`; the
 * grounding rules (cite only existing markers, prefer fewer real citations)
 * mirror the session summarizer's prompt. `contents[i]` is the full body of
 * `items[i]` (falls back to the item snippet).
 */
export function buildThinkPrompt(
  query: string,
  items: readonly ContextPackItem[],
  contents: readonly string[],
): string {
  const sources = items
    .map((it, i) => {
      const body = (contents[i] ?? it.snippet).slice(0, MAX_SOURCE_CHARS);
      const meta = it.type === "work" && it.phase ? ` [phase: ${it.phase}]` : "";
      return `[${i + 1}] (${it.type}) "${it.title}"${meta}\n${body}`;
    })
    .join("\n\n");

  return [
    "You synthesize ONE well-cited answer to the QUERY using ONLY the numbered SOURCES.",
    "",
    "Rules:",
    "1. Output ONLY valid JSON matching the schema. No prose outside the JSON object.",
    "2. Cite with [n] markers that EXIST in SOURCES. Invented markers are pruned automatically.",
    "   Prefer fewer real citations over many fabricated ones. End non-trivial claims with their [n].",
    '3. If the SOURCES do not answer part of the QUERY, add a gap {kind:"missing"}.',
    '   If two sources conflict, add {kind:"contradictory", sourceMarkers:["[i]","[j]"]}.',
    "4. Keep `answer` to 1-3 tight paragraphs.",
    "",
    'Schema (JSON): { "answer": string, "gaps": [{ "kind": "stale"|"uncited"|"contradictory"|"missing", "detail": string, "sourceMarkers": string[] }] }',
    "",
    "SOURCES:",
    sources,
    "",
    `QUERY: ${query}`,
    "",
    "Output the JSON now.",
  ].join("\n");
}

/**
 * Map every `[n]` marker in the answer to a real article id. Out-of-range
 * markers are stripped from the prose (so no dangling citation shows) and never
 * become citations — this is the trust mechanism, mirroring the session
 * summarizer's citation pruning: the model can only ever cite real sources.
 */
export function mapAndPruneCitations(
  answer: string,
  items: readonly ContextPackItem[],
): { answer: string; citations: ThinkCitation[]; citedIds: Set<string> } {
  const citations: ThinkCitation[] = [];
  const citedIds = new Set<string>();
  const seenMarkers = new Set<string>();

  const prunedAnswer = answer.replace(MARKER_RE, (whole, digits: string) => {
    const n = Number(digits);
    const item = n >= 1 && n <= items.length ? items[n - 1] : undefined;
    if (item === undefined) return ""; // strip invented / out-of-range marker
    const marker = `[${n}]`;
    if (!seenMarkers.has(marker)) {
      seenMarkers.add(marker);
      citations.push({ marker, articleId: item.id, type: item.type, title: item.title, snippet: item.snippet });
    }
    citedIds.add(item.id);
    return whole;
  });

  return { answer: prunedAnswer, citations, citedIds };
}

/**
 * Stale + uncited gaps computed deterministically from pack diagnostics —
 * available even when the LLM is absent. `stale` = sources not updated
 * recently or citing code that moved; `uncited` = retrieved sources the answer
 * did not lean on.
 */
export function deriveDeterministicGaps(
  items: readonly ContextPackItem[],
  citedIds: ReadonlySet<string>,
): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = [];

  const stale = items.filter((it) => it.diagnostics.freshness.state === "stale");
  if (stale.length > 0) {
    gaps.push({
      kind: "stale",
      detail: `${stale.length} source(s) are stale (not updated recently); verify before relying on them.`,
      articleIds: stale.map((it) => it.id),
    });
  }

  const staleRefs = items.filter((it) => it.staleCodeRefs.length > 0);
  if (staleRefs.length > 0) {
    gaps.push({
      kind: "stale",
      detail: `${staleRefs.length} source(s) cite code paths that no longer exist on disk.`,
      articleIds: staleRefs.map((it) => it.id),
    });
  }

  const uncited = items.filter((it) => !citedIds.has(it.id));
  if (uncited.length > 0 && citedIds.size > 0) {
    gaps.push({
      kind: "uncited",
      detail: `${uncited.length} retrieved source(s) were not used in the answer; they may add context the synthesis omitted.`,
      articleIds: uncited.map((it) => it.id),
    });
  }

  return gaps;
}

/**
 * Deterministic `contradictory` gaps among pack items: two retrieved sources
 * that state different values for the same canonical name. Pack items are
 * co-retrieved for one query, so they are already topically related — no
 * graph-adjacency filter is needed here (unlike corpus-wide
 * `StructureService.detectContradictions`). Reuses the same name→number
 * extraction as the `canonical_value_mismatch` lint rule. Empty registry or
 * fewer than two sources → no gaps. Pure and LLM-free, which is what lets
 * `think` populate `contradictory` even in the degraded path.
 */
export function deriveContradictionGaps(
  items: readonly ContextPackItem[],
  contents: readonly string[],
  canonicalValues: readonly CanonicalValue[],
): KnowledgeGap[] {
  if (canonicalValues.length === 0 || items.length < 2) return [];

  // name -> normalizedValue -> { ids stating it, a representative raw token }
  const byName = new Map<string, Map<string, { ids: Set<string>; raw: string }>>();
  items.forEach((item, idx) => {
    const content = contents[idx] ?? item.snippet;
    const seen = new Set<string>(); // dedupe (name|normalized) within one source
    for (const stated of extractStatedCanonicalValues({ content }, canonicalValues)) {
      const normalized = normaliseCanonicalNumber(stated.found);
      const dedupeKey = `${stated.name}|${normalized}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const groups = byName.get(stated.name) ?? new Map<string, { ids: Set<string>; raw: string }>();
      const group = groups.get(normalized) ?? { ids: new Set<string>(), raw: stated.found };
      group.ids.add(item.id);
      groups.set(normalized, group);
      byName.set(stated.name, groups);
    }
  });

  const gaps: KnowledgeGap[] = [];
  for (const [name, groups] of byName) {
    if (groups.size < 2) continue; // all sources agree on this name
    const articleIds = [...new Set([...groups.values()].flatMap((g) => [...g.ids]))];
    if (articleIds.length < 2) continue; // a single source stating two values is not cross-source
    const rawValues = [...groups.values()].map((g) => g.raw);
    gaps.push({
      kind: "contradictory",
      detail: `Retrieved sources disagree on "${name}": ${rawValues.join(" vs ")}. Reconcile before relying on either figure.`,
      articleIds,
    });
  }
  return gaps;
}

/**
 * Map LLM-emitted gaps' `sourceMarkers` (`["[1]","[3]"]`) to article ids.
 * Only `missing` / `contradictory` kinds are taken from the model — `stale` /
 * `uncited` are computed deterministically (see deriveDeterministicGaps).
 */
export function mapLlmGaps(llmGaps: ThinkLlmOutput["gaps"], items: readonly ContextPackItem[]): KnowledgeGap[] {
  return llmGaps
    .filter((g) => g.kind === "missing" || g.kind === "contradictory")
    .map((g) => {
      const ids: string[] = [];
      for (const marker of g.sourceMarkers) {
        const n = Number(marker.replace(/[^\d]/g, ""));
        const item = n >= 1 && n <= items.length ? items[n - 1] : undefined;
        if (item !== undefined) ids.push(item.id);
      }
      return { kind: g.kind, detail: g.detail, articleIds: ids };
    });
}
