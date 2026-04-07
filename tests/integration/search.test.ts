import { describe, it, expect } from "vitest";
import { createTestContainer } from "../../src/core/container.js";

describe("Search integration", () => {
  it("indexes and searches knowledge articles", async () => {
    const container = await createTestContainer();
    // Create a knowledge article
    const createResult = await container.knowledgeService.createArticle({
      title: "Authentication Guide",
      category: "guide",
      content: "How to set up OAuth2 authentication",
      codeRefs: ["src/auth/oauth.ts"],
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Index it
    const indexResult = await container.searchService.indexKnowledgeArticle(createResult.value.id);
    expect(indexResult.ok).toBe(true);

    // Search by title
    const searchResult = await container.searchService.search({ query: "Authentication" });
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) return;
    expect(searchResult.value.length).toBeGreaterThan(0);
    expect(searchResult.value[0]!.title).toBe("Authentication Guide");
  });

  it("searches by code reference", async () => {
    const container = await createTestContainer();
    // Title and content do NOT mention "zxconfig" — only the codeRef does
    const createResult = await container.knowledgeService.createArticle({
      title: "Settings Module",
      category: "guide",
      content: "How to manage application settings",
      codeRefs: ["src/core/zxconfig.ts"],
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    await container.searchService.indexKnowledgeArticle(createResult.value.id);

    // Search for the unique codeRef term — only findable if codeRefs are indexed
    const searchResult = await container.searchService.search({ query: "zxconfig" });
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) return;
    expect(searchResult.value.length).toBeGreaterThan(0);
    expect(searchResult.value[0]!.id).toBe(createResult.value.id);
  });

  it("indexes and searches work articles", async () => {
    const container = await createTestContainer();
    const createResult = await container.workService.createWork({
      title: "Fix Login Bug",
      template: "bugfix",
      priority: "high",
      author: "agent-1",
      content: "The login page crashes on submit",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    await container.searchService.indexWorkArticle(createResult.value.id);

    const searchResult = await container.searchService.search({ query: "login" });
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) return;
    expect(searchResult.value.length).toBeGreaterThan(0);
    expect(searchResult.value[0]!.type).toBe("work");
  });

  it("filters by type", async () => {
    const container = await createTestContainer();
    // Create and index one of each type
    const k = await container.knowledgeService.createArticle({
      title: "Knowledge Item",
      category: "concept",
      content: "Shared keyword content",
    });
    if (!k.ok) throw new Error("seed failed");
    await container.searchService.indexKnowledgeArticle(k.value.id);

    const w = await container.workService.createWork({
      title: "Work Item",
      template: "feature",
      priority: "medium",
      author: "a-1",
      content: "Shared keyword content",
    });
    if (!w.ok) throw new Error("seed failed");
    await container.searchService.indexWorkArticle(w.value.id);

    // Search with type filter
    const knowledgeOnly = await container.searchService.search({
      query: "keyword",
      type: "knowledge",
    });
    expect(knowledgeOnly.ok).toBe(true);
    if (!knowledgeOnly.ok) return;
    expect(knowledgeOnly.value.every((r) => r.type === "knowledge")).toBe(true);
  });

  it("removes from index", async () => {
    const container = await createTestContainer();
    const createResult = await container.knowledgeService.createArticle({
      title: "Removable",
      category: "guide",
      content: "Will be removed",
    });
    if (!createResult.ok) throw new Error("seed failed");
    await container.searchService.indexKnowledgeArticle(createResult.value.id);

    await container.searchService.removeArticle(createResult.value.id);

    const searchResult = await container.searchService.search({ query: "Removable" });
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) return;
    expect(searchResult.value.length).toBe(0);
  });

  it("full reindex rebuilds from all sources", async () => {
    const container = await createTestContainer();
    const k = await container.knowledgeService.createArticle({
      title: "Reindex Knowledge",
      category: "concept",
      content: "Unique reindex knowledge content",
    });
    if (!k.ok) throw new Error("seed failed");

    const w = await container.workService.createWork({
      title: "Reindex Work",
      template: "feature",
      priority: "medium",
      author: "agent-1",
      content: "Unique reindex work content",
    });
    if (!w.ok) throw new Error("seed failed");

    // fullReindex without prior indexing — should find all articles
    const reindexResult = await container.searchService.fullReindex();
    expect(reindexResult.ok).toBe(true);
    if (!reindexResult.ok) return;
    expect(reindexResult.value.knowledgeCount).toBeGreaterThanOrEqual(1);
    expect(reindexResult.value.workCount).toBeGreaterThanOrEqual(1);

    // Verify knowledge article is searchable
    const kSearch = await container.searchService.search({ query: "reindex knowledge" });
    expect(kSearch.ok).toBe(true);
    if (!kSearch.ok) return;
    expect(kSearch.value.length).toBeGreaterThan(0);

    // Verify work article is searchable
    const wSearch = await container.searchService.search({ query: "reindex work" });
    expect(wSearch.ok).toBe(true);
    if (!wSearch.ok) return;
    expect(wSearch.value.length).toBeGreaterThan(0);
    expect(wSearch.value[0]!.type).toBe("work");
  });
});
