import { describe, it, expect, beforeEach } from "vitest";
import {
  knowledgeToolDefinitions,
  handleKnowledgeTool,
} from "../../../src/tools/knowledge-tools.js";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import type { Logger } from "../../../src/core/logger.js";
import type { KnowledgeArticle } from "../../../src/knowledge/repository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

function createService(): KnowledgeService {
  return new KnowledgeService({
    knowledgeRepo: new InMemoryKnowledgeArticleRepository(),
    logger: noopLogger,
  });
}

const validInput = {
  title: "Test Article",
  category: "engineering",
  content: "This is the article content.",
};

async function seedArticle(
  service: KnowledgeService,
  overrides?: Record<string, unknown>,
): Promise<KnowledgeArticle> {
  const result = await service.createArticle({ ...validInput, ...overrides });
  if (!result.ok) throw new Error(`seed failed: ${result.error.message}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// knowledgeToolDefinitions
// ---------------------------------------------------------------------------

describe("knowledgeToolDefinitions", () => {
  it("returns exactly 6 tools", () => {
    const defs = knowledgeToolDefinitions();
    expect(defs).toHaveLength(6);
  });

  it("each tool has name, description, and inputSchema", () => {
    const defs = knowledgeToolDefinitions();
    for (const def of defs) {
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe("object");
      expect(typeof def.inputSchema.properties).toBe("object");
    }
  });

  it("tool names match the expected set", () => {
    const names = knowledgeToolDefinitions().map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "create_article",
        "get_article",
        "update_article",
        "delete_article",
        "list_articles",
        "search_articles",
      ]),
    );
  });

  it("descriptions reflect automatic search sync", () => {
    const defs = knowledgeToolDefinitions();
    expect(defs.find((def) => def.name === "create_article")?.description).toContain("Search sync happens automatically");
    expect(defs.find((def) => def.name === "update_article")?.description).toContain("durable wording");
    expect(defs.find((def) => def.name === "search_articles")?.description).toContain("knowledge-only lookup");
    expect(defs.find((def) => def.name === "create_article")?.description).not.toContain("Call index_article afterwards");
    expect(defs.find((def) => def.name === "delete_article")?.description).toContain("manual remove_from_index");
  });
});

// ---------------------------------------------------------------------------
// create_article
// ---------------------------------------------------------------------------

describe("create_article", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    service = createService();
  });

  it("returns JSON article on success", async () => {
    const response = await handleKnowledgeTool("create_article", validInput, service);
    expect(response.isError).toBeUndefined();
    expect(response.content).toHaveLength(1);
    expect(response.content[0]!.type).toBe("text");
    const article = JSON.parse(response.content[0]!.text) as KnowledgeArticle;
    expect(article.title).toBe(validInput.title);
    expect(article.category).toBe(validInput.category);
    expect(article.id).toBeTruthy();
  });

  it("returns isError: true on validation failure (missing title)", async () => {
    const { title: _t, ...withoutTitle } = validInput;
    const response = await handleKnowledgeTool("create_article", withoutTitle, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("VALIDATION_FAILED");
    expect(typeof body.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// get_article
// ---------------------------------------------------------------------------

describe("get_article", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    service = createService();
  });

  it("returns article by id", async () => {
    const article = await seedArticle(service);
    const response = await handleKnowledgeTool("get_article", { id: article.id }, service);
    expect(response.isError).toBeUndefined();
    const fetched = JSON.parse(response.content[0]!.text) as KnowledgeArticle;
    expect(fetched.id).toBe(article.id);
  });

  it("returns article by slug", async () => {
    const article = await seedArticle(service, { title: "Slug Test Article" });
    const response = await handleKnowledgeTool("get_article", { slug: article.slug }, service);
    expect(response.isError).toBeUndefined();
    const fetched = JSON.parse(response.content[0]!.text) as KnowledgeArticle;
    expect(fetched.slug).toBe(article.slug);
  });

  it("returns error when neither id nor slug is provided", async () => {
    const response = await handleKnowledgeTool("get_article", {}, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("returns NOT_FOUND error for unknown id", async () => {
    const response = await handleKnowledgeTool("get_article", { id: "ghost-id" }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// update_article
// ---------------------------------------------------------------------------

describe("update_article", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    service = createService();
  });

  it("returns updated article on success", async () => {
    const article = await seedArticle(service);
    const response = await handleKnowledgeTool(
      "update_article",
      { id: article.id, content: "Updated content." },
      service,
    );
    expect(response.isError).toBeUndefined();
    const updated = JSON.parse(response.content[0]!.text) as KnowledgeArticle;
    expect(updated.content).toBe("Updated content.");
    expect(updated.title).toBe(article.title);
  });

  it("returns NOT_FOUND error for unknown id", async () => {
    const response = await handleKnowledgeTool(
      "update_article",
      { id: "nonexistent", content: "x" },
      service,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// delete_article
// ---------------------------------------------------------------------------

describe("delete_article", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    service = createService();
  });

  it("returns { deleted: true } on success", async () => {
    const article = await seedArticle(service);
    const response = await handleKnowledgeTool("delete_article", { id: article.id }, service);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it("returns NOT_FOUND error for unknown id", async () => {
    const response = await handleKnowledgeTool("delete_article", { id: "ghost-id" }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// list_articles
// ---------------------------------------------------------------------------

describe("list_articles", () => {
  let service: KnowledgeService;

  beforeEach(async () => {
    service = createService();
    await seedArticle(service, { title: "A", category: "engineering" });
    await seedArticle(service, { title: "B", category: "design" });
    await seedArticle(service, { title: "C", category: "engineering" });
  });

  it("returns all articles when no category provided", async () => {
    const response = await handleKnowledgeTool("list_articles", {}, service);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { total: number; items: { id: string; title: string; category: string }[] };
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
  });

  it("filters by category when provided", async () => {
    const response = await handleKnowledgeTool("list_articles", { category: "engineering" }, service);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { total: number; items: { id: string; title: string; category: string }[] };
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items.every((a) => a.category === "engineering")).toBe(true);
  });

  it("respects limit and offset", async () => {
    const response = await handleKnowledgeTool("list_articles", { limit: 1, offset: 1 }, service);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { total: number; limit: number; offset: number; items: unknown[] };
    expect(body.total).toBe(3);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);
    expect(body.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// search_articles
// ---------------------------------------------------------------------------

describe("search_articles", () => {
  let service: KnowledgeService;

  beforeEach(async () => {
    service = createService();
    await seedArticle(service, { title: "TypeScript Patterns", content: "Advanced patterns in TS." });
    await seedArticle(service, { title: "Python Basics", content: "Intro to Python." });
  });

  it("returns matching article summaries for a valid query", async () => {
    const response = await handleKnowledgeTool("search_articles", { query: "TypeScript" }, service);
    expect(response.isError).toBeUndefined();
    const articles = JSON.parse(response.content[0]!.text) as Array<{ title: string; snippet: string }>;
    expect(articles).toHaveLength(1);
    expect(articles[0]!.title).toBe("TypeScript Patterns");
    expect(articles[0]!.snippet).toBeDefined();
    expect(articles[0]!).not.toHaveProperty("content");
  });

  it("respects limit parameter", async () => {
    await seedArticle(service, { title: "TypeScript Advanced", content: "TypeScript deep dive." });
    const response = await handleKnowledgeTool("search_articles", { query: "TypeScript", limit: 1 }, service);
    expect(response.isError).toBeUndefined();
    const articles = JSON.parse(response.content[0]!.text) as Array<{ title: string }>;
    expect(articles).toHaveLength(1);
  });

  it("defaults to 10 results max", async () => {
    for (let i = 0; i < 15; i++) {
      await seedArticle(service, { title: `Article ${i}`, content: `Content for article ${i}.` });
    }
    const response = await handleKnowledgeTool("search_articles", { query: "Article" }, service);
    expect(response.isError).toBeUndefined();
    const articles = JSON.parse(response.content[0]!.text) as Array<{ title: string }>;
    expect(articles.length).toBeLessThanOrEqual(10);
  });

  it("returns VALIDATION_FAILED for empty query", async () => {
    const response = await handleKnowledgeTool("search_articles", { query: "   " }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// Response format contracts
// ---------------------------------------------------------------------------

describe("response format", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    service = createService();
  });

  it("success response has content array with type: text", async () => {
    const response = await handleKnowledgeTool("create_article", validInput, service);
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content[0]!.type).toBe("text");
    expect(typeof response.content[0]!.text).toBe("string");
    expect(response.isError).toBeUndefined();
  });

  it("error response has isError: true and JSON body with error + message", async () => {
    const response = await handleKnowledgeTool("get_article", { id: "missing" }, service);
    expect(response.isError).toBe(true);
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content[0]!.type).toBe("text");
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Unknown tool name
// ---------------------------------------------------------------------------

describe("unknown tool", () => {
  it("returns NOT_FOUND error for an unrecognized tool name", async () => {
    const service = createService();
    const response = await handleKnowledgeTool("does_not_exist", {}, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toContain("does_not_exist");
  });
});

// ---------------------------------------------------------------------------
// Malformed input handling (no throws, returns error responses)
// ---------------------------------------------------------------------------

describe("malformed input handling", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    service = createService();
  });

  it("get_article rejects non-string id", async () => {
    const response = await handleKnowledgeTool("get_article", { id: 42 }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("get_article rejects non-string slug", async () => {
    const response = await handleKnowledgeTool("get_article", { slug: true }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("update_article rejects missing id", async () => {
    const response = await handleKnowledgeTool("update_article", { title: "New" }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("update_article rejects non-string id", async () => {
    const response = await handleKnowledgeTool("update_article", { id: 123 }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("delete_article rejects missing id", async () => {
    const response = await handleKnowledgeTool("delete_article", {}, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("delete_article rejects non-string id", async () => {
    const response = await handleKnowledgeTool("delete_article", { id: null }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("search_articles rejects missing query", async () => {
    const response = await handleKnowledgeTool("search_articles", {}, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("search_articles rejects non-string query", async () => {
    const response = await handleKnowledgeTool("search_articles", { query: 42 }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("list_articles rejects non-string category", async () => {
    const response = await handleKnowledgeTool("list_articles", { category: 999 }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("list_articles rejects null category", async () => {
    const response = await handleKnowledgeTool("list_articles", { category: null }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("get_article rejects null id and null slug", async () => {
    const response = await handleKnowledgeTool("get_article", { id: null, slug: null }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });
});
