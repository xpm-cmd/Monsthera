import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { type MonstheraError, StorageError } from "../core/errors.js";
import type { TextGenerator } from "../core/text-generator.js";

/** A search candidate handed to the reranker: an id plus display/body text. */
export interface RerankCandidate {
  readonly id: string;
  readonly text: string;
}

/** A reranker's relevance score for one candidate. */
export interface RerankScore {
  readonly id: string;
  readonly score: number;
}

/**
 * Reorders search candidates by query relevance. Deliberately mirrors
 * `EmbeddingProvider`: an optional, health-gated dependency the SearchService
 * degrades around (a failure means "keep the hybrid order"), never a hard
 * requirement.
 */
export interface Reranker {
  readonly name: string;
  rerank(
    query: string,
    candidates: readonly RerankCandidate[],
  ): Promise<Result<readonly RerankScore[], MonstheraError>>;
  healthCheck(): Promise<Result<{ ready: true }, MonstheraError>>;
}

/**
 * Identity reranker — returns the neutral multiplier 1.0 for every candidate.
 * Because the stage reweights `score = hybrid * relevance`, a uniform 1.0
 * leaves every score (and therefore the final order) exactly as it was. The
 * default when reranking is disabled, and the analog of `StubEmbeddingProvider`.
 */
export class StubReranker implements Reranker {
  readonly name = "stub";

  async rerank(
    _query: string,
    candidates: readonly RerankCandidate[],
  ): Promise<Result<readonly RerankScore[], MonstheraError>> {
    return ok(candidates.map((c) => ({ id: c.id, score: 1 })));
  }

  async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
    return ok({ ready: true });
  }
}

/**
 * LLM cross-encoder reranker. Asks the `TextGenerator` to score each
 * candidate's relevance to the query in [0,1]. Any failure (LLM unreachable,
 * unparseable output) surfaces as `err`; the SearchService treats that as
 * "keep current order", so a flaky model can never break search.
 */
export class CrossEncoderReranker implements Reranker {
  readonly name = "cross-encoder";

  constructor(private readonly generator: TextGenerator) {}

  async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
    return this.generator.healthCheck();
  }

  async rerank(
    query: string,
    candidates: readonly RerankCandidate[],
  ): Promise<Result<readonly RerankScore[], MonstheraError>> {
    if (candidates.length === 0) return ok([]);
    const generated = await this.generator.generate(buildRerankPrompt(query, candidates), {
      json: true,
      temperature: 0,
    });
    if (!generated.ok) return err(generated.error);

    const parsed = parseRerankScores(generated.value, candidates);
    if (parsed === null) return err(new StorageError("Reranker output could not be parsed"));
    return ok(parsed);
  }
}

/** Per-candidate body cap so the rerank prompt stays bounded. */
const RERANK_TEXT_CAP = 400;

export function buildRerankPrompt(query: string, candidates: readonly RerankCandidate[]): string {
  const docs = candidates
    .map((c, i) => `[${i + 1}] (id=${c.id}) ${c.text.slice(0, RERANK_TEXT_CAP)}`)
    .join("\n\n");
  return [
    "Rate how well each DOCUMENT answers the QUERY, from 0.0 (irrelevant) to 1.0 (perfectly relevant).",
    `QUERY: ${query}`,
    "",
    "DOCUMENTS:",
    docs,
    "",
    'Respond with JSON only: {"scores":[{"id":"<id>","score":<0..1>}, ...]} covering every id.',
  ].join("\n");
}

/**
 * Parse the LLM's JSON into per-candidate scores. Tolerant by design: accepts
 * `{scores:[...]}` or a bare array, clamps to [0,1], ignores unknown ids, and
 * fills any candidate the model omitted with 0. Returns null only when no
 * usable JSON / no recognized score is present, which the caller maps to "keep
 * current order".
 */
export function parseRerankScores(
  raw: string,
  candidates: readonly RerankCandidate[],
): readonly RerankScore[] | null {
  const json = extractJson(raw);
  if (json === null) return null;

  const arr = Array.isArray(json)
    ? json
    : Array.isArray((json as { scores?: unknown }).scores)
      ? (json as { scores: unknown[] }).scores
      : null;
  if (arr === null) return null;

  const known = new Set(candidates.map((c) => c.id));
  const scoreById = new Map<string, number>();
  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    const score = (entry as { score?: unknown }).score;
    if (typeof id !== "string" || !known.has(id)) continue;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    scoreById.set(id, Math.max(0, Math.min(1, score)));
  }
  if (scoreById.size === 0) return null;
  return candidates.map((c) => ({ id: c.id, score: scoreById.get(c.id) ?? 0 }));
}

function extractJson(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to brace-slice recovery.
  }
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}
