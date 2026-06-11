import * as path from "node:path";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { NotFoundError } from "../core/errors.js";
import type { KnowledgeArticle } from "../knowledge/repository.js";
import type { WorkArticle } from "../work/repository.js";
import { normalizeCodeRefPath } from "../core/code-refs.js";
import { extractStatedCanonicalValues, normaliseCanonicalNumber } from "../work/guards.js";
import type { CanonicalValue } from "../work/policy-loader.js";
import { normalizeTag } from "../knowledge/tags.js";
import { stripCodeRegions } from "./wikilink.js";
import type { CitationValueFinding, ContradictionFinding, OrphanCitation } from "./service.js";

// ─── Citation analyzer ─────────────────────────────────────────────────────
// Orphan-citation collection, cited-value verification, and deterministic
// cross-article contradiction detection. Repository (and graph) fetches stay
// in `StructureService`, which delegates here with explicit article arrays.
// Bodies are moved verbatim from the original src/structure/service.ts.

/**
 * Map every unresolved-reference gap entry (`"<sourceId>:<missingRef>"`,
 * as produced by `getGraph`) to an `OrphanCitation`, attaching the
 * markdown-root-relative source path of the citing article. Sorted by
 * source path, then missing ref id.
 */
export function collectOrphanCitations(
  missingReferences: readonly string[],
  knowledgeArticles: readonly KnowledgeArticle[],
  workArticles: readonly WorkArticle[],
): readonly OrphanCitation[] {
  const sourcePaths = new Map<string, string>();
  for (const a of knowledgeArticles) {
    // Prefer the repository-provided real path: externally authored files
    // are often ID-named, so the slug-derived path would not exist on disk.
    sourcePaths.set(a.id, a.filePath ?? path.join("notes", `${a.slug}.md`));
  }
  for (const a of workArticles) {
    sourcePaths.set(a.id, path.join("work-articles", `${a.id}.md`));
  }

  const orphans: OrphanCitation[] = [];
  for (const entry of missingReferences) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx === -1) continue;
    const sourceArticleId = entry.slice(0, colonIdx);
    const missingRefId = entry.slice(colonIdx + 1);
    const sourcePath = sourcePaths.get(sourceArticleId);
    orphans.push({
      sourceArticleId,
      missingRefId,
      ...(sourcePath ? { sourcePath } : {}),
    });
  }

  orphans.sort((a, b) => {
    const byPath = (a.sourcePath ?? "").localeCompare(b.sourcePath ?? "");
    return byPath !== 0 ? byPath : a.missingRefId.localeCompare(b.missingRefId);
  });

  return orphans;
}

/**
 * Verify every "citation-with-number" claim in `articleIdOrSlug` against
 * the content of the cited articles. Pure with respect to its inputs —
 * `StructureService.verifyCitedValues` supplies the article arrays.
 */
export function verifyCitedValuesInArticles(
  articleIdOrSlug: string,
  knowledgeArticles: readonly KnowledgeArticle[],
  workArticles: readonly WorkArticle[],
): Result<readonly CitationValueFinding[], NotFoundError> {
  const source = resolveArticle(articleIdOrSlug, knowledgeArticles, workArticles);
  if (!source) return err(new NotFoundError("Article", articleIdOrSlug));

  const knowledgeById = new Map<string, string>(
    knowledgeArticles.map((a) => [a.id, a.content]),
  );
  const knowledgeBySlug = new Map<string, string>(
    knowledgeArticles.map((a) => [a.slug, a.content]),
  );
  const workById = new Map<string, string>(
    workArticles.map((a) => [a.id, a.content]),
  );

  const resolveTargetContent = (ref: string): string | undefined =>
    knowledgeById.get(ref) ?? knowledgeBySlug.get(ref) ?? workById.get(ref);

  const pairs = extractCitationValuePairs(source.content);
  const findings: CitationValueFinding[] = [];

  for (const pair of pairs) {
    if (pair.citationId === source.id) continue;

    const targetContent = resolveTargetContent(pair.citationId);
    // Unknown citation targets are the domain of `getOrphanCitations`,
    // not of value verification.
    if (targetContent === undefined) continue;

    if (contentContainsValue(targetContent, pair.claimedValue)) continue;

    findings.push({
      sourceArticle: source.id,
      citedArticle: pair.citationId,
      claimedValue: pair.claimedValue,
      foundValues: extractNumericTokens(targetContent, 10),
      lineHint: pair.lineHint,
    });
  }

  return ok(findings);
}

