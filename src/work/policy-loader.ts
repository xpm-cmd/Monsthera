import { z } from "zod/v4";
import type { Logger } from "../core/logger.js";
import { WorkPhase, VALID_PHASES, WorkTemplate } from "../core/types.js";
import type { WorkPhase as WorkPhaseType, WorkTemplate as WorkTemplateType } from "../core/types.js";
import type { WorkArticle } from "./repository.js";
import type { KnowledgeArticleRepository, KnowledgeArticle } from "../knowledge/repository.js";

/**
 * Knowledge category reserved for policy articles. `FileSystemKnowledgeArticleRepository`
 * treats all categories equally — the "policy" convention lives here, in the work
 * module, because policies exist to gate work transitions.
 */
export const POLICY_CATEGORY = "policy";

const VALID_TEMPLATES: ReadonlySet<string> = new Set<string>(Object.values(WorkTemplate));

// ─── Policy frontmatter schema ─────────────────────────────────────────────

/**
 * Raw frontmatter shape of a policy article. All fields are flat (no nested YAML)
 * because the current markdown parser does not handle indentation. The
 * `policy_` prefix prevents collisions with other category-specific extensions.
 */
const PolicyFrontmatterSchema = z.object({
  policy_applies_templates: z.array(z.string()).optional(),
  policy_phase_transition: z
    .string()
    .regex(
      /^[a-z]+->[a-z]+$/,
      "policy_phase_transition must be '<from>-><to>', e.g. 'enrichment->implementation'",
    )
    .optional(),
  policy_content_matches: z.array(z.string()).optional(),
  policy_requires_roles: z.array(z.string()).default([]),
  policy_requires_articles: z.array(z.string()).default([]),
  policy_rationale: z.string().default(""),
});

/**
 * Schema for a single canonical-value entry. Carried inside
 * `policy_canonical_values_json` as a JSON-encoded array on one or more
 * `category: policy` articles. The JSON-string detour exists because the
 * flat markdown parser (`src/knowledge/markdown.ts`) does not round-trip
 * nested YAML objects — see ADR-010.
 */
const CanonicalValueSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  unit: z.string().optional(),
  source_article: z.string().optional(),
  valid_since_commit: z.string().optional(),
  rationale: z.string().optional(),
});

const CanonicalValuesArraySchema = z.array(CanonicalValueSchema);

/**
 * Schema for a single anti-example token entry. Carried inside
 * `policy_anti_example_tokens_json` on a `category: policy` article. Same
 * JSON-string detour as canonical values — see ADR-010.
 *
 * A token rule says: "any prose occurrence of something matching `pattern`
 * must appear as a real, canonical name defined in the files matching
 * `canonicalSource`". Drift is caught by comparing the match against a set
 * built from scanning the canonical source tree.
 */
const AntiExampleTokenSchema = z.object({
  pattern: z.string().min(1),
  canonical_source: z.string().min(1),
  description: z.string().default(""),
});

const AntiExampleTokensArraySchema = z.array(AntiExampleTokenSchema);

/**
 * Schema for a single anti-example phrase entry. A phrase rule pins an
 * exact wrong-string → corrected-string mapping that bled into the corpus
 * and must never creep back. `sinceCommit` surfaces in lint findings so a
 * reader can trace when the correction was established.
 */
const AntiExamplePhraseSchema = z.object({
  phrase: z.string().min(1),
  corrected: z.string().min(1),
  since_commit: z.string().optional(),
  rationale: z.string().optional(),
});

const AntiExamplePhrasesArraySchema = z.array(AntiExamplePhraseSchema);

// ─── Domain types ─────────────────────────────────────────────────────────

export interface PolicyAppliesTo {
  /** undefined means "applies to every template". */
  readonly templates?: readonly WorkTemplateType[];
  /** undefined means "applies to every transition the guard set evaluates". */
  readonly phaseTransition?: { readonly from: WorkPhaseType; readonly to: WorkPhaseType };
  /** undefined means "content is not inspected". Each entry is compiled once at load. */
  readonly contentMatches?: readonly RegExp[];
}

