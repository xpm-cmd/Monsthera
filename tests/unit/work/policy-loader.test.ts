import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import {
  agentId,
  articleId,
  timestamp,
  workId,
  WorkPhase,
  WorkTemplate,
  Priority,
} from "../../../src/core/types.js";
import type { WorkArticle } from "../../../src/work/repository.js";
import { PolicyLoader, POLICY_CATEGORY } from "../../../src/work/policy-loader.js";
import type { Policy } from "../../../src/work/policy-loader.js";

function makeWorkArticle(overrides: Partial<WorkArticle> = {}): WorkArticle {
  return {
    id: workId("w-test0001"),
    title: "Test Work",
    template: WorkTemplate.FEATURE,
    phase: WorkPhase.ENRICHMENT,
    priority: Priority.MEDIUM,
    author: agentId("agent-1"),
    enrichmentRoles: [],
    reviewers: [],
    phaseHistory: [{ phase: WorkPhase.PLANNING, enteredAt: timestamp() }],
    tags: [],
    references: [],
    codeRefs: [],
    dependencies: [],
    blockedBy: [],
    content: "",
    createdAt: timestamp(),
    updatedAt: timestamp(),
    ...overrides,
  };
}

async function seedPolicy(
  repo: InMemoryKnowledgeArticleRepository,
  slug: string,
  extraFrontmatter: Record<string, unknown>,
  opts?: { title?: string; content?: string; references?: string[] },
): Promise<void> {
  const result = await repo.create({
    id: articleId(`k-${slug}`),
    title: opts?.title ?? `Policy: ${slug}`,
    slug: slug as never,
    category: POLICY_CATEGORY,
    content: opts?.content ?? "",
    references: opts?.references ?? [],
    extraFrontmatter,
  });
  if (!result.ok) throw new Error(`seed failed: ${result.error.message}`);
}

function makeLoader(repo: InMemoryKnowledgeArticleRepository): PolicyLoader {
  return new PolicyLoader({
    knowledgeRepo: repo,
    logger: createLogger({ level: "error", domain: "test" }),
  });
}

describe("PolicyLoader.refresh", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns empty array when no policy articles exist", async () => {
    const loader = makeLoader(repo);
    expect(await loader.refresh()).toEqual([]);
  });

  it("loads a well-formed policy", async () => {
    await seedPolicy(repo, "policy-feature-auth-security", {
      policy_applies_templates: ["feature"],
      policy_phase_transition: "enrichment->implementation",
      policy_content_matches: ["(?i)auth|oauth|session|token"],
      policy_requires_roles: ["security"],
      policy_requires_articles: [],
      policy_rationale: "Security must review auth code before implementation.",
    });

    const policies = await makeLoader(repo).refresh();
    expect(policies).toHaveLength(1);
    const policy = policies[0] as Policy;
    expect(policy.slug).toBe("policy-feature-auth-security");
    expect(policy.appliesTo.templates).toEqual(["feature"]);
    expect(policy.appliesTo.phaseTransition).toEqual({
      from: WorkPhase.ENRICHMENT,
      to: WorkPhase.IMPLEMENTATION,
    });
    expect(policy.appliesTo.contentMatches?.[0]).toBeInstanceOf(RegExp);
    expect(policy.requires.enrichmentRoles).toEqual(["security"]);
    expect(policy.rationale).toMatch(/auth/);
  });

  it("drops policies with a malformed phase_transition and surfaces the rest", async () => {
    await seedPolicy(repo, "policy-bad", { policy_phase_transition: "invalid-shape" });
    await seedPolicy(repo, "policy-good", {
      policy_phase_transition: "implementation->review",
    });
    const policies = await makeLoader(repo).refresh();
    expect(policies.map((p) => p.slug)).toEqual(["policy-good"]);
  });

  it("treats a policy with no policy_* fields as vacuous (never applies)", async () => {
    await seedPolicy(repo, "policy-vacuous", {});
    const policies = await makeLoader(repo).refresh();
    expect(policies).toHaveLength(1);
    expect(policies[0]?.requires.enrichmentRoles).toEqual([]);
  });
});

describe("PolicyLoader.getAll caching", () => {
  it("caches across calls and refresh() rebuilds the cache", async () => {
    const repo = new InMemoryKnowledgeArticleRepository();
    await seedPolicy(repo, "policy-a", {
      policy_phase_transition: "enrichment->implementation",
      policy_requires_roles: ["security"],
    });

    const loader = makeLoader(repo);
    expect(await loader.getAll()).toHaveLength(1);

    await seedPolicy(repo, "policy-b", {
      policy_phase_transition: "enrichment->implementation",
    });
    expect(await loader.getAll()).toHaveLength(1);

    const refreshed = await loader.refresh();
    expect(refreshed).toHaveLength(2);
  });
});

