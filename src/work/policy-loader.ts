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
      return this.cache;
    }

    const policies: Policy[] = [];
    for (const article of articlesResult.value) {
      const policy = this.toPolicy(article);
      if (policy) policies.push(policy);
    }
    this.cache = policies;
    return this.cache;
  }

  /** Filter policies applicable to a specific article + transition. Pure. */
  getApplicablePolicies(
    policies: readonly Policy[],
    article: WorkArticle,
    transition: PolicyTransition,
  ): readonly Policy[] {
    return policies.filter((policy) => policyApplies(policy, article, transition));
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
