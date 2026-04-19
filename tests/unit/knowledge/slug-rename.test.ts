import { describe, it, expect, vi } from "vitest";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { ErrorCode, StorageError } from "../../../src/core/errors.js";
import type { NotFoundError } from "../../../src/core/errors.js";
import { err } from "../../../src/core/result.js";
import type { Result } from "../../../src/core/result.js";
import type { Logger } from "../../../src/core/logger.js";
import type {
  KnowledgeArticle,
  WriteWithSlugInput,
} from "../../../src/knowledge/repository.js";
import type { WikiBookkeeper } from "../../../src/knowledge/wiki-bookkeeper.js";
import { slug as brandSlug } from "../../../src/core/types.js";

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

interface AppendLogCall {
  action: string;
  type: string;
  title: string;
  id?: string;
}

function createBookkeeper(): WikiBookkeeper & { calls: AppendLogCall[] } {
  const calls: AppendLogCall[] = [];
  const bk = {
    calls,
    async appendLog(action: string, type: string, title: string, id?: string): Promise<void> {
      calls.push({ action, type, title, id });
    },
    async rebuildIndex(): Promise<void> {
      // no-op
    },
  } as unknown as WikiBookkeeper & { calls: AppendLogCall[] };
  return bk;
}

interface ServiceCtx {
  service: KnowledgeService;
  repo: InMemoryKnowledgeArticleRepository;
  bookkeeper: WikiBookkeeper & { calls: AppendLogCall[] };
}

function createService(): ServiceCtx {
  const repo = new InMemoryKnowledgeArticleRepository();
  const bookkeeper = createBookkeeper();
  const service = new KnowledgeService({ knowledgeRepo: repo, logger: noopLogger, bookkeeper });
  return { service, repo, bookkeeper };
}

async function seed(
  service: KnowledgeService,
  overrides: Record<string, unknown>,
): Promise<KnowledgeArticle> {
  const result = await service.createArticle({
    title: overrides.title ?? "Default Title",
    category: overrides.category ?? "docs",
    content: overrides.content ?? "default body",
    ...overrides,
  });
  if (!result.ok) throw new Error(`seed failed: ${result.error.message}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("updateArticle with new_slug — rename target and referrers", () => {
  it("renames the target slug and fixes referrers' `references` arrays", async () => {
    const { service, repo } = createService();
    const target = await seed(service, { title: "Epigenetic Clocks", content: "body" });
    const referrer = await seed(service, {
      title: "Related Article",
      content: "neutral body",
      references: [target.slug as string],
    });
    const bystander = await seed(service, { title: "Bystander", content: "unrelated" });

    const result = await service.updateArticle(target.id, { new_slug: "dna-methylation-clocks" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("dna-methylation-clocks");

    const bySlugOld = await repo.findBySlug(brandSlug("epigenetic-clocks"));
    expect(bySlugOld.ok).toBe(false);
    const bySlugNew = await repo.findBySlug(brandSlug("dna-methylation-clocks"));
    expect(bySlugNew.ok).toBe(true);

    const referrerNow = await repo.findById(referrer.id);
    expect(referrerNow.ok).toBe(true);
    if (!referrerNow.ok) return;
    expect(referrerNow.value.references).toEqual(["dna-methylation-clocks"]);

    const bystanderNow = await repo.findById(bystander.id);
    expect(bystanderNow.ok).toBe(true);
    if (!bystanderNow.ok) return;
    expect(bystanderNow.value.references).toEqual([]);
    expect(bystanderNow.value.content).toBe("unrelated");
  });
});

// ---------------------------------------------------------------------------
// Collision error
// ---------------------------------------------------------------------------

describe("updateArticle with new_slug — collision", () => {
  it("returns ALREADY_EXISTS when new_slug is already taken by another article", async () => {
    const { service, repo } = createService();
    const target = await seed(service, { title: "Alpha", content: "a" });
    await seed(service, { title: "Beta", content: "b" });
    const before = await repo.findMany();
    if (!before.ok) throw new Error("loadMany failed");
    const bodies = new Map(before.value.map((a) => [a.id, a.content]));

    const result = await service.updateArticle(target.id, { new_slug: "beta" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.ALREADY_EXISTS);
    expect(result.error.message.toLowerCase()).toContain("preview_slug");

    const after = await repo.findMany();
    if (!after.ok) throw new Error("loadMany failed");
    for (const article of after.value) {
      expect(article.content).toBe(bodies.get(article.id));
    }
  });
});

// ---------------------------------------------------------------------------
// Not-found target
// ---------------------------------------------------------------------------

describe("updateArticle with new_slug — non-existent target", () => {
  it("returns NOT_FOUND when the target article does not exist", async () => {
    const { service } = createService();
    const result = await service.updateArticle("ghost-id", { new_slug: "whatever" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// No-op rename to same slug
// ---------------------------------------------------------------------------

describe("updateArticle with new_slug === existing slug", () => {
  it("applies other fields, leaves slug unchanged, does not error", async () => {
    const { service, repo } = createService();
    const target = await seed(service, { title: "Origin", content: "old" });

    const result = await service.updateArticle(target.id, {
      new_slug: target.slug as string,
      content: "new body",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe(target.slug);
    expect(result.value.content).toBe("new body");

    const bySlug = await repo.findBySlug(target.slug);
    expect(bySlug.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Opt-in body rewrite
// ---------------------------------------------------------------------------

describe("updateArticle with new_slug and rewrite_inline_wikilinks", () => {
  it("rewrites inline wikilinks in other bodies when rewrite_inline_wikilinks=true", async () => {
    const { service, repo } = createService();
    const target = await seed(service, { title: "Old Topic", content: "body" });
    const referrer = await seed(service, {
      title: "Has Body Link",
      content: `see [[${target.slug}]] and [[${target.slug}|named]] and [[${target.slug}#anchor]] here`,
    });

    const result = await service.updateArticle(target.id, {
      new_slug: "new-topic",
      rewrite_inline_wikilinks: true,
    });
    expect(result.ok).toBe(true);

    const referrerNow = await repo.findById(referrer.id);
    expect(referrerNow.ok).toBe(true);
    if (!referrerNow.ok) return;
    expect(referrerNow.value.content).toBe(
      "see [[new-topic]] and [[new-topic|named]] and [[new-topic#anchor]] here",
    );
  });

  it("does NOT rewrite inline wikilinks when rewrite_inline_wikilinks=false (default)", async () => {
    const { service, repo } = createService();
    const target = await seed(service, { title: "Old Topic", content: "body" });
    const originalBody = `see [[${target.slug}]] here`;
    const referrer = await seed(service, { title: "Body Only", content: originalBody });

    const result = await service.updateArticle(target.id, { new_slug: "new-topic" });
    expect(result.ok).toBe(true);

    const referrerNow = await repo.findById(referrer.id);
    expect(referrerNow.ok).toBe(true);
    if (!referrerNow.ok) return;
    expect(referrerNow.value.content).toBe(originalBody);
  });

  it("body-only referrers stay untouched when only rewrite_inline_wikilinks=false", async () => {
    const { service, repo } = createService();
    const target = await seed(service, { title: "Topic", content: "body" });
    const referrer = await seed(service, {
      title: "Body Only",
      content: `see [[${target.slug}]]`,
    });

    const result = await service.updateArticle(target.id, { new_slug: "renamed-topic" });
    expect(result.ok).toBe(true);

    const after = await repo.findById(referrer.id);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.content).toContain(`[[${target.slug}]]`);
    expect(after.value.content).not.toContain("[[renamed-topic]]");
  });
});

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

