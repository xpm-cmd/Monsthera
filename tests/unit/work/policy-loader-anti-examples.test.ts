import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { articleId } from "../../../src/core/types.js";
import {
  ANTI_EXAMPLE_PHRASES_FRONTMATTER_KEY,
  ANTI_EXAMPLE_TOKENS_FRONTMATTER_KEY,
  MAX_VERIFY_DENSITY_FRONTMATTER_KEY,
  POLICY_CATEGORY,
  PolicyLoader,
} from "../../../src/work/policy-loader.js";

function makeLoader(repo: InMemoryKnowledgeArticleRepository): PolicyLoader {
  return new PolicyLoader({
    knowledgeRepo: repo,
    logger: createLogger({ level: "error", domain: "test" }),
  });
}

async function seed(
  repo: InMemoryKnowledgeArticleRepository,
  slug: string,
  frontmatter: Record<string, string>,
): Promise<void> {
  const result = await repo.create({
    id: articleId(`k-${slug}`),
    title: `Registry: ${slug}`,
    slug: slug as never,
    category: POLICY_CATEGORY,
    content: "",
    references: [],
    extraFrontmatter: frontmatter,
  });
  if (!result.ok) throw new Error(`seed failed: ${result.error.message}`);
}

describe("PolicyLoader.getAntiExampleTokens", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns [] when no policy article carries the tokens field", async () => {
    expect(await makeLoader(repo).getAntiExampleTokens()).toEqual([]);
  });

  it("parses a well-formed registry and normalizes snake_case", async () => {
    await seed(repo, "anti-examples", {
      [ANTI_EXAMPLE_TOKENS_FRONTMATTER_KEY]: JSON.stringify([
        {
          pattern: "B1_4_kill_switch_\\w+",
          canonical_source: "docs/aristotle-briefs/results/**/*.lean",
          description: "Lean theorem name",
        },
      ]),
    });

    const tokens = await makeLoader(repo).getAntiExampleTokens();
    expect(tokens).toEqual([
      {
        pattern: "B1_4_kill_switch_\\w+",
        canonicalSource: "docs/aristotle-briefs/results/**/*.lean",
        description: "Lean theorem name",
      },
    ]);
  });

  it("aggregates tokens across multiple registry articles and first-wins on duplicate pattern", async () => {
    await seed(repo, "reg-a", {
      [ANTI_EXAMPLE_TOKENS_FRONTMATTER_KEY]: JSON.stringify([
        { pattern: "T_1", canonical_source: "first.lean", description: "" },
      ]),
    });
    await seed(repo, "reg-b", {
      [ANTI_EXAMPLE_TOKENS_FRONTMATTER_KEY]: JSON.stringify([
        { pattern: "T_1", canonical_source: "second.lean", description: "" },
        { pattern: "T_2", canonical_source: "second.lean", description: "" },
      ]),
    });

    const tokens = await makeLoader(repo).getAntiExampleTokens();
    expect(tokens.map((t) => t.pattern).sort()).toEqual(["T_1", "T_2"]);
    expect(tokens.find((t) => t.pattern === "T_1")?.canonicalSource).toBe("first.lean");
  });

  it("drops an article with malformed JSON and keeps the rest", async () => {
    await seed(repo, "reg-bad", {
      [ANTI_EXAMPLE_TOKENS_FRONTMATTER_KEY]: "{not valid",
    });
    await seed(repo, "reg-good", {
      [ANTI_EXAMPLE_TOKENS_FRONTMATTER_KEY]: JSON.stringify([
        { pattern: "T_1", canonical_source: "ok.lean", description: "" },
      ]),
    });

    const tokens = await makeLoader(repo).getAntiExampleTokens();
    expect(tokens.map((t) => t.pattern)).toEqual(["T_1"]);
  });

  it("drops an article whose JSON violates the schema", async () => {
    await seed(repo, "reg-bad-shape", {
      [ANTI_EXAMPLE_TOKENS_FRONTMATTER_KEY]: JSON.stringify([
        { canonical_source: "missing-pattern.lean" },
      ]),
    });

    const tokens = await makeLoader(repo).getAntiExampleTokens();
    expect(tokens).toEqual([]);
  });
});

describe("PolicyLoader.getAntiExamplePhrases", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns [] when no policy article carries the phrases field", async () => {
    expect(await makeLoader(repo).getAntiExamplePhrases()).toEqual([]);
  });

  it("parses a well-formed registry and maps since_commit → sinceCommit", async () => {
    await seed(repo, "anti-examples", {
      [ANTI_EXAMPLE_PHRASES_FRONTMATTER_KEY]: JSON.stringify([
        {
          phrase: "22.4% bars",
          corrected: "22.35 bars",
          since_commit: "8012863",
          rationale: "Wave-2 correction",
        },
      ]),
    });

    const phrases = await makeLoader(repo).getAntiExamplePhrases();
    expect(phrases).toEqual([
      {
        phrase: "22.4% bars",
        corrected: "22.35 bars",
        sinceCommit: "8012863",
        rationale: "Wave-2 correction",
      },
    ]);
  });

  it("first-wins on duplicate phrase across articles", async () => {
    await seed(repo, "reg-a", {
      [ANTI_EXAMPLE_PHRASES_FRONTMATTER_KEY]: JSON.stringify([
        { phrase: "dup", corrected: "first" },
      ]),
    });
    await seed(repo, "reg-b", {
      [ANTI_EXAMPLE_PHRASES_FRONTMATTER_KEY]: JSON.stringify([
        { phrase: "dup", corrected: "second" },
      ]),
    });

    const phrases = await makeLoader(repo).getAntiExamplePhrases();
    expect(phrases).toHaveLength(1);
    expect(phrases[0]?.corrected).toBe("first");
  });
});

describe("PolicyLoader.getMaxVerifyDensity", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns undefined when no policy article pins a threshold", async () => {
    expect(await makeLoader(repo).getMaxVerifyDensity()).toBeUndefined();
  });

  it("reads a numeric threshold from policy_max_verify_density", async () => {
    await seed(repo, "density-policy", {
      [MAX_VERIFY_DENSITY_FRONTMATTER_KEY]: "0.15",
    });
    expect(await makeLoader(repo).getMaxVerifyDensity()).toBeCloseTo(0.15);
  });

  it("rejects out-of-range values and falls back to undefined", async () => {
    await seed(repo, "invalid-policy", {
      [MAX_VERIFY_DENSITY_FRONTMATTER_KEY]: "1.5",
    });
    expect(await makeLoader(repo).getMaxVerifyDensity()).toBeUndefined();
  });

  it("first-wins when multiple policies supply a threshold", async () => {
    await seed(repo, "policy-a", {
      [MAX_VERIFY_DENSITY_FRONTMATTER_KEY]: "0.1",
    });
    await seed(repo, "policy-b", {
      [MAX_VERIFY_DENSITY_FRONTMATTER_KEY]: "0.5",
    });
    expect(await makeLoader(repo).getMaxVerifyDensity()).toBeCloseTo(0.1);
  });
});
