import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { AlreadyExistsError, NotFoundError, StorageError, ValidationError } from "../core/errors.js";
import { withFileLock } from "../core/file-lock.js";
import { generateArticleId, articleId, slug, timestamp } from "../core/types.js";
import type { ArticleId, Slug, Timestamp } from "../core/types.js";
import { parseMarkdown, serializeMarkdown, serializeFrontmatterValue, patchFrontmatter } from "./markdown.js";
import { uniqueSlug } from "./slug.js";
import { validateFrontmatter } from "./schemas.js";
import { StatCachedDirectoryReader } from "../core/stat-cache.js";
import type {
  KnowledgeArticle,
  KnowledgeArticleRepository,
  CreateKnowledgeArticleInput,
  UpdateKnowledgeArticleInput,
  WriteWithSlugInput,
} from "./repository.js";

/** Standard frontmatter keys recognised by `ArticleFrontmatterSchema`. */
const KNOWN_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "slug",
  "category",
  "tags",
  "codeRefs",
  "references",
  "sourcePath",
  "createdAt",
  "updatedAt",
]);

/**
 * Extract non-standard keys from parsed YAML frontmatter so they survive the
 * read→domain→write round-trip. Returns undefined when there are no extras,
 * so `extraFrontmatter` stays absent on articles that don't use it.
 */
function extractExtraFrontmatter(
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {};
  let hasAny = false;
  for (const [key, value] of Object.entries(raw)) {
    if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
    extras[key] = value;
    hasAny = true;
  }
  return hasAny ? extras : undefined;
}

/**
 * Build the ordered frontmatter map written for an article. Shared by the full
 * serialize path (`writeArticle`) and the minimal-diff path (`update`) so both
 * agree on exactly which keys exist and how each value serializes — the patcher
 * compares against this to decide which lines changed.
 */
function buildArticleFrontmatter(article: KnowledgeArticle): Record<string, unknown> {
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    category: article.category,
    tags: [...article.tags],
    codeRefs: [...article.codeRefs],
    references: [...article.references],
    ...(article.sourcePath ? { sourcePath: article.sourcePath } : {}),
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    ...(article.extraFrontmatter ?? {}),
  };
}

/**
 * Defensive copy handed out by the cached read path. Cached articles are
 * shared across calls; today's callers never mutate results in place, but
 * the pre-cache contract was "fresh objects every read" and this keeps it:
 * a caller poking a returned array can never poison the cache.
 */
function cloneArticle(article: KnowledgeArticle): KnowledgeArticle {
  return {
    ...article,
    tags: [...article.tags],
    codeRefs: [...article.codeRefs],
    references: [...article.references],
    ...(article.extraFrontmatter ? { extraFrontmatter: { ...article.extraFrontmatter } } : {}),
  };
}

/**
 * Worktree fallback (added 2026-05-16):
 *
 * When constructed with `fallbackMarkdownRoot` (the main repo's
 * knowledge dir, resolved via `git rev-parse --git-common-dir`),
 * `loadAll()` merges articles from the primary `notes/` AND the
 * fallback `notes/`. Primary wins on slug or id collisions. Writes go
 * ONLY to primary — articles authored in a worktree stay on that
 * worktree's feature branch until it merges.
 *
 * The fallback is the cross-worktree visibility layer the cognitive
 * handoff sessions feature depends on: `monsthera knowledge get
 * handoff-ses-X` should find the article whether the handoff was
 * generated in the current worktree or another. Beyond handoffs, it
 * also surfaces shared knowledge across feature branches — a side
 * benefit, not the primary purpose.
 */
export class FileSystemKnowledgeArticleRepository implements KnowledgeArticleRepository {
  /**
   * H1: in-process parse cache revalidated by a stat sweep per operation.
   * Other PROCESSES (CLI beside the MCP server, Option-A corpora dropping
   * files straight into notes/) are detected by the stat check; our own
   * writes invalidate explicitly. Covers primary and fallback dirs alike
   * (entries are keyed by absolute path).
   */
  private readonly dirCache = new StatCachedDirectoryReader<KnowledgeArticle>(
    (filePath) => this.readFromPath(filePath),
    { entityLabel: "knowledge articles" },
  );

  constructor(
    private readonly markdownRoot: string,
    private readonly fallbackMarkdownRoot: string | null = null,
  ) {}