export interface PolicyRequirements {
  readonly enrichmentRoles: readonly string[];
  readonly referencedArticles: readonly string[];
}

export interface Policy {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly appliesTo: PolicyAppliesTo;
  readonly requires: PolicyRequirements;
  readonly rationale: string;
}

export interface PolicyTransition {
  readonly from: WorkPhaseType;
  readonly to: WorkPhaseType;
}

/** A single canonical value — a term the corpus agrees on by name. */
export interface CanonicalValue {
  readonly name: string;
  readonly value: string;
  readonly unit?: string;
  readonly sourceArticle?: string;
  readonly validSinceCommit?: string;
  readonly rationale?: string;
}

/** Frontmatter field whose JSON-string value holds a `CanonicalValue[]`. */
export const CANONICAL_VALUES_FRONTMATTER_KEY = "policy_canonical_values_json";

/**
 * A single token-drift rule. The pattern matches in prose; matches are
 * then compared against the set of canonical names extracted from the
 * files under `canonicalSourceGlob`. Anything matching `pattern` but not
 * in the canonical set surfaces as a `token_drift` finding.
 */
export interface AntiExampleToken {
  /** JavaScript regex source. Compiled with the `g` flag at scan time. */
  readonly pattern: string;
  /** Glob (relative to the repo root) of files that define the canonical names. */
  readonly canonicalSource: string;
  readonly description: string;
}

/**
 * A single phrase anti-example. Exact-match (case-insensitive) against
 * article prose; a hit surfaces as a `phrase_anti_example` finding with
 * the corrected form suggested. Lines carrying forward-guard markers
 * (see `FORWARD_GUARD_MARKERS` in `lint.ts`) are skipped so the registry
 * article itself — which must cite the wrong phrase verbatim — does not
 * self-flag.
 */
export interface AntiExamplePhrase {
  readonly phrase: string;
  readonly corrected: string;
  readonly sinceCommit?: string;
  readonly rationale?: string;
}

/** Frontmatter field whose JSON-string value holds an `AntiExampleToken[]`. */
export const ANTI_EXAMPLE_TOKENS_FRONTMATTER_KEY = "policy_anti_example_tokens_json";

/** Frontmatter field whose JSON-string value holds an `AntiExamplePhrase[]`. */
export const ANTI_EXAMPLE_PHRASES_FRONTMATTER_KEY = "policy_anti_example_phrases_json";

// ─── PolicyLoader ─────────────────────────────────────────────────────────

export interface PolicyLoaderDeps {
  readonly knowledgeRepo: KnowledgeArticleRepository;
  readonly logger: Logger;
}

/**
 * Loads and caches policy articles from the knowledge repository. Policies
 * declare which templates/transitions they apply to and what enrichment or
 * references must be present before a work article can advance. The loader
 * validates policy frontmatter lazily and silently drops malformed policies
 * so a single bad article cannot disable the orchestrator.
 */
export class PolicyLoader {
  private cache: readonly Policy[] | null = null;
  private canonicalValuesCache: readonly CanonicalValue[] | null = null;
  private antiExampleTokensCache: readonly AntiExampleToken[] | null = null;
  private antiExamplePhrasesCache: readonly AntiExamplePhrase[] | null = null;

  constructor(private readonly deps: PolicyLoaderDeps) {}

  async getAll(): Promise<readonly Policy[]> {
    if (this.cache) return this.cache;
    return this.refresh();
  }

