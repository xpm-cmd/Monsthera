import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { ErrorCode } from "../../../src/core/errors.js";
import type { Logger } from "../../../src/core/logger.js";
import type { KnowledgeArticle } from "../../../src/knowledge/repository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSpyLogger(): Logger & { calls: { level: string; message: string; context?: Record<string, unknown> }[] } {
  const calls: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  const log = (level: string) => (message: string, context?: Record<string, unknown>) => {
    calls.push({ level, message, context });
  };
  return {
    calls,
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: () => createSpyLogger(),
  };
}

function createService(): { service: KnowledgeService; repo: InMemoryKnowledgeArticleRepository; logger: ReturnType<typeof createSpyLogger> } {
  const repo = new InMemoryKnowledgeArticleRepository();
  const logger = createSpyLogger();
  const service = new KnowledgeService({ knowledgeRepo: repo, logger });
  return { service, repo, logger };
}

const validCreateInput = {
  title: "Test Article",
  category: "engineering",
  content: "This is the article content.",
};

async function seedArticle(
  service: KnowledgeService,
  overrides?: Record<string, unknown>,
): Promise<KnowledgeArticle> {
  const result = await service.createArticle({ ...validCreateInput, ...overrides });
  if (!result.ok) throw new Error(`seed failed: ${result.error.message}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// createArticle
// ---------------------------------------------------------------------------

describe("createArticle", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("creates and returns an article on happy path", async () => {
    const result = await service.createArticle(validCreateInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe(validCreateInput.title);
    expect(result.value.category).toBe(validCreateInput.category);
    expect(result.value.content).toBe(validCreateInput.content);
    expect(result.value.id).toBeTruthy();
    expect(result.value.slug).toBeTruthy();
  });

  it("returns ValidationError when title is missing", async () => {
    const { title: _title, ...withoutTitle } = validCreateInput;
    const result = await service.createArticle(withoutTitle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("returns ValidationError when content is empty", async () => {
    const result = await service.createArticle({ ...validCreateInput, content: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});

// ---------------------------------------------------------------------------
// getArticle
// ---------------------------------------------------------------------------

describe("getArticle", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("retrieves an existing article by id", async () => {
    const article = await seedArticle(service);
    const result = await service.getArticle(article.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(article.id);
  });

  it("returns NotFoundError for a non-existent id", async () => {
    const result = await service.getArticle("nonexistent-id");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// getArticleBySlug
// ---------------------------------------------------------------------------

describe("getArticleBySlug", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("retrieves an article by its slug", async () => {
    const article = await seedArticle(service, { title: "My Slug Article" });
    const result = await service.getArticleBySlug(article.slug);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(article.id);
    expect(result.value.slug).toBe("my-slug-article");
  });

  it("returns NotFoundError for a non-existent slug", async () => {
    const result = await service.getArticleBySlug("does-not-exist");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// updateArticle
// ---------------------------------------------------------------------------

describe("updateArticle", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("updates an article and returns the updated value", async () => {
    const article = await seedArticle(service);
    const result = await service.updateArticle(article.id, { content: "Updated content." });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("Updated content.");
    expect(result.value.title).toBe(validCreateInput.title);
  });

  it("returns ValidationError for an invalid field (empty title)", async () => {
    const article = await seedArticle(service);
    const result = await service.updateArticle(article.id, { title: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("returns NotFoundError when the article does not exist", async () => {
    const result = await service.updateArticle("ghost-id", { content: "irrelevant" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("accepts an empty update object and returns article unchanged (except updatedAt)", async () => {
    const article = await seedArticle(service);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await service.updateArticle(article.id, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe(article.title);
    expect(result.value.content).toBe(article.content);
    expect(result.value.updatedAt).not.toBe(article.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// deleteArticle
// ---------------------------------------------------------------------------

describe("deleteArticle", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("deletes an article successfully", async () => {
    const article = await seedArticle(service);
    const deleteResult = await service.deleteArticle(article.id);
    expect(deleteResult.ok).toBe(true);

    const findResult = await service.getArticle(article.id);
    expect(findResult.ok).toBe(false);
  });

  it("returns NotFoundError when article does not exist", async () => {
    const result = await service.deleteArticle("ghost-id");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// listArticles
// ---------------------------------------------------------------------------

describe("listArticles", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("returns all articles when no category filter is provided", async () => {
    await seedArticle(service, { title: "A", category: "engineering" });
    await seedArticle(service, { title: "B", category: "design" });
    await seedArticle(service, { title: "C", category: "engineering" });

    const result = await service.listArticles();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
  });

  it("filters by category when provided", async () => {
    await seedArticle(service, { title: "A", category: "engineering" });
    await seedArticle(service, { title: "B", category: "design" });
    await seedArticle(service, { title: "C", category: "engineering" });

    const result = await service.listArticles("engineering");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value.every((a) => a.category === "engineering")).toBe(true);
  });

  it("returns empty array when no articles match the category", async () => {
    await seedArticle(service, { category: "engineering" });

    const result = await service.listArticles("nonexistent");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchArticles
// ---------------------------------------------------------------------------

describe("searchArticles", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("returns matching articles on a valid query", async () => {
    await seedArticle(service, { title: "TypeScript Patterns", content: "Advanced patterns in TS." });
    await seedArticle(service, { title: "Python Basics", content: "Intro to Python." });

    const result = await service.searchArticles("TypeScript");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.title).toBe("TypeScript Patterns");
  });

  it("returns ValidationError for an empty query", async () => {
    const result = await service.searchArticles("   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("returns empty array when no articles match the query", async () => {
    await seedArticle(service, { title: "TypeScript Patterns" });

    const result = await service.searchArticles("xxxxxx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Logging behavior
// ---------------------------------------------------------------------------

describe("logging", () => {
  it("createArticle logs at info level", async () => {
    const { service, logger } = createService();
    await service.createArticle(validCreateInput);
    const infoCall = logger.calls.find((c) => c.level === "info" && c.message.toLowerCase().includes("creating"));
    expect(infoCall).toBeDefined();
    expect(infoCall?.context).toMatchObject({ title: validCreateInput.title });
  });

  it("deleteArticle logs at info level", async () => {
    const { service, logger } = createService();
    const article = await seedArticle(service);
    logger.calls.length = 0; // reset after seed
    await service.deleteArticle(article.id);
    const infoCall = logger.calls.find((c) => c.level === "info" && c.message.toLowerCase().includes("deleting"));
    expect(infoCall).toBeDefined();
    expect(infoCall?.context).toMatchObject({ id: article.id });
  });

  it("getArticle logs at debug level", async () => {
    const { service, logger } = createService();
    const article = await seedArticle(service);
    logger.calls.length = 0; // reset after seed
    await service.getArticle(article.id);
    const debugCall = logger.calls.find((c) => c.level === "debug" && c.message.toLowerCase().includes("getting"));
    expect(debugCall).toBeDefined();
    expect(debugCall?.context).toMatchObject({ id: article.id });
  });
});