  private get notesDir(): string {
    return path.join(this.markdownRoot, "notes");
  }

  private get fallbackNotesDir(): string | null {
    return this.fallbackMarkdownRoot === null
      ? null
      : path.join(this.fallbackMarkdownRoot, "notes");
  }

  private articlePath(slugValue: string): string {
    return path.join(this.notesDir, `${slugValue}.md`);
  }

  /**
   * Where writes (and the lock) for an existing article should land.
   * Prefers the runtime `filePath` observed at read time — externally
   * authored corpora name files by id, not slug — resolved against the
   * PRIMARY root only: writes never target the worktree fallback.
   * Articles without one (fresh creates, in-memory constructions) use
   * the canonical slug-named path.
   */
  private resolveWritePath(article: Pick<KnowledgeArticle, "slug" | "filePath">): string {
    return article.filePath
      ? path.join(this.markdownRoot, article.filePath)
      : this.articlePath(article.slug);
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.notesDir, { recursive: true });
  }

  /**
   * Express an absolute article path relative to its owning markdown root
   * (primary first, then the worktree fallback), using forward slashes so
   * the value is directly usable as a markdown link target (e.g.
   * `notes/k-91-some-note.md`). Runtime metadata only — see
   * `KnowledgeArticle.filePath`; `buildArticleFrontmatter` deliberately
   * never serializes it.
   */
  private relativeArticlePath(absolutePath: string): string {
    const roots = this.fallbackMarkdownRoot === null
      ? [this.markdownRoot]
      : [this.markdownRoot, this.fallbackMarkdownRoot];
    for (const root of roots) {
      const rel = path.relative(root, absolutePath);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join("/");
      }
    }
    return path.relative(this.markdownRoot, absolutePath).split(path.sep).join("/");
  }

  private async readFromPath(filePath: string): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return err(new NotFoundError("KnowledgeArticle", path.basename(filePath, ".md")));
      }
      return err(new StorageError(`Failed to read knowledge article: ${filePath}`, { cause: String(error) }));
    }

    const parsed = parseMarkdown(raw);
    if (!parsed.ok) {
      return err(new StorageError(`Failed to parse knowledge article markdown: ${filePath}`, { cause: parsed.error.message }));
    }

    const frontmatter = validateFrontmatter(parsed.value.frontmatter);
    if (!frontmatter.ok) {
      return err(new StorageError(`Invalid knowledge article frontmatter: ${filePath}`, { cause: frontmatter.error.message }));
    }

    const extras = extractExtraFrontmatter(parsed.value.frontmatter);

    return ok({
      id: articleId(frontmatter.value.id),
      title: frontmatter.value.title,
      slug: slug(frontmatter.value.slug),
      category: frontmatter.value.category,
      tags: frontmatter.value.tags,
      codeRefs: frontmatter.value.codeRefs,
      references: frontmatter.value.references,
      sourcePath: frontmatter.value.sourcePath,
      createdAt: timestamp(frontmatter.value.createdAt),
      updatedAt: timestamp(frontmatter.value.updatedAt),
      content: parsed.value.body,
      ...(extras ? { extraFrontmatter: extras } : {}),
      filePath: this.relativeArticlePath(filePath),
    });
  }

  private async loadAllFromDir(dir: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    // Missing-directory and per-file error semantics live in the reader and
    // match the pre-cache behavior: ENOENT dir reads as empty, a vanished
    // file is skipped, a corrupt file aborts the load and is never cached.
    const articles = await this.dirCache.readDir(dir);
    if (!articles.ok) return articles;
    return ok(articles.value.map(cloneArticle));
  }

  private async loadAll(): Promise<Result<KnowledgeArticle[], StorageError>> {
    await this.ensureDirectory();

    const primary = await this.loadAllFromDir(this.notesDir);
    if (!primary.ok) return primary;

    if (this.fallbackNotesDir === null) return primary;

    // Aggregate primary + fallback. Primary wins on collisions (id OR
    // slug match) so the worktree's view of an article takes precedence
    // over the main repo's older copy. Soft-fail on fallback errors:
    // a missing or unreadable fallback dir is not a primary failure.
    const fallback = await this.loadAllFromDir(this.fallbackNotesDir);
    if (!fallback.ok) return primary;

    const seenIds = new Set(primary.value.map((a) => a.id));
    const seenSlugs = new Set(primary.value.map((a) => a.slug));
    const merged: KnowledgeArticle[] = [...primary.value];
    for (const article of fallback.value) {
      if (seenIds.has(article.id) || seenSlugs.has(article.slug)) continue;
      seenIds.add(article.id);
      seenSlugs.add(article.slug);
      merged.push(article);
    }
    return ok(merged);
  }

  private async writeArticle(
    article: KnowledgeArticle,
    previousSlug?: Slug,
  ): Promise<Result<KnowledgeArticle, AlreadyExistsError | StorageError>> {
    await this.ensureDirectory();

    const frontmatter = buildArticleFrontmatter(article);

    // A rename lands at the canonical slug-named path (the old file name
    // embedded the old slug); an in-place write goes back to the file the
    // article was read from, so ID-named files are rewritten, never
    // duplicated.
    const isRename = previousSlug !== undefined && previousSlug !== article.slug;
    const targetPath = isRename ? this.articlePath(article.slug) : this.resolveWritePath(article);
    const serialized = serializeMarkdown(frontmatter, article.content);
    // A target slug different from `previousSlug` (or no previousSlug at
    // all, which is the create path) means we expect the destination
    // file NOT to exist yet. Use O_EXCL via the `wx` flag so the kernel
    // refuses the write atomically if a concurrent caller raced us to
    // the same slug — this closes the slug TOCTOU between `loadAll()`
    // and `writeFile`.
    const exclusive = !previousSlug || isRename;

    try {
      if (exclusive) {
        const handle = await fs.open(targetPath, "wx");
        try {
          await handle.writeFile(serialized, "utf-8");
        } finally {
          await handle.close();
        }
      } else {
        await fs.writeFile(targetPath, serialized, "utf-8");
      }
      if (isRename) {
        // Remove the OLD file at its real location (ID-named files do
        // not live at notes/<previousSlug>.md).
        const previousPath = article.filePath
          ? path.join(this.markdownRoot, article.filePath)
          : this.articlePath(previousSlug);
        await fs.rm(previousPath, { force: true });
        this.dirCache.invalidate(previousPath);
      }
      this.dirCache.invalidate(targetPath);
      // Refresh the runtime filePath so a rename does not leak the OLD
      // file's location.
      return ok({ ...article, filePath: this.relativeArticlePath(targetPath) });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        return err(
          new AlreadyExistsError("KnowledgeArticle", article.slug),
        );
      }
      // The write may have landed partially; never let the cache shadow it.
      this.dirCache.invalidate(targetPath);
      return err(new StorageError(`Failed to write knowledge article: ${article.id}`, { cause: String(error) }));
    }
  }

  /**
   * Minimal-diff write for the in-place update path (slug unchanged). Reads the
   * current on-disk bytes and rewrites ONLY the frontmatter lines whose value
   * actually changed (plus `updatedAt`), leaving every other line — quoted
   * titles, custom fields, original formatting — and the body byte-identical.
   *
   * Returns `null` to tell the caller to fall back to a full `writeArticle`
   * when a minimal patch isn't safe or applicable:
   *   - the slug changed (a rename writes a new file; full serialize is right),
   *   - the file isn't readable here (e.g. it lives only in the worktree
   *     fallback dir, so there's nothing to patch in primary),
   *   - it doesn't parse, or the BODY changed (the body is written verbatim, so
   *     a content edit is not a frontmatter diff), or
   *   - `patchFrontmatter` declines (block-style / external-shaped frontmatter).
   */
  private async tryMinimalDiffWrite(
    article: KnowledgeArticle,
    previousSlug: Slug,
  ): Promise<Result<KnowledgeArticle, StorageError> | null> {
    if (previousSlug !== article.slug) return null;

    const targetPath = this.resolveWritePath(article);
    let raw: string;
    try {
      raw = await fs.readFile(targetPath, "utf-8");
    } catch {
      return null;
    }

    const parsed = parseMarkdown(raw);
    if (!parsed.ok) return null;
    if (parsed.value.body !== article.content) return null;

    const onDisk = parsed.value.frontmatter;
    const next = buildArticleFrontmatter(article);

    const changes: Record<string, string> = {};
    for (const [key, value] of Object.entries(next)) {
      const nextSerialized = serializeFrontmatterValue(value);
      const hadKey = Object.prototype.hasOwnProperty.call(onDisk, key);
      const diskSerialized = hadKey ? serializeFrontmatterValue(onDisk[key]) : undefined;
      if (nextSerialized !== diskSerialized) changes[key] = nextSerialized;
    }
    // `update` always advances updatedAt; force the line even if the serialized
    // string happens to match (e.g. sub-millisecond updates).
    changes["updatedAt"] = serializeFrontmatterValue(next["updatedAt"]);

    const patched = patchFrontmatter(raw, changes);
    if (patched === null) return null;

    try {
      await fs.writeFile(targetPath, patched, "utf-8");
      this.dirCache.invalidate(targetPath);
      return ok(article);
    } catch (error) {
      this.dirCache.invalidate(targetPath);
      return err(new StorageError(`Failed to write knowledge article: ${article.id}`, { cause: String(error) }));
    }
  }

  async findById(id: string): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    const article = allResult.value.find((candidate) => candidate.id === id);
    if (!article) return err(new NotFoundError("KnowledgeArticle", id));
    return ok(article);
  }

  async findMany(_filter?: Record<string, unknown>): Promise<Result<KnowledgeArticle[], StorageError>> {
    return this.loadAll();
  }

  async findUpdatedSince(timestamp: Timestamp): Promise<Result<KnowledgeArticle[], StorageError>> {
    // loadAll is stat-cached (H1), so this is a stat sweep + in-memory
    // filter — the per-call full re-parse this used to flag is gone.
    const all = await this.loadAll();
    if (!all.ok) return all;
    return ok(all.value.filter((a) => a.updatedAt >= timestamp));
  }

  async create(input: CreateKnowledgeArticleInput): Promise<Result<KnowledgeArticle, ValidationError | StorageError>> {
    // Two-attempt loop: a parallel create that races us on the same slug
    // (`loadAll()` returns stale data, both pick the same free slug, both
    // call writeArticle) is detected atomically by the EEXIST flag in
    // writeArticle. We retry once with a fresh `loadAll()` so the second
    // call computes a slug that observes the first writer's file. If
    // even the retry collides (extremely unlikely — would need a third
    // racing creator with the same title), the operator gets a clear
    // ValidationError instead of a silent overwrite.
    for (let attempt = 0; attempt < 2; attempt++) {
      const allResult = await this.loadAll();
      if (!allResult.ok) return allResult;

      const existingSlugs = new Set(allResult.value.map((article) => article.slug));
      const requestedSlug = input.slug;
      const articleSlug = requestedSlug && !existingSlugs.has(requestedSlug)
        ? requestedSlug
        : uniqueSlug(input.title, existingSlugs);
      const createdAt = timestamp(input.createdAt);
      const updatedAt = timestamp(input.updatedAt ?? input.createdAt);

      const article: KnowledgeArticle = {
        id: (input.id ?? generateArticleId()) as ArticleId,
        title: input.title,
        slug: articleSlug,
        category: input.category,
        content: input.content,
        tags: input.tags ?? [],
        codeRefs: input.codeRefs ?? [],
        references: input.references ?? [],
        sourcePath: input.sourcePath,
        createdAt,
        updatedAt,
        ...(input.extraFrontmatter ? { extraFrontmatter: { ...input.extraFrontmatter } } : {}),
      };

      const result = await this.writeArticle(article);
      if (result.ok) return result;
      if (result.error instanceof AlreadyExistsError && attempt === 0) {
        // Race lost; retry with a fresh slug view.
        continue;
      }
      if (result.error instanceof AlreadyExistsError) {
        return err(
          new ValidationError(
            `Knowledge article slug "${article.slug}" already exists after retry; refusing to overwrite`,
            { slug: article.slug, id: article.id },
          ),
        );
      }
      return result;
    }
    /* istanbul ignore next — loop above always returns within 2 iterations */
    return err(new StorageError("Knowledge create exceeded retry budget"));
  }

  async update(
    id: string,
    input: UpdateKnowledgeArticleInput,
  ): Promise<Result<KnowledgeArticle, NotFoundError | ValidationError | StorageError>> {
    // Read once outside the lock just to discover the current slug — the
    // lock is keyed on the article's filesystem path, so we need to know
    // which path to lock. We re-read inside the lock to get a consistent
    // view of the article state in the presence of concurrent writers.
    const lookup = await this.findById(id);
    if (!lookup.ok) return lookup;

    // Lock the file the article actually lives in — keying on the
    // slug-derived path would lock (and O_CREAT-touch!) a phantom file
    // for ID-named articles.
    return withFileLock(this.resolveWritePath(lookup.value), async () => {
      const existingResult = await this.findById(id);
      if (!existingResult.ok) return existingResult;

      const existing = existingResult.value;
      let nextSlug = existing.slug;

      if (input.title !== undefined && input.title !== existing.title) {
        const allResult = await this.loadAll();
        if (!allResult.ok) return allResult;
        const existingSlugs = new Set(
          allResult.value
            .filter((article) => article.id !== id)
            .map((article) => article.slug),
        );
        nextSlug = uniqueSlug(input.title, existingSlugs);
      }

      const updated: KnowledgeArticle = {
        ...existing,
        title: input.title ?? existing.title,
        slug: nextSlug,
        category: input.category ?? existing.category,
        content: input.content ?? existing.content,
        tags: input.tags ?? existing.tags,
        codeRefs: input.codeRefs ?? existing.codeRefs,
        references: input.references ?? existing.references,
        sourcePath: input.sourcePath ?? existing.sourcePath,
        ...(input.extraFrontmatter !== undefined
          ? { extraFrontmatter: { ...input.extraFrontmatter } }
          : existing.extraFrontmatter
            ? { extraFrontmatter: existing.extraFrontmatter }
            : {}),
        updatedAt: timestamp(),
      };

      // Prefer a minimal-diff patch (rewrites only the changed frontmatter
      // lines + updatedAt); fall back to a full serialize when that isn't safe.
      const minimal = await this.tryMinimalDiffWrite(updated, existing.slug);
      if (minimal !== null) return minimal;
      return this.writeArticle(updated, existing.slug);
    });
  }

  async writeWithSlug(
    id: string,
    input: WriteWithSlugInput,
  ): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    const existingResult = await this.findById(id);
    if (!existingResult.ok) return existingResult;

    const existing = existingResult.value;

    const updated: KnowledgeArticle = {
      ...existing,
      title: input.title ?? existing.title,
      slug: input.slug ?? existing.slug,
      category: input.category ?? existing.category,
      content: input.content ?? existing.content,
      tags: input.tags ?? existing.tags,
      codeRefs: input.codeRefs ?? existing.codeRefs,
      references: input.references ?? existing.references,
      updatedAt: timestamp(),
    };

    return this.writeArticle(updated, existing.slug);
  }

  async delete(id: string): Promise<Result<void, NotFoundError | StorageError>> {
    const existingResult = await this.findById(id);
    if (!existingResult.ok) return existingResult;

    const deletedPath = this.resolveWritePath(existingResult.value);
    try {
      await fs.rm(deletedPath, { force: true });
      this.dirCache.invalidate(deletedPath);
      return ok(undefined);
    } catch (error) {
      return err(new StorageError(`Failed to delete knowledge article: ${id}`, { cause: String(error) }));
    }
  }

  async exists(id: string): Promise<boolean> {
    const result = await this.findById(id);
    return result.ok;
  }

  async findBySlug(slugValue: Slug): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    // Frontmatter `slug:` is the single read-path identity. The old
    // path-derived fast path (read `notes/<slug>.md` directly) existed
    // because the scan re-parsed the whole corpus; with the stat cache the
    // scan is a stat sweep, and the fast path's only remaining effect was
    // letting a file whose NAME diverges from its frontmatter slug resolve
    // under two identities. `loadAll` merges primary + worktree fallback
    // with primary-wins semantics, so visibility rules are unchanged.
    const all = await this.loadAll();
    if (!all.ok) return all;
    const match = all.value.find((article) => article.slug === slugValue);
    if (match) return ok(match);

    return err(new NotFoundError("KnowledgeArticle", `slug:${slugValue}`));
  }

  async findByCategory(category: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    const normalized = category.toLowerCase();
    return ok(allResult.value.filter((article) => article.category.toLowerCase() === normalized));
  }

  async findByTag(tag: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    return ok(allResult.value.filter((article) => article.tags.includes(tag)));
  }

  async search(query: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    const normalized = query.toLowerCase();
    return ok(
      allResult.value.filter((article) =>
        article.title.toLowerCase().includes(normalized) ||
        article.content.toLowerCase().includes(normalized) ||
        article.category.toLowerCase().includes(normalized) ||
        article.tags.some((tag) => tag.toLowerCase().includes(normalized)),
      ),
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