  async refresh(): Promise<readonly Policy[]> {
    const articlesResult = await this.deps.knowledgeRepo.findByCategory(POLICY_CATEGORY);
    if (!articlesResult.ok) {
      this.deps.logger.warn("Failed to load policy articles", {
        error: articlesResult.error.message,
      });
      this.cache = [];
      this.canonicalValuesCache = [];
      this.antiExampleTokensCache = [];
      this.antiExamplePhrasesCache = [];
      return this.cache;
    }

    const policies: Policy[] = [];
    for (const article of articlesResult.value) {
      const policy = this.toPolicy(article);
      if (policy) policies.push(policy);
    }
    this.cache = policies;
    this.canonicalValuesCache = this.loadCanonicalValues(articlesResult.value);
    this.antiExampleTokensCache = this.loadAntiExampleTokens(articlesResult.value);
    this.antiExamplePhrasesCache = this.loadAntiExamplePhrases(articlesResult.value);
    return this.cache;
  }

  /**
   * Canonical-value registry — flat list aggregated across every `category:
   * policy` article that carries `policy_canonical_values_json`. A single
   * registry article is the common case; splitting across policies is allowed
   * so teams can scope values next to the prose that motivates them. First
   * definition of a given `name` wins — later duplicates are skipped with a
   * warning.
   */
  async getCanonicalValues(): Promise<readonly CanonicalValue[]> {
    if (this.canonicalValuesCache) return this.canonicalValuesCache;
    await this.refresh();
    return this.canonicalValuesCache ?? [];
  }

  /**
   * Anti-example token rules. Same aggregation shape as canonical values —
   * every policy article carrying a non-empty
   * `policy_anti_example_tokens_json` contributes entries, first-wins on
   * `pattern` collisions.
   */
  async getAntiExampleTokens(): Promise<readonly AntiExampleToken[]> {
    if (this.antiExampleTokensCache) return this.antiExampleTokensCache;
    await this.refresh();
    return this.antiExampleTokensCache ?? [];
  }

  /**
   * Anti-example phrases. Aggregation shape matches `getCanonicalValues` —
   * `first-wins` on exact-phrase collisions, malformed JSON logs a warning
   * and is skipped without breaking the registry.
   */
  async getAntiExamplePhrases(): Promise<readonly AntiExamplePhrase[]> {
    if (this.antiExamplePhrasesCache) return this.antiExamplePhrasesCache;
    await this.refresh();
    return this.antiExamplePhrasesCache ?? [];
  }

  /** Filter policies applicable to a specific article + transition. Pure. */
  getApplicablePolicies(
    policies: readonly Policy[],
    article: WorkArticle,
    transition: PolicyTransition,
  ): readonly Policy[] {
    return policies.filter((policy) => policyApplies(policy, article, transition));
  }