// ─── Helpers for verifyCitedValues ────────────────────────────────────────

interface ResolvedArticleLike {
  readonly id: string;
  readonly content: string;
}

function resolveArticle(
  idOrSlug: string,
  knowledge: ReadonlyArray<{ id: string; slug: string; content: string }>,
  work: ReadonlyArray<{ id: string; content: string }>,
): ResolvedArticleLike | undefined {
  const byId = knowledge.find((a) => a.id === idOrSlug) ?? work.find((a) => a.id === idOrSlug);
  if (byId) return { id: byId.id, content: byId.content };
  const bySlug = knowledge.find((a) => a.slug === idOrSlug);
  if (bySlug) return { id: bySlug.id, content: bySlug.content };
  return undefined;
}

/** Citation-value window: how far after a citation token we look for a number. */
const CITATION_VALUE_WINDOW = 80;

/** A numeric token with optional `$`, thousands separator, decimal, and `%`. */
const NUMERIC_TOKEN = /-?\$?\d[\d,]*(?:\.\d+)?%?/g;

interface CitationValuePair {
  readonly citationId: string;
  readonly claimedValue: string;
  readonly lineHint: string;
}

/**
 * Extract every `(citation, nearby-number)` pair in an article's prose.
 * A citation is either an inline `k-*` / `w-*` id or a `[[slug]]`
 * wikilink. Code regions are stripped first so example citations inside
 * fenced blocks do not produce false pairs.
 *
 * Multiple numbers after a single citation each yield a separate pair
 * — when the author wrote "see k-foo: 22.4% ($923 floor)", the verifier
 * checks both numbers against the cited article.
 */
function extractCitationValuePairs(content: string): readonly CitationValuePair[] {
  const stripped = stripCodeRegions(content);
  const citationPattern = /(\b[kw]-[a-z0-9]+(?:-[a-z0-9]+)*\b|\[\[([^\]]+)\]\])/g;
  const pairs: CitationValuePair[] = [];

  for (const match of stripped.matchAll(citationPattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const windowText = stripped.slice(end, end + CITATION_VALUE_WINDOW);
    const citationId = match[2] !== undefined ? parseWikilinkSlug(match[2]) : match[0];
    if (!citationId) continue;

    for (const numMatch of windowText.matchAll(NUMERIC_TOKEN)) {
      pairs.push({
        citationId,
        claimedValue: numMatch[0],
        lineHint: extractLineAt(stripped, start),
      });
    }
  }

  return pairs;
}

function parseWikilinkSlug(inner: string): string | undefined {
  const trimmed = inner.trim();
  const pipe = trimmed.indexOf("|");
  const slugPart = pipe >= 0 ? trimmed.slice(0, pipe) : trimmed;
  const hash = slugPart.indexOf("#");
  const slug = hash >= 0 ? slugPart.slice(0, hash).trim() : slugPart.trim();
  return slug.length > 0 ? slug : undefined;
}

function contentContainsValue(content: string, claimed: string): boolean {
  const normClaimed = normaliseNumericToken(claimed);
  if (normClaimed === "") return false;
  for (const match of content.matchAll(NUMERIC_TOKEN)) {
    if (normaliseNumericToken(match[0]) === normClaimed) return true;
  }
  return false;
}

function normaliseNumericToken(raw: string): string {
  return raw.replace(/[$,\s%]/g, "").trim();
}

function extractNumericTokens(content: string, limit: number): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of content.matchAll(NUMERIC_TOKEN)) {
    const tok = match[0];
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= limit) break;
  }
  return out;
}

function extractLineAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
}

/**
 * Compare what graph-adjacent articles state for each canonical name and
 * collect one `ContradictionFinding` per disagreeing pair. Pure with
 * respect to its inputs — `StructureService.detectContradictions` supplies
 * the article arrays (and keeps the empty-registry early return, so an
 * empty `canonicalValues` never reaches the repositories).
 */
