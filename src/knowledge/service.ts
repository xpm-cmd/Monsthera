import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import type { NotFoundError, StorageError, ValidationError, AlreadyExistsError } from "../core/errors.js";
import { AlreadyExistsError as AlreadyExistsErrorClass, ValidationError as ValidationErrorClass, StorageError as StorageErrorClass } from "../core/errors.js";
import { slug as brandSlug } from "../core/types.js";
import type { Logger } from "../core/logger.js";
import type { StatusReporter } from "../core/status.js";
import type { KnowledgeArticle, KnowledgeArticleRepository } from "./repository.js";
import type { SearchMutationSync } from "../search/sync.js";
import type { WikiBookkeeper } from "./wiki-bookkeeper.js";
import { validateCreateInput, validateUpdateInput } from "./schemas.js";
import { toSlug } from "./slug.js";
import { nearMissConflicts } from "./slug-conflict.js";
import { extractWikilinks, rewriteWikilinkSlug } from "../structure/wikilink.js";

export interface KnowledgeServiceDeps {
  knowledgeRepo: KnowledgeArticleRepository;
  logger: Logger;
  searchSync?: SearchMutationSync;
  status?: StatusReporter;
  bookkeeper?: WikiBookkeeper;
}

/** Per-item result for batch article operations. */
export type BatchArticleItem =
  | { index: number; ok: true; article: KnowledgeArticle }
  | { index: number; ok: false; error: { code: string; message: string } };

/** Aggregate result for batch article operations. */
export interface BatchArticleResult {
  total: number;
  succeeded: number;
  failed: number;
  items: BatchArticleItem[];
}

/**
 * Extract the required string `id` from a batch_update entry and return the
 * remaining fields as update input. Keeps the dispatcher small and the
 * service code readable.
 */
function extractBatchUpdateId(
  raw: unknown,
): Result<{ id: string; rest: Record<string, unknown> }, ValidationError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(new ValidationErrorClass("Batch update entry must be an object"));
  }
  const entry = raw as Record<string, unknown>;
  const id = entry.id;
  if (typeof id !== "string" || id.length === 0) {
    return err(new ValidationErrorClass('Batch update entry requires a non-empty "id" string'));
  }
  const { id: _discard, ...rest } = entry;
  return ok({ id, rest });
}

export class KnowledgeService {
  private readonly repo: KnowledgeArticleRepository;
  private readonly logger: Logger;
  private readonly searchSync?: SearchMutationSync;
  private readonly status?: StatusReporter;
  readonly bookkeeper?: WikiBookkeeper;

  constructor(deps: KnowledgeServiceDeps) {
    this.repo = deps.knowledgeRepo;
    this.logger = deps.logger.child({ domain: "knowledge" });
    this.searchSync = deps.searchSync;
    this.status = deps.status;
    this.bookkeeper = deps.bookkeeper;
  }

  async createArticle(
    input: unknown,
  ): Promise<Result<KnowledgeArticle, ValidationError | AlreadyExistsError | StorageError>> {
    const result = await this.createOneWithoutRebuild(input);
    if (result.ok) await this.rebuildIndex();
    return result;
  }