  /**
   * Aggregate canonical values from every policy article that carries a
   * non-empty `policy_canonical_values_json` field. Malformed JSON or schema
   * violations are logged and skipped — one bad article cannot disable the
   * registry. Name collisions across articles resolve "first wins" with a
   * warning, since the authored order is deterministic per-article-id.
   */
  private loadCanonicalValues(
    articles: readonly KnowledgeArticle[],
  ): readonly CanonicalValue[] {
    const byName = new Map<string, CanonicalValue>();

    for (const article of articles) {
      const raw = article.extraFrontmatter?.[CANONICAL_VALUES_FRONTMATTER_KEY];
      if (raw === undefined || raw === "") continue;
      if (typeof raw !== "string") {
        this.deps.logger.warn("Canonical-values field is not a string; skipping", {
          slug: article.slug,
        });
        continue;
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (e) {
        this.deps.logger.warn("Malformed canonical-values JSON; skipping article", {
          slug: article.slug,
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      const parsed = CanonicalValuesArraySchema.safeParse(decoded);
      if (!parsed.success) {
        this.deps.logger.warn("Canonical-values schema violation; skipping article", {
          slug: article.slug,
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
        continue;
      }

      for (const entry of parsed.data) {
        if (byName.has(entry.name)) {
          this.deps.logger.warn("Duplicate canonical value; keeping first definition", {
            name: entry.name,
            conflictingSlug: article.slug,
          });
          continue;
        }
        byName.set(entry.name, {
          name: entry.name,
          value: entry.value,
          ...(entry.unit !== undefined ? { unit: entry.unit } : {}),
          ...(entry.source_article !== undefined ? { sourceArticle: entry.source_article } : {}),
          ...(entry.valid_since_commit !== undefined ? { validSinceCommit: entry.valid_since_commit } : {}),
          ...(entry.rationale !== undefined ? { rationale: entry.rationale } : {}),
        });
      }
    }

    return [...byName.values()];
  }

  /**
   * Aggregate anti-example token rules across every policy article that
   * carries `policy_anti_example_tokens_json`. Same failure model as
   * `loadCanonicalValues`: malformed JSON → log-and-skip the article;
   * duplicate patterns → log-and-keep-first.
   */
  private loadAntiExampleTokens(
    articles: readonly KnowledgeArticle[],
  ): readonly AntiExampleToken[] {
    const byPattern = new Map<string, AntiExampleToken>();

    for (const article of articles) {
      const parsed = readJsonFrontmatterArray(
        article,
        ANTI_EXAMPLE_TOKENS_FRONTMATTER_KEY,
        AntiExampleTokensArraySchema,
        this.deps.logger,
      );
      if (!parsed) continue;

      for (const entry of parsed) {
        if (byPattern.has(entry.pattern)) {
          this.deps.logger.warn("Duplicate anti-example token; keeping first definition", {
            pattern: entry.pattern,
            conflictingSlug: article.slug,
          });
          continue;
        }
        byPattern.set(entry.pattern, {
          pattern: entry.pattern,
          canonicalSource: entry.canonical_source,
          description: entry.description,
        });
      }
    }

    return [...byPattern.values()];
  }

  /**
   * Aggregate anti-example phrase rules. Collisions on the exact phrase
   * resolve first-wins; there is no normalisation (trailing whitespace,
   * quotes, unicode dashes are all distinct phrases).
   */
  private loadAntiExamplePhrases(
    articles: readonly KnowledgeArticle[],
  ): readonly AntiExamplePhrase[] {
    const byPhrase = new Map<string, AntiExamplePhrase>();

    for (const article of articles) {
      const parsed = readJsonFrontmatterArray(
        article,
        ANTI_EXAMPLE_PHRASES_FRONTMATTER_KEY,
        AntiExamplePhrasesArraySchema,
        this.deps.logger,
      );
      if (!parsed) continue;

      for (const entry of parsed) {
        if (byPhrase.has(entry.phrase)) {
          this.deps.logger.warn("Duplicate anti-example phrase; keeping first definition", {
            phrase: entry.phrase,
            conflictingSlug: article.slug,
          });
          continue;
        }
        byPhrase.set(entry.phrase, {
          phrase: entry.phrase,
          corrected: entry.corrected,
          ...(entry.since_commit !== undefined ? { sinceCommit: entry.since_commit } : {}),
          ...(entry.rationale !== undefined ? { rationale: entry.rationale } : {}),
        });
      }
    }

    return [...byPhrase.values()];
  }

  private toPolicy(article: KnowledgeArticle): Policy | null {
    const parsed = PolicyFrontmatterSchema.safeParse(article.extraFrontmatter ?? {});
    if (!parsed.success) {
      this.deps.logger.warn("Skipping malformed policy article", {
        slug: article.slug,
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return null;
    }

    const raw = parsed.data;
    const appliesTo: PolicyAppliesTo = {
      ...(raw.policy_applies_templates
        ? { templates: compileTemplates(raw.policy_applies_templates) }
        : {}),
      ...(raw.policy_phase_transition
        ? { phaseTransition: compileTransition(raw.policy_phase_transition) }
        : {}),
      ...(raw.policy_content_matches
        ? { contentMatches: compileRegexes(raw.policy_content_matches) }
        : {}),
    };

    return {
      id: article.id,
      slug: article.slug,
      title: article.title,
      appliesTo,
      requires: {
        enrichmentRoles: [...raw.policy_requires_roles],
        referencedArticles: [...raw.policy_requires_articles],
      },
      rationale: raw.policy_rationale,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse a JSON-encoded array field from an article's extra frontmatter.
 * Returns `null` when the field is absent, empty, non-string, malformed
 * JSON, or schema-invalid. Every failure mode logs a warning — the caller
 * treats `null` as "skip this article, do not reject the whole registry".
 *
 * Factored out because canonical-values, anti-example tokens, and
 * anti-example phrases all follow the exact same JSON-string-in-flat-YAML
 * detour (see ADR-010). Keeping one helper means one place to evolve when
 * the markdown parser gains native YAML-object support.
 */
function readJsonFrontmatterArray<T>(
  article: KnowledgeArticle,
  key: string,
  schema: z.ZodType<T[]>,
  logger: Logger,
): readonly T[] | null {
  const raw = article.extraFrontmatter?.[key];
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string") {
    logger.warn("Policy JSON field is not a string; skipping", { slug: article.slug, key });
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (e) {
    logger.warn("Malformed policy JSON; skipping article", {
      slug: article.slug,
      key,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    logger.warn("Policy JSON schema violation; skipping article", {
      slug: article.slug,
      key,
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return null;
  }
  return parsed.data;
}

function compileTemplates(values: readonly string[]): readonly WorkTemplateType[] {
  return values.filter((v): v is WorkTemplateType => VALID_TEMPLATES.has(v));
}

function compileTransition(raw: string): { from: WorkPhaseType; to: WorkPhaseType } | undefined {
  const [from, to] = raw.split("->") as [string, string];
  if (!VALID_PHASES.has(from) || !VALID_PHASES.has(to)) return undefined;
  return { from: from as WorkPhaseType, to: to as WorkPhaseType };
}

/**
 * Compile a list of patterns into RegExp instances. Handles two quirks of the
 * flat YAML parser used for frontmatter:
 *
 * 1. List items (`- "..."`) retain their surrounding quotes — stripped here.
 * 2. `(?i)` prefix (POSIX/ripgrep style) is accepted and translated to the JS
 *    `i` flag, so authors can paste patterns copied from grep / rg docs.
 *
 * Patterns that fail to compile are dropped silently — the policy still loads,
 * but the failed pattern simply never matches. A policy whose *every* pattern
 * fails will match nothing (not everything), which is the safe default.
 */
function compileRegexes(patterns: readonly string[]): readonly RegExp[] {
  const compiled: RegExp[] = [];
  for (const raw of patterns) {
    const stripped = stripWrappingQuotes(raw);
    try {
      if (stripped.startsWith("(?i)")) {
        compiled.push(new RegExp(stripped.slice(4), "i"));
      } else {
        compiled.push(new RegExp(stripped));
      }
    } catch {
      // pattern dropped; see jsdoc above
    }
  }
  return compiled;
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function policyApplies(
  policy: Policy,
  article: WorkArticle,
  transition: PolicyTransition,
): boolean {
  const { appliesTo } = policy;

  if (appliesTo.templates && !appliesTo.templates.includes(article.template)) return false;

  if (appliesTo.phaseTransition) {
    if (
      appliesTo.phaseTransition.from !== transition.from ||
      appliesTo.phaseTransition.to !== transition.to
    ) {
      return false;
    }
  }

  // undefined ⇒ policy does not inspect content; present (even empty) ⇒ at least
  // one pattern must match. An empty list after compilation (every pattern was
  // invalid) therefore means "no match" — the safe default.
  if (appliesTo.contentMatches) {
    const hit = appliesTo.contentMatches.some((regex) => regex.test(article.content));
    if (!hit) return false;
  }

  return true;
}

// Re-export for callers that only want the constant without the class.
export { WorkPhase };
