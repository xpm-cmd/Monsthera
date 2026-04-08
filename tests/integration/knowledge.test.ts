import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createContainer, createTestContainer } from "../../src/core/container.js";
import { defaultConfig } from "../../src/core/config.js";
import { KnowledgeService } from "../../src/knowledge/service.js";
import { InMemoryKnowledgeArticleRepository } from "../../src/knowledge/in-memory-repository.js";
import { NotFoundError } from "../../src/core/errors.js";
import type { MonstheraContainer } from "../../src/core/container.js";

function createKnowledgeTestConfig() {
  return defaultConfig(`/tmp/monsthera-test-${randomUUID()}`);
}

describe("Knowledge system integration", () => {
  let container: MonstheraContainer;

  beforeEach(async () => {
    container = await createContainer(createKnowledgeTestConfig());
  });

  // ── 1: Container boots with real knowledgeRepo ──────────────────────────────

  it("knowledgeRepo is a real implementation (methods do not throw 'not implemented')", async () => {
    // findMany() on a real repo returns an empty array — it must NOT throw
    await expect(container.knowledgeRepo.findMany()).resolves.toMatchObject({ ok: true });
    await container.dispose();
  });

  // ── 2: Container has knowledgeService ───────────────────────────────────────

  it("container exposes knowledgeService", async () => {
    expect(container.knowledgeService).toBeDefined();
    expect(container.knowledgeService).toBeInstanceOf(KnowledgeService);
    await container.dispose();
  });

  // ── 3: Full CRUD lifecycle ───────────────────────────────────────────────────

  it("CRUD: create → get → update → get (verify update) → delete → get (NotFoundError)", async () => {
    const svc = container.knowledgeService;

    // Create
    const createResult = await svc.createArticle({
      title: "Integration Guide",
      category: "guides",
      content: "This is the content.",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) throw new Error("unexpected");
    const article = createResult.value;
    expect(article.title).toBe("Integration Guide");
    expect(article.category).toBe("guides");
    expect(article.slug).toBe("integration-guide");

    // Get by ID
    const getResult = await svc.getArticle(article.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) throw new Error("unexpected");
    expect(getResult.value.id).toBe(article.id);

    // Update
    const updateResult = await svc.updateArticle(article.id, { title: "Integration Guide v2" });
    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) throw new Error("unexpected");
    expect(updateResult.value.title).toBe("Integration Guide v2");

    // Get after update
    const getUpdatedResult = await svc.getArticle(article.id);
    expect(getUpdatedResult.ok).toBe(true);
    if (!getUpdatedResult.ok) throw new Error("unexpected");
    expect(getUpdatedResult.value.title).toBe("Integration Guide v2");

    // Delete
    const deleteResult = await svc.deleteArticle(article.id);
    expect(deleteResult.ok).toBe(true);

    // Get after delete → NotFoundError
    const getDeletedResult = await svc.getArticle(article.id);
    expect(getDeletedResult.ok).toBe(false);
    if (getDeletedResult.ok) throw new Error("unexpected");
    expect(getDeletedResult.error).toBeInstanceOf(NotFoundError);

    await container.dispose();
  });

  // ── 4: Search after creating multiple articles ───────────────────────────────

  it("searchArticles returns matching articles", async () => {
    const svc = container.knowledgeService;

    await svc.createArticle({ title: "TypeScript Tips", category: "language", content: "Use strict mode." });
    await svc.createArticle({ title: "JavaScript Tricks", category: "language", content: "Avoid var." });
    await svc.createArticle({ title: "Database Design", category: "architecture", content: "Normalize your schema." });

    const result = await svc.searchArticles("TypeScript");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.value).toHaveLength(1);
    const firstSearchResult = result.value[0];
    expect(firstSearchResult?.title).toBe("TypeScript Tips");

    await container.dispose();
  });

  // ── 5: listArticles with category filter ────────────────────────────────────

  it("listArticles(category) returns only articles in that category", async () => {
    const svc = container.knowledgeService;

    await svc.createArticle({ title: "API Design", category: "architecture", content: "REST principles." });
    await svc.createArticle({ title: "Testing Basics", category: "testing", content: "Write unit tests." });
    await svc.createArticle({ title: "Event Sourcing", category: "architecture", content: "Immutable events." });

    const result = await svc.listArticles("architecture");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.value).toHaveLength(2);
    expect(result.value.every((a) => a.category === "architecture")).toBe(true);

    await container.dispose();
  });

  // ── 6: findByTag via the repo directly ──────────────────────────────────────

  it("findByTag returns articles that have the requested tag", async () => {
    const svc = container.knowledgeService;

    await svc.createArticle({ title: "Node.js Perf", category: "performance", content: "Use async.", tags: ["node", "performance"] });
    await svc.createArticle({ title: "Python Perf", category: "performance", content: "Use C extensions.", tags: ["python", "performance"] });
    await svc.createArticle({ title: "Unrelated", category: "misc", content: "No tags.", tags: [] });

    const result = await container.knowledgeRepo.findByTag("node");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.value).toHaveLength(1);
    const firstTagResult = result.value[0];
    expect(firstTagResult?.title).toBe("Node.js Perf");

    await container.dispose();
  });

  // ── 7: findBySlug via service ────────────────────────────────────────────────

  it("getArticleBySlug returns the correct article", async () => {
    const svc = container.knowledgeService;

    await svc.createArticle({ title: "Slug Test Article", category: "meta", content: "Testing slugs." });

    const result = await svc.getArticleBySlug("slug-test-article");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.value.title).toBe("Slug Test Article");
    expect(result.value.slug).toBe("slug-test-article");

    await container.dispose();
  });

  // ── 8: createTestContainer allows overriding knowledgeService ───────────────

  it("createTestContainer accepts a custom knowledgeService override", async () => {
    const customRepo = new InMemoryKnowledgeArticleRepository();
    const customLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function () { return this; },
    };
    const customService = new KnowledgeService({ knowledgeRepo: customRepo, logger: customLogger });

    const testContainer = await createTestContainer({ knowledgeService: customService });
    expect(testContainer.knowledgeService).toBe(customService);

    // Verify the custom service works
    const createResult = await testContainer.knowledgeService.createArticle({
      title: "Custom Service Test",
      category: "test",
      content: "Works.",
    });
    expect(createResult.ok).toBe(true);

    await testContainer.dispose();
  });

  // ── 9: Container dispose still works ────────────────────────────────────────

  it("dispose() completes cleanly after knowledge operations", async () => {
    const svc = container.knowledgeService;
    await svc.createArticle({ title: "Disposable Article", category: "test", content: "Will be gone." });
    await expect(container.dispose()).resolves.toBeUndefined();
  });

  // ── 10: Status reporter still includes storage subsystem ────────────────────

  it("status reporter includes storage subsystem after Phase 2 wiring", async () => {
    const status = container.status.getStatus();
    const storage = status.subsystems.find((s) => s.name === "storage");
    expect(storage).toBeDefined();
    expect(storage?.healthy).toBe(true);
    await container.dispose();
  });

  // ── 11: Multiple articles with same title get unique slugs ──────────────────

  it("articles with the same title receive unique slugs", async () => {
    const svc = container.knowledgeService;

    const r1 = await svc.createArticle({ title: "Duplicate Title", category: "test", content: "First." });
    const r2 = await svc.createArticle({ title: "Duplicate Title", category: "test", content: "Second." });
    const r3 = await svc.createArticle({ title: "Duplicate Title", category: "test", content: "Third." });

    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error("unexpected");

    const slugs = [r1.value.slug, r2.value.slug, r3.value.slug];
    const uniqueSlugs = new Set(slugs);
    expect(uniqueSlugs.size).toBe(3);
    expect(slugs[0]).toBe("duplicate-title");
    expect(slugs[1]).toBe("duplicate-title-2");
    expect(slugs[2]).toBe("duplicate-title-3");

    await container.dispose();
  });

  // ── 12: Create article with all optional fields ──────────────────────────────

  it("creates an article with all optional fields populated", async () => {
    const svc = container.knowledgeService;

    const result = await svc.createArticle({
      title: "Fully Featured Article",
      category: "docs",
      content: "Rich content here.",
      tags: ["tag-a", "tag-b", "tag-c"],
      codeRefs: ["src/core/container.ts#L30", "src/server.ts#L10"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");

    const article = result.value;
    expect(article.title).toBe("Fully Featured Article");
    expect(article.category).toBe("docs");
    expect(article.content).toBe("Rich content here.");
    expect(article.tags).toEqual(["tag-a", "tag-b", "tag-c"]);
    expect(article.codeRefs).toEqual(["src/core/container.ts#L30", "src/server.ts#L10"]);
    expect(article.slug).toBe("fully-featured-article");
    expect(article.id).toBeTruthy();
    expect(article.createdAt).toBeTruthy();
    expect(article.updatedAt).toBeTruthy();

    await container.dispose();
  });

  it("persists articles across container restarts on the same repo path", async () => {
    const config = createKnowledgeTestConfig();
    const first = await createContainer(config);

    const created = await first.knowledgeService.createArticle({
      title: "Persistent Architecture Note",
      category: "architecture",
      content: "This should survive a restart.",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unexpected");

    await first.dispose();

    const second = await createContainer(config);
    const reloaded = await second.knowledgeService.getArticleBySlug("persistent-architecture-note");
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) throw new Error("unexpected");
    expect(reloaded.value.id).toBe(created.value.id);
    expect(reloaded.value.content).toBe("This should survive a restart.");

    await second.dispose();
  });
});