  /**
   * Per-item create that skips the global `index.md` rebuild. Used both by
   * the public `createArticle` (which rebuilds once after) and by
   * `batchCreateArticles` (which defers the rebuild until the whole batch
   * finishes, so a 100-article import does one rebuild instead of 100).
   */
  private async createOneWithoutRebuild(
    input: unknown,
  ): Promise<Result<KnowledgeArticle, ValidationError | AlreadyExistsError | StorageError>> {
    const validated = validateCreateInput(input);
    if (!validated.ok) return validated;

    // If an explicit slug was supplied, verify it does not collide with an existing article.
    // The schema has already enforced ^[a-z0-9-]+$, so we only need to check uniqueness here.
    if (validated.value.slug !== undefined) {
      const existing = await this.repo.findBySlug(brandSlug(validated.value.slug));
      if (existing.ok) {
        return err(
          new AlreadyExistsErrorClass(
            "KnowledgeArticle",
            `slug:${validated.value.slug} — call preview_slug first to pick an available slug`,
          ),
        );
      }
      if (existing.error.code !== "NOT_FOUND") {
        return err(existing.error);
      }
    }

    this.logger.info("Creating knowledge article", { operation: "createArticle", title: validated.value.title });
    const repoInput = {
      ...validated.value,
      slug: validated.value.slug !== undefined ? brandSlug(validated.value.slug) : undefined,
    };
    const result = await this.repo.create(repoInput);
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
      await this.refreshCounts();
      await this.bookkeeper?.appendLog("create", "knowledge", result.value.title, result.value.id);
    }
    return result;
  }

  /**
   * Preview the slug that would be generated for a given title.
   * Read-only — does not mutate state.
   *
   * Returns `{ slug, alreadyExists, conflicts }` where `conflicts` is a list of
   * near-miss slugs (Jaccard similarity >= 0.7 on hyphen-split tokens) that
   * sibling articles may have authored inline wikilinks against. An empty
   * array means no near-miss was found and the caller may proceed with
   * confidence.
   */
  async previewSlug(
    title: string,
  ): Promise<Result<{ slug: string; alreadyExists: boolean; conflicts: string[] }, StorageError>> {
    this.logger.debug("Previewing slug", { operation: "previewSlug", title });
    const target = toSlug(title);
    const all = await this.repo.findMany();
    if (!all.ok) return err(all.error);
    const existingSlugs = all.value.map((a) => a.slug as string);
    const alreadyExists = existingSlugs.includes(target);
    const conflicts = nearMissConflicts(target, existingSlugs);
    return ok({ slug: target as string, alreadyExists, conflicts });
  }

  async getArticle(
    id: string,
  ): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    this.logger.debug("Getting knowledge article", { operation: "getArticle", id });
    return this.repo.findById(id);
  }

  async getArticleBySlug(
    slugValue: string,
  ): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    this.logger.debug("Getting knowledge article by slug", { operation: "getArticleBySlug", slug: slugValue });
    return this.repo.findBySlug(brandSlug(slugValue));
  }

  async updateArticle(
    id: string,
    input: unknown,
  ): Promise<Result<KnowledgeArticle, NotFoundError | ValidationError | AlreadyExistsError | StorageError>> {
    const result = await this.updateOneWithoutRebuild(id, input);
    if (result.ok) await this.rebuildIndex();
    return result;
  }

  /**
   * Per-item update that skips the global `index.md` rebuild. The rename path
   * (`renameAndUpdate`) already rebuilds the index itself on success, so when
   * this method returns ok from a rename it is safe for callers to skip the
   * extra rebuild. Callers doing many updates in sequence (batch) should
   * perform a single rebuild after the loop completes.
   */
  private async updateOneWithoutRebuild(
    id: string,
    input: unknown,
  ): Promise<Result<KnowledgeArticle, NotFoundError | ValidationError | AlreadyExistsError | StorageError>> {
    const validated = validateUpdateInput(input);
    if (!validated.ok) return validated;

    const { new_slug, rewrite_inline_wikilinks, ...rest } = validated.value;

    if (new_slug === undefined) {
      this.logger.info("Updating knowledge article", { operation: "updateArticle", id });
      const result = await this.repo.update(id, rest);
      if (result.ok) {
        await this.syncIndexedArticle(result.value.id);
        await this.bookkeeper?.appendLog("update", "knowledge", result.value.title, result.value.id);
      }
      return result;
    }

    return this.renameAndUpdate(id, new_slug, rewrite_inline_wikilinks === true, rest);
  }

  /**
   * Best-effort bulk read. Resolves each id independently and preserves the
   * input order in the response — designed as the natural follow-up to
   * `build_context_pack` / `search`, where agents would otherwise call
   * `get_article` N times. Non-string entries fail per-item as
   * VALIDATION_FAILED rather than aborting the batch.
   */
  async batchGetArticles(ids: readonly unknown[]): Promise<BatchArticleResult> {
    const items: BatchArticleItem[] = [];
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      const raw = ids[i];
      if (typeof raw !== "string" || raw.length === 0) {
        items.push({
          index: i,
          ok: false,
          error: {
            code: "VALIDATION_FAILED",
            message: "Batch get entry must be a non-empty string id",
          },
        });
        failed++;
        continue;
      }
      const result = await this.repo.findById(raw);
      if (result.ok) {
        items.push({ index: i, ok: true, article: result.value });
        succeeded++;
      } else {
        items.push({
          index: i,
          ok: false,
          error: { code: result.error.code, message: result.error.message },
        });
        failed++;
      }
    }
    return { total: ids.length, succeeded, failed, items };
  }

  /**
   * Best-effort bulk create. Iterates `inputs` in order and captures per-item
   * successes and failures in the response. A single `rebuildIndex()` runs at
   * the end if at least one article was created, keeping `index.md` O(1)
   * regardless of batch size. Per-item errors (validation, slug collision,
   * storage) are surfaced alongside the index so callers can retry only the
   * offenders without replaying the successes.
   */
  async batchCreateArticles(
    inputs: readonly unknown[],
  ): Promise<BatchArticleResult> {
    const items: BatchArticleItem[] = [];
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < inputs.length; i++) {
      const result = await this.createOneWithoutRebuild(inputs[i]);
      if (result.ok) {
        items.push({ index: i, ok: true, article: result.value });
        succeeded++;
      } else {
        items.push({
          index: i,
          ok: false,
          error: { code: result.error.code, message: result.error.message },
        });
        failed++;
      }
    }
    if (succeeded > 0) await this.rebuildIndex();
    return { total: inputs.length, succeeded, failed, items };
  }

  /**
   * Best-effort bulk update. Each entry must have a string `id` and an
   * optional subset of update fields (including `new_slug` /
   * `rewrite_inline_wikilinks` for atomic renames). The shape is validated
   * per-item; entries missing `id` are reported as VALIDATION_FAILED without
   * aborting the batch.
   */
  async batchUpdateArticles(
    updates: readonly unknown[],
  ): Promise<BatchArticleResult> {
    const items: BatchArticleItem[] = [];
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < updates.length; i++) {
      const raw = updates[i];
      const idResult = extractBatchUpdateId(raw);
      if (!idResult.ok) {
        items.push({
          index: i,
          ok: false,
          error: { code: idResult.error.code, message: idResult.error.message },
        });
        failed++;
        continue;
      }
      const { id, rest } = idResult.value;
      const result = await this.updateOneWithoutRebuild(id, rest);
      if (result.ok) {
        items.push({ index: i, ok: true, article: result.value });
        succeeded++;
      } else {
        items.push({
          index: i,
          ok: false,
          error: { code: result.error.code, message: result.error.message },
        });
        failed++;
      }
    }
    if (succeeded > 0) await this.rebuildIndex();
    return { total: updates.length, succeeded, failed, items };
  }

  /**
   * Atomic-ish rename: change the target article's slug, update every other
   * article's `references` array that points at the old slug, and (opt-in)
   * rewrite `[[old-slug]]` / `[[old-slug|display]]` / `[[old-slug#anchor]]`
   * wikilinks in other articles' bodies.
   *
   * Transaction semantics — staged-write-with-rollback:
   *   1. Load target + every other article once at the start (pre-images).
   *   2. Validate: collision, self-rename no-op.
   *   3. Plan: build a list of per-article writes (target rename + referrer
   *      body/reference updates). Each plan entry carries the id, the new
   *      values to write, and the pre-image content/references/slug so we can
   *      roll it back byte-for-byte.
   *   4. Execute writes sequentially. On any failure, iterate the already-
   *      written entries in reverse and restore pre-images via writeWithSlug.
   *   5. If rollback itself fails for some entry, log warnings and continue —
   *      we cannot guarantee atomicity once the filesystem has rejected us,
   *      so surface the original error and leave best-effort state.
   *
   * Guarantees:
   *   - All-or-nothing under normal write failures.
   *   - On rollback-failure, partial state possible; logs clearly document.
   *
   * Non-goals:
   *   - Does not touch unrelated articles.
   *   - Does not retry transient failures — callers can re-invoke.
   */
  private async renameAndUpdate(
    id: string,
    newSlugRaw: string,
    rewriteInlineWikilinks: boolean,
    otherFields: Omit<import("./schemas.js").UpdateArticleInput, "new_slug" | "rewrite_inline_wikilinks">,
  ): Promise<Result<KnowledgeArticle, NotFoundError | ValidationError | AlreadyExistsError | StorageError>> {
    this.logger.info("Renaming knowledge article", {
      operation: "renameArticle",
      id,
      newSlug: newSlugRaw,
      rewriteInlineWikilinks,
    });

    // Load target.
    const targetResult = await this.repo.findById(id);
    if (!targetResult.ok) return targetResult;
    const target = targetResult.value;
    const oldSlug = target.slug as string;
    const newSlug = newSlugRaw;

    // Load the full corpus once — used for collision check and referrer scan.
    const allResult = await this.repo.findMany();
    if (!allResult.ok) return err(allResult.error);
    const others = allResult.value.filter((a) => a.id !== id);

    // Rename-to-same-slug: treat as no-op on the slug but still apply otherFields.
    if (oldSlug === newSlug) {
      const updateResult = await this.repo.update(id, otherFields);
      if (updateResult.ok) {
        await this.syncIndexedArticle(updateResult.value.id);
        await this.bookkeeper?.appendLog("update", "knowledge", updateResult.value.title, updateResult.value.id);
        await this.rebuildIndex();
      }
      return updateResult;
    }

    // Collision check: if any OTHER article owns the new slug, refuse.
    const collision = others.find((a) => (a.slug as string) === newSlug);
    if (collision) {
      return err(
        new AlreadyExistsErrorClass(
          "KnowledgeArticle",
          `slug:${newSlug} — call preview_slug first to pick an available slug`,
        ),
      );
    }

    // Build the plan.
    interface WritePlan {
      readonly articleId: string;
      readonly preImage: Readonly<{
        slug: string;
        content: string;
        references: readonly string[];
      }>;
      readonly next: { slug?: string; content?: string; references?: string[] };
    }
    const plan: WritePlan[] = [];

    // Plan[0] is always the target rename itself.
    const targetNext: WritePlan["next"] = {
      slug: newSlug,
    };
    if (otherFields.content !== undefined) targetNext.content = otherFields.content;
    if (otherFields.references !== undefined) targetNext.references = otherFields.references;
    plan.push({
      articleId: target.id,
      preImage: { slug: target.slug as string, content: target.content, references: [...target.references] },
      next: targetNext,
    });

    // Plan[1..] — referrer updates. One entry per affected article, combining
    // both references-array changes and (optional) body wikilink rewrites.
    for (const other of others) {
      const nextRefs: string[] | undefined = other.references.includes(oldSlug)
        ? other.references.map((r) => (r === oldSlug ? newSlug : r))
        : undefined;

      let nextContent: string | undefined;
      if (rewriteInlineWikilinks) {
        // Only bother calling rewriteWikilinkSlug if oldSlug actually appears
        // in a wikilink. We use extractWikilinks for a cheap pre-check that
        // respects code regions, then do the real rewrite on the raw content.
        const appearsInBody = extractWikilinks(other.content).some((w) => w.slug === oldSlug);
        if (appearsInBody) {
          const rewritten = rewriteWikilinkSlug(other.content, oldSlug, newSlug);
          if (rewritten.replacementCount > 0) {
            nextContent = rewritten.content;
          }
        }
      }

      if (nextRefs !== undefined || nextContent !== undefined) {
        plan.push({
          articleId: other.id,
          preImage: {
            slug: other.slug as string,
            content: other.content,
            references: [...other.references],
          },
          next: {
            ...(nextContent !== undefined ? { content: nextContent } : {}),
            ...(nextRefs !== undefined ? { references: nextRefs } : {}),
          },
        });
      }
    }

    // Execute plan sequentially, tracking how many entries succeeded so we
    // know which ones to roll back on failure.
    const applied: WritePlan[] = [];
    let renamedTarget: KnowledgeArticle | null = null;
    for (const entry of plan) {
      const writeResult = await this.repo.writeWithSlug(entry.articleId, {
        ...(entry.next.slug !== undefined ? { slug: brandSlug(entry.next.slug) } : {}),
        ...(entry.next.content !== undefined ? { content: entry.next.content } : {}),
        ...(entry.next.references !== undefined ? { references: entry.next.references } : {}),
        ...(entry.articleId === target.id && otherFields.title !== undefined ? { title: otherFields.title } : {}),
        ...(entry.articleId === target.id && otherFields.category !== undefined ? { category: otherFields.category } : {}),
        ...(entry.articleId === target.id && otherFields.tags !== undefined ? { tags: otherFields.tags } : {}),
        ...(entry.articleId === target.id && otherFields.codeRefs !== undefined ? { codeRefs: otherFields.codeRefs } : {}),
      });
      if (!writeResult.ok) {
        // Rollback already-applied entries in reverse order (best effort).
        this.logger.error("Rename write failed; rolling back staged writes", {
          operation: "renameArticle",
          failedArticleId: entry.articleId,
          appliedCount: applied.length,
          error: writeResult.error.message,
        });
        for (let i = applied.length - 1; i >= 0; i--) {
          const toRestore = applied[i]!;
          const restoreResult = await this.repo.writeWithSlug(toRestore.articleId, {
            slug: brandSlug(toRestore.preImage.slug),
            content: toRestore.preImage.content,
            references: [...toRestore.preImage.references],
          });
          if (!restoreResult.ok) {
            this.logger.warn("Rollback failed for article — manual intervention may be required", {
              operation: "renameArticle",
              articleId: toRestore.articleId,
              error: restoreResult.error.message,
            });
          }
        }
        return err(writeResult.error);
      }
      applied.push(entry);
      if (entry.articleId === target.id) {
        renamedTarget = writeResult.value;
      }
    }

    // All writes succeeded. Log + sync.
    if (!renamedTarget) {
      // Defensive — should be unreachable because plan[0] is always the target.
      return err(new StorageErrorClass(`Target article rename not recorded: ${id}`));
    }
    await this.syncIndexedArticle(renamedTarget.id);
    const affected = applied.length - 1; // excluding the target rename itself
    await this.bookkeeper?.appendLog(
      "rename",
      "knowledge",
      `${oldSlug} -> ${newSlug} (${affected} referrer${affected === 1 ? "" : "s"} updated)`,
      renamedTarget.id,
    );
    await this.rebuildIndex();
    return ok(renamedTarget);
  }

  async deleteArticle(
    id: string,
  ): Promise<Result<void, NotFoundError | StorageError>> {
    this.logger.info("Deleting knowledge article", { operation: "deleteArticle", id });
    // Capture title before deletion for log
    const existing = await this.repo.findById(id);
    const title = existing.ok ? existing.value.title : id;
    const result = await this.repo.delete(id);
    if (result.ok) {
      await this.removeIndexedArticle(id);
      await this.refreshCounts();
      await this.bookkeeper?.appendLog("delete", "knowledge", title, id);
      await this.rebuildIndex();
    }
    return result;
  }

  async listArticles(
    category?: string,
  ): Promise<Result<KnowledgeArticle[], StorageError>> {
    if (category) {
      this.logger.debug("Listing knowledge articles by category", { operation: "listArticles", category });
      return this.repo.findByCategory(category);
    }
    this.logger.debug("Listing all knowledge articles", { operation: "listArticles" });
    return this.repo.findMany();
  }

  async searchArticles(
    query: string,
  ): Promise<Result<KnowledgeArticle[], ValidationError | StorageError>> {
    if (!query.trim()) {
      return err(new ValidationErrorClass("Search query must not be empty"));
    }
    this.logger.debug("Searching knowledge articles", { operation: "searchArticles", query });
    return this.repo.search(query);
  }

  private async syncIndexedArticle(id: string): Promise<void> {
    if (!this.searchSync) return;
    const syncResult = await this.searchSync.indexKnowledgeArticle(id);
    if (!syncResult.ok) {
      this.logger.warn("Knowledge article indexed with warnings", {
        operation: "indexKnowledgeArticle",
        id,
        error: syncResult.error.message,
      });
    }
  }

  private async removeIndexedArticle(id: string): Promise<void> {
    if (!this.searchSync) return;
    const syncResult = await this.searchSync.removeArticle(id);
    if (!syncResult.ok) {
      this.logger.warn("Knowledge article removal not reflected in search index", {
        operation: "removeKnowledgeArticleFromIndex",
        id,
        error: syncResult.error.message,
      });
    }
  }

  private async refreshCounts(): Promise<void> {
    if (!this.status) return;
    const countResult = await this.repo.findMany();
    if (countResult.ok) {
      this.status.recordStat("knowledgeArticleCount", countResult.value.length);
    }
  }

  /** Rebuild index.md from current articles. Requires workRepo via bookkeeper. */
  private async rebuildIndex(): Promise<void> {
    if (!this.bookkeeper || !this._workRepoRef) return;
    const knowledge = await this.repo.findMany();
    if (!knowledge.ok) return;
    const work = await this._workRepoRef.findMany();
    if (!work.ok) return;
    await this.bookkeeper.rebuildIndex(knowledge.value, work.value);
  }

  /** Set by container after both services are created. */
  private _workRepoRef?: { findMany(): Promise<import("../core/result.js").Result<import("../work/repository.js").WorkArticle[], import("../core/errors.js").StorageError>> };
  setWorkRepo(workRepo: typeof this._workRepoRef): void {
    this._workRepoRef = workRepo;
  }
}
