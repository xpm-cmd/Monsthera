import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { articleId } from "../../../src/core/types.js";
import {
  CUSTOM_FRONTMATTER_FRONTMATTER_KEY,
  POLICY_CATEGORY,
  PolicyLoader,
} from "../../../src/work/policy-loader.js";

// PR-14b (ADR-020 P3): PolicyLoader.getCustomFrontmatterRules loads per-category
// custom-frontmatter expectations from `policy_custom_frontmatter_json` on
// `category: policy` articles, applying schema defaults (required→false,
// severity→warning) and skipping malformed JSON without disabling the registry.

function makeLoader(repo: InMemoryKnowledgeArticleRepository): PolicyLoader {
  return new PolicyLoader({
    knowledgeRepo: repo,
    logger: createLogger({ level: "error", domain: "test" }),
  });
}

async function seedRegistry(
  repo: InMemoryKnowledgeArticleRepository,
  slug: string,
  jsonString: string,
): Promise<void> {
  const result = await repo.create({
    id: articleId(`k-${slug}`),
    title: `Registry: ${slug}`,
    slug: slug as never,
    category: POLICY_CATEGORY,
    content: "",
    references: [],
    extraFrontmatter: { [CUSTOM_FRONTMATTER_FRONTMATTER_KEY]: jsonString },
  });
  if (!result.ok) throw new Error(`seed failed: ${result.error.message}`);
}

describe("PolicyLoader.getCustomFrontmatterRules", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns [] when no policy article carries the registry field", async () => {
    expect(await makeLoader(repo).getCustomFrontmatterRules()).toEqual([]);
  });

  it("parses a well-formed rule and applies schema defaults", async () => {
    await seedRegistry(
      repo,
      "cf-registry",
      JSON.stringify([{ category: "experiment", key: "replicability_score", type: "number", min: 0, max: 0.8 }]),
    );

    const rules = await makeLoader(repo).getCustomFrontmatterRules();
    expect(rules).toEqual([
      {
        category: "experiment",
        key: "replicability_score",
        required: false, // schema default
        type: "number",
        min: 0,
        max: 0.8,
        severity: "warning", // schema default
      },
    ]);
  });

  it("keeps an explicit error severity and required flag", async () => {
    await seedRegistry(
      repo,
      "cf-required",
      JSON.stringify([{ category: "experiment", key: "owner", required: true, type: "string", severity: "error" }]),
    );

    const rules = await makeLoader(repo).getCustomFrontmatterRules();
    expect(rules).toEqual([
      { category: "experiment", key: "owner", required: true, type: "string", severity: "error" },
    ]);
  });

  it("aggregates rules across multiple policy articles", async () => {
    await seedRegistry(repo, "cf-a", JSON.stringify([{ category: "experiment", key: "score" }]));
    await seedRegistry(repo, "cf-b", JSON.stringify([{ category: "guide", key: "owner" }]));

    const rules = await makeLoader(repo).getCustomFrontmatterRules();
    expect(rules.map((r) => `${r.category}.${r.key}`).sort()).toEqual(["experiment.score", "guide.owner"]);
  });

  it("skips malformed JSON without disabling the registry", async () => {
    await seedRegistry(repo, "cf-bad", "{not valid json");
    await seedRegistry(repo, "cf-good", JSON.stringify([{ category: "guide", key: "owner" }]));

    const rules = await makeLoader(repo).getCustomFrontmatterRules();
    expect(rules.map((r) => r.key)).toEqual(["owner"]);
  });
});
