import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { ErrorCode } from "../../../src/core/errors.js";
import type { KnowledgeArticle } from "../../../src/knowledge/repository.js";
import { slug as brandSlug } from "../../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createArticle(
  repo: InMemoryKnowledgeArticleRepository,
  overrides?: Partial<Parameters<typeof repo.create>[0]>,
): Promise<KnowledgeArticle> {
  const result = await repo.create({
    title: "Test Article",
    category: "general",
    content: "Test content",
    ...overrides,
  });
  if (!result.ok) throw new Error("create failed in helper");
  return result.value;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("create", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns an article with id, slug, and timestamps set", async () => {
    const result = await repo.create({ title: "Hello World", category: "docs", content: "body" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBeTruthy();
    expect(result.value.slug).toBe("hello-world");
    expect(result.value.createdAt).toBeTruthy();
    expect(result.value.updatedAt).toBeTruthy();
  });

  it("returns article including provided tags and codeRefs", async () => {
    const result = await repo.create({
      title: "Tagged",
      category: "docs",
      content: "body",
      tags: ["typescript", "testing"],
      codeRefs: ["src/foo.ts"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.tags).toEqual(["typescript", "testing"]);
    expect(result.value.codeRefs).toEqual(["src/foo.ts"]);
  });

  it("defaults tags and codeRefs to empty arrays when omitted", async () => {
    const result = await repo.create({ title: "Minimal", category: "docs", content: "body" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.tags).toEqual([]);
    expect(result.value.codeRefs).toEqual([]);
  });

  it("generates a unique id for each article", async () => {
    const a = await createArticle(repo, { title: "First" });
    const b = await createArticle(repo, { title: "Second" });
    expect(a.id).not.toBe(b.id);
  });

  it("generates a slug from the title", async () => {
    const result = await repo.create({ title: "Hello World", category: "docs", content: "body" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("hello-world");
  });

  it("appends a numeric suffix when slug already exists (collision avoidance)", async () => {
    const a = await createArticle(repo, { title: "Hello World" });
    const b = await createArticle(repo, { title: "Hello World" });

    expect(a.slug).toBe("hello-world");
    expect(b.slug).toBe("hello-world-2");
  });
});

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

describe("findById", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns the created article by its id", async () => {
    const created = await createArticle(repo);
    const result = await repo.findById(created.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(created.id);
  });

  it("returns NotFoundError for unknown id", async () => {
    const result = await repo.findById("nonexistent-id");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// findBySlug
// ---------------------------------------------------------------------------

describe("findBySlug", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns the article matching the slug", async () => {
    const created = await createArticle(repo, { title: "Hello World" });
    const result = await repo.findBySlug(brandSlug("hello-world"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(created.id);
  });

  it("returns NotFoundError for unknown slug", async () => {
    const result = await repo.findBySlug(brandSlug("not-a-real-slug"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// findByCategory
// ---------------------------------------------------------------------------

describe("findByCategory", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns articles in the specified category", async () => {
    await createArticle(repo, { title: "A", category: "engineering" });
    await createArticle(repo, { title: "B", category: "engineering" });
    await createArticle(repo, { title: "C", category: "design" });

    const result = await repo.findByCategory("engineering");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value.every((a) => a.category === "engineering")).toBe(true);
  });

  it("matches category case-insensitively", async () => {
    await createArticle(repo, { title: "A", category: "Engineering" });

    const result = await repo.findByCategory("ENGINEERING");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it("returns empty array when no articles match", async () => {
    await createArticle(repo, { title: "A", category: "docs" });

    const result = await repo.findByCategory("nonexistent");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findByTag
// ---------------------------------------------------------------------------

describe("findByTag", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns articles that include the specified tag", async () => {
    await createArticle(repo, { title: "A", tags: ["typescript"] });
    await createArticle(repo, { title: "B", tags: ["javascript"] });

    const result = await repo.findByTag("typescript");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.title).toBe("A");
  });

  it("returns empty array when no articles have the tag", async () => {
    await createArticle(repo, { title: "A", tags: ["typescript"] });

    const result = await repo.findByTag("rust");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("matches an article that has the tag among multiple tags", async () => {
    await createArticle(repo, { title: "A", tags: ["typescript", "testing", "vitest"] });

    const result = await repo.findByTag("testing");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe("search", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("matches articles by title", async () => {
    await createArticle(repo, { title: "TypeScript Guide" });
    await createArticle(repo, { title: "Python Tutorial" });

    const result = await repo.search("TypeScript");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.title).toBe("TypeScript Guide");
  });

  it("matches articles by content", async () => {
    await createArticle(repo, { title: "Article A", content: "Discusses monads and functors" });
    await createArticle(repo, { title: "Article B", content: "About classes and inheritance" });

    const result = await repo.search("monads");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.title).toBe("Article A");
  });

  it("matches articles by tag", async () => {
    await createArticle(repo, { title: "A", tags: ["functional-programming"] });
    await createArticle(repo, { title: "B", tags: ["oop"] });

    const result = await repo.search("functional");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it("matches articles by category", async () => {
    await createArticle(repo, { title: "A", category: "architecture" });
    await createArticle(repo, { title: "B", category: "testing" });

    const result = await repo.search("architecture");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it("is case-insensitive", async () => {
    await createArticle(repo, { title: "TypeScript Guide" });

    const result = await repo.search("typescript");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it("returns empty array when nothing matches", async () => {
    await createArticle(repo, { title: "TypeScript Guide" });

    const result = await repo.search("xxxxxx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("update", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("applies a partial update and returns the updated article", async () => {
    const created = await createArticle(repo, { title: "Original", category: "docs", content: "old content" });

    const result = await repo.update(created.id, { content: "new content" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("new content");
    expect(result.value.title).toBe("Original");
  });

  it("regenerates slug when title changes", async () => {
    const created = await createArticle(repo, { title: "Old Title" });
    expect(created.slug).toBe("old-title");

    const result = await repo.update(created.id, { title: "New Title" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("new-title");
  });

  it("returns NotFoundError when the id does not exist", async () => {
    const result = await repo.update("ghost-id", { title: "Irrelevant" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("preserves fields that are not included in the update", async () => {
    const created = await createArticle(repo, {
      title: "My Article",
      category: "engineering",
      tags: ["ts"],
      codeRefs: ["src/a.ts"],
    });

    const result = await repo.update(created.id, { content: "updated body" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe("My Article");
    expect(result.value.category).toBe("engineering");
    expect(result.value.tags).toEqual(["ts"]);
    expect(result.value.codeRefs).toEqual(["src/a.ts"]);
  });

  it("updates updatedAt but not createdAt", async () => {
    const created = await createArticle(repo);
    // Ensure a measurable time difference
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await repo.update(created.id, { content: "changed" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.createdAt).toBe(created.createdAt);
    expect(result.value.updatedAt).not.toBe(created.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("delete", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("removes the article so it can no longer be found", async () => {
    const created = await createArticle(repo);
    const deleteResult = await repo.delete(created.id);
    expect(deleteResult.ok).toBe(true);

    const findResult = await repo.findById(created.id);
    expect(findResult.ok).toBe(false);
  });

  it("returns NotFoundError when the id does not exist", async () => {
    const result = await repo.delete("ghost-id");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// findMany
// ---------------------------------------------------------------------------

describe("findMany", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns all stored articles", async () => {
    await createArticle(repo, { title: "A" });
    await createArticle(repo, { title: "B" });
    await createArticle(repo, { title: "C" });

    const result = await repo.findMany();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// exists
// ---------------------------------------------------------------------------

describe("exists", () => {
  let repo: InMemoryKnowledgeArticleRepository;

  beforeEach(() => {
    repo = new InMemoryKnowledgeArticleRepository();
  });

  it("returns true for an existing article and false for a non-existing id", async () => {
    const created = await createArticle(repo);

    expect(await repo.exists(created.id)).toBe(true);
    expect(await repo.exists("not-a-real-id")).toBe(false);
  });
});
