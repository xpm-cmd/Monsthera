import { describe, it, expect } from "vitest";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { ErrorCode } from "../../../src/core/errors.js";
import type { Logger } from "../../../src/core/logger.js";
import type { KnowledgeArticle } from "../../../src/knowledge/repository.js";

/**
 * H4 — input hygiene at the knowledge service boundary.
 *
 * The write-path Zod schemas used strip mode: any key the schema didn't
 * declare vanished silently. That hid one real capability (`sourcePath`,
 * accepted by the repo but stripped by the service), broke `batch_update`'s
 * documented parity with `update_article` (`add_tags`/`remove_tags` only
 * existed in the single-update MCP handler), and turned every caller typo
 * into a silent no-op. Policy (H4): expose with validation or reject with
 * an explicit ValidationError — never silence.
 */

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
  title: "Hygiene Article",
  category: "engineering",
  content: "Body.",
};

async function seed(
  service: KnowledgeService,
  overrides?: Record<string, unknown>,
): Promise<KnowledgeArticle> {
  const result = await service.createArticle({ ...validInput, ...overrides });
  if (!result.ok) throw new Error(`seed failed: ${result.error.message}`);
  return result.value;
}

describe("sourcePath flows through the service (was: silently stripped)", () => {
  it("createArticle persists sourcePath", async () => {
    const service = createService();

    const result = await service.createArticle({ ...validInput, sourcePath: "docs/import.md" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourcePath).toBe("docs/import.md");
  });

  it("updateArticle applies sourcePath", async () => {
    const service = createService();
    const article = await seed(service);

    const result = await service.updateArticle(article.id, { sourcePath: "docs/relinked.md" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourcePath).toBe("docs/relinked.md");
  });
});

describe("unknown keys are rejected, not stripped", () => {
  it("createArticle rejects an unknown key with VALIDATION_FAILED", async () => {
    const service = createService();

    const result = await service.createArticle({ ...validInput, sourcepath: "typo-case.md" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("createArticle rejects system-owned fields (createdAt) loudly", async () => {
    const service = createService();

    const result = await service.createArticle({ ...validInput, createdAt: "2020-01-01T00:00:00.000Z" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("updateArticle rejects an unknown key with VALIDATION_FAILED", async () => {
    const service = createService();
    const article = await seed(service);

    const result = await service.updateArticle(article.id, { contnet: "typo body" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});

describe("rename path forwards the full update (was: silent drop on real rename)", () => {
  it("a real rename applies extraFrontmatter from the same call", async () => {
    const service = createService();
    const article = await seed(service, { extraFrontmatter: { origin: "old" } });

    const result = await service.updateArticle(article.id, {
      new_slug: "renamed-hygiene-article",
      extraFrontmatter: { origin: "new", ticket: "H4-1" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("renamed-hygiene-article");
    expect(result.value.extraFrontmatter).toEqual({ origin: "new", ticket: "H4-1" });

    const reread = await service.getArticle(article.id);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.extraFrontmatter).toEqual({ origin: "new", ticket: "H4-1" });
  });

  it("a real rename applies sourcePath from the same call", async () => {
    const service = createService();
    const article = await seed(service);

    const result = await service.updateArticle(article.id, {
      new_slug: "renamed-with-source",
      sourcePath: "docs/moved.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourcePath).toBe("docs/moved.md");
  });
});

describe("tag deltas resolve at the service layer (batch parity with update_article)", () => {
  it("updateArticle merges add_tags/remove_tags against current tags", async () => {
    const service = createService();
    const article = await seed(service, { tags: ["keep", "drop"] });

    const result = await service.updateArticle(article.id, {
      add_tags: ["fresh"],
      remove_tags: ["drop"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tags).toEqual(["keep", "fresh"]);
  });

  it("updateArticle rejects tags combined with add_tags", async () => {
    const service = createService();
    const article = await seed(service, { tags: ["keep"] });

    const result = await service.updateArticle(article.id, {
      tags: ["replace"],
      add_tags: ["fresh"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("batchUpdateArticles applies per-item tag deltas", async () => {
    const service = createService();
    const a = await seed(service, { tags: ["alpha"] });
    const b = await seed(service, { title: "Second", tags: ["beta", "gone"] });

    const result = await service.batchUpdateArticles([
      { id: a.id, add_tags: ["plus"] },
      { id: b.id, remove_tags: ["gone"] },
    ]);

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    const aAfter = await service.getArticle(a.id);
    const bAfter = await service.getArticle(b.id);
    if (!aAfter.ok || !bAfter.ok) throw new Error("reread failed");
    expect(aAfter.value.tags).toEqual(["alpha", "plus"]);
    expect(bAfter.value.tags).toEqual(["beta"]);
  });
});
