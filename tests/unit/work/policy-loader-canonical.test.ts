import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { articleId } from "../../../src/core/types.js";
import {
  CANONICAL_VALUES_FRONTMATTER_KEY,
  POLICY_CATEGORY,
  PolicyLoader,
} from "../../../src/work/policy-loader.js";

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
    extraFrontmatter: { [CANONICAL_VALUES_FRONTMATTER_KEY]: jsonString },
  });
  if (!result.ok) throw new Error(`seed failed: ${result.error.message}`);
}

describe("PolicyLoader.getCanonicalValues", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns [] when no policy article carries the registry field", async () => {
    expect(await makeLoader(repo).getCanonicalValues()).toEqual([]);
  });

  it("parses a well-formed registry and normalizes snake_case → camelCase", async () => {
    await seedRegistry(
      repo,
      "canonical-values",
      JSON.stringify([
        {
          name: "c_rt",
          value: "$0.010",
          unit: "per_rt",
          source_article: "k-aristotle-c2-cpcv",
          valid_since_commit: "8012863",
          rationale: "Corrected from $0.10 in Wave-2 boundary review",
        },
      ]),
    );

    const values = await makeLoader(repo).getCanonicalValues();
    expect(values).toEqual([
      {
        name: "c_rt",
        value: "$0.010",
        unit: "per_rt",
        sourceArticle: "k-aristotle-c2-cpcv",
        validSinceCommit: "8012863",
        rationale: "Corrected from $0.10 in Wave-2 boundary review",
      },
    ]);
  });

  it("aggregates canonical values across multiple policy articles", async () => {
    await seedRegistry(
      repo,
      "registry-currency",
      JSON.stringify([{ name: "K_min", value: "$1,815", unit: "usd" }]),
    );
    await seedRegistry(
      repo,
      "registry-counts",
      JSON.stringify([{ name: "ws11_bars", value: "22.35", unit: "count" }]),
    );

    const values = await makeLoader(repo).getCanonicalValues();
    expect(values.map((v) => v.name).sort()).toEqual(["K_min", "ws11_bars"]);
  });

  it("first-wins on duplicate name across articles", async () => {
    await seedRegistry(
      repo,
      "registry-a",
      JSON.stringify([{ name: "c_rt", value: "$0.010" }]),
    );
    await seedRegistry(
      repo,
      "registry-b",
      JSON.stringify([{ name: "c_rt", value: "$0.10" }]),
    );

    const values = await makeLoader(repo).getCanonicalValues();
    expect(values).toHaveLength(1);
    expect(values[0]?.value).toBe("$0.010");
  });

  it("drops a policy with malformed JSON and keeps the rest", async () => {
    await seedRegistry(repo, "registry-bad", "{not valid json");
    await seedRegistry(
      repo,
      "registry-good",
      JSON.stringify([{ name: "K_min", value: "$1,815" }]),
    );

    const values = await makeLoader(repo).getCanonicalValues();
    expect(values.map((v) => v.name)).toEqual(["K_min"]);
  });

  it("drops a policy whose JSON violates the schema (e.g. missing name)", async () => {
    await seedRegistry(
      repo,
      "registry-bad-shape",
      JSON.stringify([{ value: "$1,815" }]),
    );
    await seedRegistry(
      repo,
      "registry-good",
      JSON.stringify([{ name: "K_min", value: "$1,815" }]),
    );

    const values = await makeLoader(repo).getCanonicalValues();
    expect(values.map((v) => v.name)).toEqual(["K_min"]);
  });

  it("refresh() reloads the registry cache when articles change", async () => {
    const loader = makeLoader(repo);
    expect(await loader.getCanonicalValues()).toEqual([]);

    await seedRegistry(
      repo,
      "registry",
      JSON.stringify([{ name: "c_rt", value: "$0.010" }]),
    );

    // Still cached empty until refresh
    expect(await loader.getCanonicalValues()).toEqual([]);
    await loader.refresh();
    const values = await loader.getCanonicalValues();
    expect(values.map((v) => v.name)).toEqual(["c_rt"]);
  });

  it("ignores a policy article with an empty registry field", async () => {
    await seedRegistry(repo, "registry-empty", "");
    expect(await makeLoader(repo).getCanonicalValues()).toEqual([]);
  });
});
