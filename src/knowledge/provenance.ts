/**
 * Provenance (PR-13). Records where a knowledge article came from.
 *
 * Stored in the free-form `extraFrontmatter` bag (ADR-020) under the `origin`
 * key, so it round-trips verbatim without touching the core schema. The default
 * (`agent`) is resolved at read-time and deliberately NOT written to disk:
 * persisting it on every article would fight the T5 minimal-diff frontmatter
 * principle ("extraFrontmatter stays absent on articles that don't use it").
 * Only non-default origins are persisted — distillation writes `distilled`
 * (`src/work/service.ts`), ingestion writes `ingested` (PR-15), and humans or
 * external tools may set `human`.
 */

/** Known provenance values, in canonical order. */
export const ORIGIN_VALUES = ["agent", "human", "distilled", "ingested"] as const;

/** An article's recorded provenance. */
export type Origin = (typeof ORIGIN_VALUES)[number];

/** Named constants for producers, so call sites avoid bare string literals. */
export const ORIGIN = {
  AGENT: "agent",
  HUMAN: "human",
  DISTILLED: "distilled",
  INGESTED: "ingested",
} as const satisfies Record<string, Origin>;

/** Origin assumed when an article records no explicit provenance. */
export const DEFAULT_ORIGIN: Origin = ORIGIN.AGENT;

/** The `extraFrontmatter` key under which provenance is stored. */
export const ORIGIN_FRONTMATTER_KEY = "origin" as const;

/** Type guard: is `value` one of the known {@link Origin} enum values? */
export function isOrigin(value: unknown): value is Origin {
  return typeof value === "string" && (ORIGIN_VALUES as readonly string[]).includes(value);
}

/**
 * Resolve an article's provenance to a known {@link Origin}. Reads
 * `extraFrontmatter.origin`; a missing or unrecognized value resolves to
 * {@link DEFAULT_ORIGIN}. The raw value remains on disk (round-tripped
 * verbatim) — only this *view* is normalized, so typed consumers (doctor,
 * query, lint) never have to reason about stray strings.
 */
export function resolveOrigin(article: {
  readonly extraFrontmatter?: Readonly<Record<string, unknown>>;
}): Origin {
  const raw = article.extraFrontmatter?.[ORIGIN_FRONTMATTER_KEY];
  return isOrigin(raw) ? raw : DEFAULT_ORIGIN;
}

/** Read-only provenance distribution across a corpus (see `summarizeProvenance`). */
export interface ProvenanceSummary {
  /** Count of articles per known origin. Missing/empty provenance counts as `agent`. */
  readonly counts: Record<Origin, number>;
  /**
   * Articles whose `origin` is present but not a known value (typos, stale enum
   * values, malformed types). `count` is total occurrences; `values` is the
   * distinct, sorted set — the active-hygiene signal surfaced by `doctor`.
   */
  readonly unrecognized: { readonly count: number; readonly values: string[] };
}

/**
 * Summarize provenance across a corpus for read-only reporting. Missing or empty
 * (`null`/`undefined`) provenance counts toward {@link DEFAULT_ORIGIN}; a present
 * value that is not a known {@link Origin} is bucketed as `unrecognized` so typos
 * stay visible instead of silently inflating the `agent` count.
 */
export function summarizeProvenance(
  articles: Iterable<{ readonly extraFrontmatter?: Readonly<Record<string, unknown>> }>,
): ProvenanceSummary {
  const counts: Record<Origin, number> = { agent: 0, human: 0, distilled: 0, ingested: 0 };
  const unrecognizedValues = new Set<string>();
  let unrecognizedCount = 0;

  for (const article of articles) {
    const raw = article.extraFrontmatter?.[ORIGIN_FRONTMATTER_KEY];
    if (raw === undefined || raw === null) {
      counts[DEFAULT_ORIGIN] += 1;
    } else if (isOrigin(raw)) {
      counts[raw] += 1;
    } else {
      unrecognizedCount += 1;
      unrecognizedValues.add(String(raw));
    }
  }

  return {
    counts,
    unrecognized: { count: unrecognizedCount, values: [...unrecognizedValues].sort() },
  };
}