describe("updateArticle with new_slug — event log", () => {
  it("appends a rename entry with old and new slug and referrer count", async () => {
    const { service, bookkeeper } = createService();
    const target = await seed(service, { title: "Old", content: "body" });
    await seed(service, {
      title: "Ref A",
      content: "x",
      references: [target.slug as string],
    });
    await seed(service, {
      title: "Ref B",
      content: "y",
      references: [target.slug as string],
    });

    bookkeeper.calls.length = 0;
    const result = await service.updateArticle(target.id, { new_slug: "renamed" });
    expect(result.ok).toBe(true);

    const renameLog = bookkeeper.calls.find((c) => c.action === "rename");
    expect(renameLog).toBeDefined();
    expect(renameLog?.type).toBe("knowledge");
    expect(renameLog?.title).toContain("old");
    expect(renameLog?.title).toContain("renamed");
    expect(renameLog?.title).toContain("2");
    expect(renameLog?.id).toBe(target.id);
  });
});

// ---------------------------------------------------------------------------
// Transactional rollback
// ---------------------------------------------------------------------------

describe("updateArticle with new_slug — staged-write rollback", () => {
  it("restores pre-images on already-written entries when a later write fails", async () => {
    const repo = new InMemoryKnowledgeArticleRepository();
    const bookkeeper = createBookkeeper();
    const service = new KnowledgeService({ knowledgeRepo: repo, logger: noopLogger, bookkeeper });

    const target = await seed(service, { title: "Original", content: "target body" });
    const refA = await seed(service, {
      title: "Ref A",
      content: "A body",
      references: [target.slug as string],
    });
    const refB = await seed(service, {
      title: "Ref B",
      content: "B body",
      references: [target.slug as string],
    });
    const refC = await seed(service, {
      title: "Ref C",
      content: "C body",
      references: [target.slug as string],
    });

    const preImages = new Map<string, KnowledgeArticle>();
    for (const id of [target.id, refA.id, refB.id, refC.id]) {
      const r = await repo.findById(id);
      if (r.ok) preImages.set(id, r.value);
    }

    // Wrap writeWithSlug: succeed on the first 2 calls (target rename + refA),
    // fail on the 3rd (refB). Rollback should restore target + refA via
    // delegating to the original implementation on subsequent (restore) calls.
    let callCount = 0;
    const originalWrite = repo.writeWithSlug.bind(repo);
    const writeSpy = vi.fn<
      (id: string, input: WriteWithSlugInput) => Promise<Result<KnowledgeArticle, NotFoundError | StorageError>>
    >(async (id, input) => {
      callCount++;
      if (callCount === 3) {
        return err(new StorageError("injected write failure on 3rd call"));
      }
      return originalWrite(id, input);
    });
    repo.writeWithSlug = writeSpy;

    const result = await service.updateArticle(target.id, { new_slug: "renamed-slug" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.STORAGE_ERROR);

    const targetAfter = await repo.findById(target.id);
    expect(targetAfter.ok).toBe(true);
    if (!targetAfter.ok) return;
    expect(targetAfter.value.slug).toBe(preImages.get(target.id)!.slug);

    const refAAfter = await repo.findById(refA.id);
    expect(refAAfter.ok).toBe(true);
    if (!refAAfter.ok) return;
    expect(refAAfter.value.references).toEqual([...preImages.get(refA.id)!.references]);

    const refBAfter = await repo.findById(refB.id);
    expect(refBAfter.ok).toBe(true);
    if (!refBAfter.ok) return;
    expect(refBAfter.value.references).toEqual([...preImages.get(refB.id)!.references]);
  });
});