export function detectContradictionsInArticles(
  canonicalValues: readonly CanonicalValue[],
  knowledgeArticles: readonly KnowledgeArticle[],
  workArticles: readonly WorkArticle[],
  opts?: { articleId?: string },
): readonly ContradictionFinding[] {
  const entries: ContradictionArticle[] = [
    ...knowledgeArticles.map((a) => ({
      id: a.id as string,
      slug: a.slug as string,
      content: a.content,
      tags: new Set(a.tags.map(normalizeTag)),
      codeRefs: new Set(a.codeRefs.map(normalizeCodeRefPath)),
    })),
    ...workArticles.map((a) => ({
      id: a.id as string,
      slug: undefined,
      content: a.content,
      tags: new Set(a.tags.map(normalizeTag)),
      codeRefs: new Set(a.codeRefs.map(normalizeCodeRefPath)),
    })),
  ];

  // name -> normalizedValue -> articles stating that value for that name
  const byName = new Map<string, Map<string, StatedRef[]>>();
  for (const entry of entries) {
    const seen = new Set<string>(); // dedupe (name|normalized) within one article
    for (const stated of extractStatedCanonicalValues(entry, canonicalValues)) {
      const normalized = normaliseCanonicalNumber(stated.found);
      const dedupeKey = `${stated.name}|${normalized}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const valueGroups = byName.get(stated.name) ?? new Map<string, StatedRef[]>();
      const group = valueGroups.get(normalized) ?? [];
      group.push({ entry, raw: stated.found, lineHint: stated.lineHint });
      valueGroups.set(normalized, group);
      byName.set(stated.name, valueGroups);
    }
  }

  const findings: ContradictionFinding[] = [];
  const emittedPairs = new Set<string>(); // dedupe unordered (idA|idB|name)

  for (const [name, valueGroups] of byName) {
    const normalizedValues = [...valueGroups.keys()];
    if (normalizedValues.length < 2) continue; // every article agrees on this name

    for (let i = 0; i < normalizedValues.length; i++) {
      for (let j = i + 1; j < normalizedValues.length; j++) {
        const groupA = valueGroups.get(normalizedValues[i]!) ?? [];
        const groupB = valueGroups.get(normalizedValues[j]!) ?? [];
        for (const left of groupA) {
          for (const right of groupB) {
            if (left.entry.id === right.entry.id) continue;

            const adjacency = articleAdjacency(left.entry, right.entry);
            if (!adjacency) continue;

            const leftFirst = left.entry.id < right.entry.id;
            const a = leftFirst ? left : right;
            const b = leftFirst ? right : left;

            const pairKey = `${a.entry.id}|${b.entry.id}|${name}`;
            if (emittedPairs.has(pairKey)) continue;
            emittedPairs.add(pairKey);

            findings.push({
              articleA: a.entry.id,
              articleB: b.entry.id,
              name,
              valueA: a.raw,
              valueB: b.raw,
              sharedVia: adjacency.via,
              sharedKey: adjacency.key,
              lineHintA: a.lineHint,
              lineHintB: b.lineHint,
            });
          }
        }
      }
    }
  }

  if (opts?.articleId) {
    const resolvedId =
      entries.find((e) => e.id === opts.articleId || e.slug === opts.articleId)?.id ?? opts.articleId;
    return findings.filter((f) => f.articleA === resolvedId || f.articleB === resolvedId);
  }

  return findings;
}

// ─── Helpers for detectContradictions ──────────────────────────────────────

/** Normalized view of an article for cross-article contradiction comparison. */
interface ContradictionArticle {
  readonly id: string;
  readonly slug?: string;
  readonly content: string;
  readonly tags: ReadonlySet<string>;
  readonly codeRefs: ReadonlySet<string>;
}

/** One article's stated value for a canonical name, with provenance. */
interface StatedRef {
  readonly entry: ContradictionArticle;
  readonly raw: string;
  readonly lineHint: string;
}

/**
 * Whether two articles are graph-adjacent for contradiction purposes —
 * they share a normalized tag or a normalized code ref. Tags take priority
 * over code refs so the reported `sharedKey` is the most human-meaningful
 * link. Returns `undefined` when the articles are unrelated.
 */
function articleAdjacency(
  a: ContradictionArticle,
  b: ContradictionArticle,
): { via: "shared_tag" | "code_ref"; key: string } | undefined {
  for (const tag of a.tags) {
    if (tag.length > 0 && b.tags.has(tag)) return { via: "shared_tag", key: tag };
  }
  for (const ref of a.codeRefs) {
    if (ref.length > 0 && b.codeRefs.has(ref)) return { via: "code_ref", key: ref };
  }
  return undefined;
}