describe("PolicyLoader.getApplicablePolicies", () => {
  let repo: InMemoryKnowledgeArticleRepository;
  let loader: PolicyLoader;

  beforeEach(async () => {
    repo = new InMemoryKnowledgeArticleRepository();
    await seedPolicy(repo, "policy-feature-auth", {
      policy_applies_templates: ["feature"],
      policy_phase_transition: "enrichment->implementation",
      policy_content_matches: ["(?i)auth|oauth|session|token"],
      policy_requires_roles: ["security"],
    });
    await seedPolicy(repo, "policy-refactor-review", {
      policy_applies_templates: ["refactor"],
      policy_phase_transition: "implementation->review",
      policy_requires_roles: ["architecture"],
    });
    loader = makeLoader(repo);
    await loader.refresh();
  });

  it("matches by template + transition + content regex", async () => {
    const article = makeWorkArticle({ content: "## Objective\n\nAdd OAuth login flow." });
    const applicable = loader.getApplicablePolicies(await loader.getAll(), article, {
      from: WorkPhase.ENRICHMENT,
      to: WorkPhase.IMPLEMENTATION,
    });
    expect(applicable.map((p) => p.slug)).toEqual(["policy-feature-auth"]);
  });

  it("does not match when template differs", async () => {
    const article = makeWorkArticle({
      template: WorkTemplate.BUGFIX,
      content: "fix the auth cookie",
    });
    const applicable = loader.getApplicablePolicies(await loader.getAll(), article, {
      from: WorkPhase.ENRICHMENT,
      to: WorkPhase.IMPLEMENTATION,
    });
    expect(applicable).toEqual([]);
  });

  it("does not match when content regex misses", async () => {
    const article = makeWorkArticle({ content: "## Objective\n\nOptimize the image pipeline." });
    const applicable = loader.getApplicablePolicies(await loader.getAll(), article, {
      from: WorkPhase.ENRICHMENT,
      to: WorkPhase.IMPLEMENTATION,
    });
    expect(applicable).toEqual([]);
  });

  it("does not match when the phase transition differs", async () => {
    const article = makeWorkArticle({ content: "auth token" });
    const applicable = loader.getApplicablePolicies(await loader.getAll(), article, {
      from: WorkPhase.IMPLEMENTATION,
      to: WorkPhase.REVIEW,
    });
    expect(applicable).toEqual([]);
  });

  it("treats missing applies_templates as 'applies to every template'", async () => {
    const openRepo = new InMemoryKnowledgeArticleRepository();
    await seedPolicy(openRepo, "policy-all", {
      policy_phase_transition: "enrichment->implementation",
    });
    const openLoader = makeLoader(openRepo);
    const policies = await openLoader.getAll();
    const article = makeWorkArticle({ template: WorkTemplate.BUGFIX });
    const applicable = openLoader.getApplicablePolicies(policies, article, {
      from: WorkPhase.ENRICHMENT,
      to: WorkPhase.IMPLEMENTATION,
    });
    expect(applicable.map((p) => p.slug)).toEqual(["policy-all"]);
  });

  it("treats missing content_matches as 'any content qualifies'", async () => {
    const article = makeWorkArticle({ template: WorkTemplate.REFACTOR, content: "anything" });
    const applicable = loader.getApplicablePolicies(await loader.getAll(), article, {
      from: WorkPhase.IMPLEMENTATION,
      to: WorkPhase.REVIEW,
    });
    expect(applicable.map((p) => p.slug)).toEqual(["policy-refactor-review"]);
  });

  it("strips wrapping quotes from content_matches entries (YAML parser quirk)", async () => {
    const quotedRepo = new InMemoryKnowledgeArticleRepository();
    // Simulate what the flat YAML parser produces for a list-form item like
    //   policy_content_matches:
    //     - "(?i)auth|oauth"
    // — the surrounding double quotes are preserved verbatim on the element.
    await seedPolicy(quotedRepo, "policy-quoted", {
      policy_applies_templates: ["feature"],
      policy_phase_transition: "enrichment->implementation",
      policy_content_matches: ['"(?i)auth|oauth"'],
      policy_requires_roles: ["security"],
    });
    const quotedLoader = makeLoader(quotedRepo);
    const article = makeWorkArticle({ content: "## Objective\n\nAdd OAuth login." });

    const applicable = quotedLoader.getApplicablePolicies(
      await quotedLoader.getAll(),
      article,
      { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
    );
    expect(applicable.map((p) => p.slug)).toEqual(["policy-quoted"]);
  });

  it("treats an all-invalid content_matches list as 'matches nothing'", async () => {
    const brokenRepo = new InMemoryKnowledgeArticleRepository();
    await seedPolicy(brokenRepo, "policy-broken-regex", {
      policy_applies_templates: ["feature"],
      policy_phase_transition: "enrichment->implementation",
      // `(` without a closing `)` is a JS regex syntax error. Every pattern
      // in the list fails to compile, leaving contentMatches present-but-empty.
      // The safe default is "matches nothing", not "matches everything".
      policy_content_matches: ["("],
      policy_requires_roles: ["security"],
    });
    const brokenLoader = makeLoader(brokenRepo);
    const article = makeWorkArticle({ content: "any content" });

    const applicable = brokenLoader.getApplicablePolicies(
      await brokenLoader.getAll(),
      article,
      { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
    );
    expect(applicable).toEqual([]);
  });
});
