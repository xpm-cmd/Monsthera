import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { ErrorCode } from "../../../src/core/errors.js";
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

function createService(): { service: KnowledgeService; repo: InMemoryKnowledgeArticleRepository } {
  const repo = new InMemoryKnowledgeArticleRepository();
  const service = new KnowledgeService({ knowledgeRepo: repo, logger: noopLogger });
  return { service, repo };
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
// knowledgeService.previewSlug
// ---------------------------------------------------------------------------

describe("knowledgeService.previewSlug", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("generates slug from title with no existing conflicts", async () => {
    const result = await service.previewSlug("Hello World");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("hello-world");
    expect(result.value.alreadyExists).toBe(false);
    expect(result.value.conflicts).toEqual([]);
  });

  it("flags already_exists when the exact slug is taken", async () => {
    await seedArticle(service, { title: "My Article" });
    const result = await service.previewSlug("My Article");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("my-article");
    expect(result.value.alreadyExists).toBe(true);
    // Exact match goes to already_exists, not conflicts
    expect(result.value.conflicts).toEqual([]);
  });

  it("flags near-miss conflicts via Jaccard >= 0.7", async () => {
    // Seed an article whose slug is the near-miss
    await seedArticle(service, { title: "HRV and Autonomic Nervous System" });
    const result = await service.previewSlug("HRV and the Autonomic Nervous System");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("hrv-and-the-autonomic-nervous-system");
    expect(result.value.alreadyExists).toBe(false);
    expect(result.value.conflicts).toContain("hrv-and-autonomic-nervous-system");
  });

  it("returns empty conflicts array when no near-miss found", async () => {
    await seedArticle(service, { title: "Completely Unrelated Topic" });
    const result = await service.previewSlug("Quantum Physics Primer");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("quantum-physics-primer");
    expect(result.value.alreadyExists).toBe(false);
    expect(result.value.conflicts).toEqual([]);
  });

  it("handles titles that slugify to 'untitled'", async () => {
    const result = await service.previewSlug("!@#$%");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("untitled");
    expect(result.value.alreadyExists).toBe(false);
    expect(result.value.conflicts).toEqual([]);
  });

  it("does not include exact match in conflicts (goes to alreadyExists instead)", async () => {
    await seedArticle(service, { title: "Same Title" });
    const result = await service.previewSlug("Same Title");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alreadyExists).toBe(true);
    expect(result.value.conflicts).not.toContain("same-title");
  });

  it("is read-only — does not mutate state", async () => {
    const before = await service.listArticles();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const countBefore = before.value.length;

    await service.previewSlug("Some New Title");

    const after = await service.listArticles();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.length).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// createArticle with explicit slug
// ---------------------------------------------------------------------------

describe("createArticle with explicit slug", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("uses the explicit slug verbatim when provided and unique", async () => {
    const result = await service.createArticle({
      ...validCreateInput,
      slug: "custom-explicit-slug",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("custom-explicit-slug");
  });

  it("rejects explicit slug that collides with existing", async () => {
    await seedArticle(service, { title: "Existing Article" });
    // Existing slug is "existing-article"
    const result = await service.createArticle({
      ...validCreateInput,
      title: "Different Title",
      slug: "existing-article",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.ALREADY_EXISTS);
  });

  it("rejects explicit slug that fails ^[a-z0-9-]+$ validation", async () => {
    const result = await service.createArticle({
      ...validCreateInput,
      slug: "Has Spaces And CAPS",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("rejects explicit slug with underscores or special characters", async () => {
    const result = await service.createArticle({
      ...validCreateInput,
      slug: "has_underscores",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("falls back to auto-generation when slug omitted", async () => {
    const result = await service.createArticle({
      ...validCreateInput,
      title: "Some Specific Title",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("some-specific-title");
  });
});
