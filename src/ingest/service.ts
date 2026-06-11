import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Stats } from "node:fs";
import { NotFoundError, StorageError } from "../core/errors.js";
import type { ValidationError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { err, ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { StatusReporter } from "../core/status.js";
import { slug, timestamp } from "../core/types.js";
import type { KnowledgeArticleRepository, KnowledgeArticle } from "../knowledge/repository.js";
import { parseMarkdown } from "../knowledge/markdown.js";
import { ORIGIN } from "../knowledge/provenance.js";
import type { SearchMutationSync } from "../search/sync.js";
import { realCommandRunner } from "../ops/command-runner.js";
import type { CommandRunner } from "../ops/command-runner.js";
import { listCommitsInRange, listCommitFiles } from "../sessions/facts-extractor-git.js";
import type { SessionFactsCommit } from "../sessions/schemas.js";
import { validateIngestLocalInput, validateIngestGitInput, validateIngestPrInput } from "./schemas.js";
import type { IngestMode } from "./schemas.js";

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", ".monsthera"]);
const PATH_REF_RE = /\b(?:README\.md|package\.json|tsconfig\.json|pnpm-lock\.yaml|\.gitignore|(?:src|public|tests|scripts|docs|knowledge)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|md|sh|yml|yaml))\b/g;

export interface IngestedKnowledgeItem {
  readonly sourcePath: string;
  readonly articleId: string;
  readonly slug: string;
  readonly title: string;
  readonly category: string;
  readonly status: "created" | "updated";
  readonly tagCount: number;
  readonly codeRefCount: number;
}

export interface IngestBatchResult {
  readonly importedAt: string;
  readonly sourcePath: string;
  readonly mode: IngestMode;
  readonly scannedFileCount: number;
  readonly importedCount: number;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly items: readonly IngestedKnowledgeItem[];
}

export interface IngestServiceDeps {
  readonly knowledgeRepo: KnowledgeArticleRepository;
  readonly repoPath: string;
  readonly logger: Logger;
  readonly searchSync?: SearchMutationSync;
  readonly status?: StatusReporter;
  /** Injectable git runner (PR-15). Defaults to the real shell-backed runner; tests stub it. */
  readonly commandRunner?: CommandRunner;
}

const GIT_INGEST_TIMEOUT_MS = 10_000;

/** Cap per-commit codeRefs so a monster sweep commit cannot bloat an article. */
const MAX_COMMIT_CODE_REFS = 20;

export class IngestService {
  private readonly knowledgeRepo: KnowledgeArticleRepository;
  private readonly repoPath: string;
  private readonly logger: Logger;
  private readonly searchSync?: SearchMutationSync;
  private readonly status?: StatusReporter;
  private readonly commandRunner: CommandRunner;

  constructor(deps: IngestServiceDeps) {
    this.knowledgeRepo = deps.knowledgeRepo;
    this.repoPath = deps.repoPath;
    this.logger = deps.logger.child({ domain: "ingest" });
    this.searchSync = deps.searchSync;
    this.status = deps.status;
    this.commandRunner = deps.commandRunner ?? realCommandRunner;
  }

  async importLocal(
    input: unknown,
  ): Promise<Result<IngestBatchResult, ValidationError | NotFoundError | StorageError>> {
    const validated = validateIngestLocalInput(input);
    if (!validated.ok) return validated;

    const targetPath = this.resolveInputPath(validated.value.sourcePath);
    const statResult = await this.statPath(targetPath);
    if (!statResult.ok) return statResult;

    const sourceFiles = statResult.value.isDirectory()
      ? await this.collectDirectoryFiles(targetPath, validated.value.recursive)
      : [targetPath];

    if (sourceFiles.length === 0) {
      return ok({
        importedAt: timestamp(),
        sourcePath: this.normalizeSourcePath(targetPath),
        mode: validated.value.mode,
        scannedFileCount: 0,
        importedCount: 0,
        createdCount: 0,
        updatedCount: 0,
        items: [],
      });
    }

    const knowledgeResult = await this.knowledgeRepo.findMany();
    if (!knowledgeResult.ok) return knowledgeResult;
    const existingBySourcePath = new Map(
      knowledgeResult.value
        .filter((article) => article.sourcePath)
        .map((article) => [article.sourcePath!, article]),
    );

    const importedAt = timestamp();
    const items: IngestedKnowledgeItem[] = [];
    let createdCount = 0;
    let updatedCount = 0;

    for (const filePath of sourceFiles) {
      const normalizedSourcePath = this.normalizeSourcePath(filePath);
      const readResult = await this.readSourceFile(filePath);
      if (!readResult.ok) return readResult;

      const parsed = await this.buildKnowledgeInput(
        filePath,
        normalizedSourcePath,
        readResult.value,
        validated.value.category,
        validated.value.tags,
        validated.value.codeRefs,
        validated.value.mode,
        validated.value.noImportedTag,
      );
      const existing = validated.value.replaceExisting ? existingBySourcePath.get(normalizedSourcePath) : undefined;

      if (existing) {
        const updated = await this.knowledgeRepo.update(existing.id, {
          title: parsed.title,
          category: parsed.category,
          content: parsed.content,
          tags: parsed.tags,
          codeRefs: parsed.codeRefs,
          sourcePath: normalizedSourcePath,
        });
        if (!updated.ok) return updated;

        existingBySourcePath.set(normalizedSourcePath, updated.value);
        await this.syncIndexedArticle(updated.value.id);
        updatedCount += 1;
        items.push({
          sourcePath: normalizedSourcePath,
          articleId: updated.value.id,
          slug: updated.value.slug,
          title: updated.value.title,
          category: updated.value.category,
          status: "updated",
          tagCount: updated.value.tags.length,
          codeRefCount: updated.value.codeRefs.length,
        });
        continue;
      }

      const created = await this.knowledgeRepo.create({
        title: parsed.title,
        category: parsed.category,
        content: parsed.content,
        tags: parsed.tags,
        codeRefs: parsed.codeRefs,
        sourcePath: normalizedSourcePath,
      });
      if (!created.ok) return created;

      existingBySourcePath.set(normalizedSourcePath, created.value);
      await this.syncIndexedArticle(created.value.id);
      createdCount += 1;
      items.push({
        sourcePath: normalizedSourcePath,
        articleId: created.value.id,
        slug: created.value.slug,
        title: created.value.title,
        category: created.value.category,
        status: "created",
        tagCount: created.value.tags.length,
        codeRefCount: created.value.codeRefs.length,
      });
    }

    await this.refreshCounts(importedAt);
    this.logger.info("Completed local ingest", {
      sourcePath: this.normalizeSourcePath(targetPath),
      scannedFileCount: sourceFiles.length,
      createdCount,
      updatedCount,
    });

    return ok({
      importedAt,
      sourcePath: this.normalizeSourcePath(targetPath),
      mode: validated.value.mode,
      scannedFileCount: sourceFiles.length,
      importedCount: items.length,
      createdCount,
      updatedCount,
      items,
    });
  }

  /**
   * Ingest the commits in a git revision range (PR-15) as one knowledge article
   * per commit, each tagged `ingested`/`git` with provenance `origin: ingested`
   * (PR-13) and `sourcePath: git:<sha>`. Idempotent via the sourcePath dedup —
   * re-ingesting a range updates rather than duplicates. A git failure (e.g. a
   * bad range) surfaces as an error rather than an empty import.
   */
  async importGitHistory(
    input: unknown,
  ): Promise<Result<IngestBatchResult, ValidationError | NotFoundError | StorageError>> {
    const validated = validateIngestGitInput(input);
    if (!validated.ok) return validated;

    const commits = await listCommitsInRange({
      repo: this.repoPath,
      range: validated.value.range,
      runner: this.commandRunner,
      timeoutMs: GIT_INGEST_TIMEOUT_MS,
    });
    if (!commits.ok) return commits;

    return this.ingestCommits(commits.value, validated.value.range, {
      category: validated.value.category,
      tags: validated.value.tags,
      replaceExisting: validated.value.replaceExisting,
    });
  }

  /**
   * Ingest a merged GitHub pull request (PR-15) by resolving its merge commit
   * ("Merge pull request #N …") and ingesting the commit range
   * `<merge>^1..<merge>^2`. Limitation: only PRs landed as GitHub merge commits
   * are resolvable (squash/rebase merges leave no such marker).
   */
  async importPr(
    input: unknown,
  ): Promise<Result<IngestBatchResult, ValidationError | NotFoundError | StorageError>> {
    const validated = validateIngestPrInput(input);
    if (!validated.ok) return validated;
    const prNumber = validated.value.prNumber;

    const mergeResult = await this.commandRunner({
      command: "git",
      args: ["log", "--all", `--grep=Merge pull request #${prNumber} `, "--format=%H", "-1"],
      cwd: this.repoPath,
      timeoutMs: GIT_INGEST_TIMEOUT_MS,
    });
    if (!mergeResult.ok) return err(mergeResult.error);
    const mergeSha = mergeResult.value.stdout.trim();
    if (mergeSha === "") {
      return err(new NotFoundError("PullRequestMergeCommit", `#${prNumber}`));
    }

    const range = `${mergeSha}^1..${mergeSha}^2`;
    const commits = await listCommitsInRange({
      repo: this.repoPath,
      range,
      runner: this.commandRunner,
      timeoutMs: GIT_INGEST_TIMEOUT_MS,
    });
    if (!commits.ok) return commits;

    return this.ingestCommits(commits.value, range, {
      category: validated.value.category,
      tags: [...validated.value.tags, `pr-${prNumber}`],
      replaceExisting: validated.value.replaceExisting,
    });
  }

  /** Shared commit→article ingestion used by importGitHistory and importPr. */
  private async ingestCommits(
    commits: readonly SessionFactsCommit[],
    range: string,
    opts: { category?: string; tags: readonly string[]; replaceExisting: boolean },
  ): Promise<Result<IngestBatchResult, NotFoundError | StorageError>> {
    const importedAt = timestamp();
    if (commits.length === 0) {
      return ok({
        importedAt,
        sourcePath: range,
        mode: "raw",
        scannedFileCount: 0,
        importedCount: 0,
        createdCount: 0,
        updatedCount: 0,
        items: [],
      });
    }

    const knowledgeResult = await this.knowledgeRepo.findMany();
    if (!knowledgeResult.ok) return knowledgeResult;
    const existingBySourcePath = new Map(
      knowledgeResult.value
        .filter((article) => article.sourcePath)
        .map((article) => [article.sourcePath!, article]),
    );

    const category = opts.category ?? "git-history";
    const tags = dedupeStrings([...opts.tags, "ingested", "git"]);
    const items: IngestedKnowledgeItem[] = [];
    let createdCount = 0;
    let updatedCount = 0;

    for (const commit of commits) {
      const sourcePath = `git:${commit.sha}`;
      const title = truncateCommitTitle(commit.subject);
      const content = buildCommitContent(commit, range);
      // F5 (deferred from PR-15): the commit's changed files become codeRefs,
      // capped for monster commits. Fail-open — file listing is enrichment,
      // and a git failure here must not sink the ingest.
      const filesResult = await listCommitFiles({
        repo: this.repoPath,
        sha: commit.sha,
        runner: this.commandRunner,
        timeoutMs: GIT_INGEST_TIMEOUT_MS,
      });
      const codeRefs = filesResult.ok
        ? filesResult.value.slice(0, MAX_COMMIT_CODE_REFS)
        : [];
      const existing = opts.replaceExisting ? existingBySourcePath.get(sourcePath) : undefined;

      if (existing) {
        const updated = await this.knowledgeRepo.update(existing.id, {
          title,
          category,
          content,
          tags: [...tags],
          codeRefs: [...codeRefs],
          sourcePath,
          extraFrontmatter: { origin: ORIGIN.INGESTED },
        });
        if (!updated.ok) return updated;
        existingBySourcePath.set(sourcePath, updated.value);
        await this.syncIndexedArticle(updated.value.id);
        updatedCount += 1;
        items.push(toIngestedItem(updated.value, "updated"));
        continue;
      }

      const created = await this.knowledgeRepo.create({
        title,
        slug: slug(`git-${commit.sha}`),
        category,
        content,
        tags: [...tags],
        codeRefs: [...codeRefs],
        sourcePath,
        extraFrontmatter: { origin: ORIGIN.INGESTED },
      });
      if (!created.ok) return created;
      existingBySourcePath.set(sourcePath, created.value);
      await this.syncIndexedArticle(created.value.id);
      createdCount += 1;
      items.push(toIngestedItem(created.value, "created"));
    }

    await this.refreshCounts(importedAt);
    this.logger.info("Completed git ingest", { range, scannedFileCount: commits.length, createdCount, updatedCount });

    return ok({
      importedAt,
      sourcePath: range,
      mode: "raw",
      scannedFileCount: commits.length,
      importedCount: items.length,
      createdCount,
      updatedCount,
      items,
    });
  }

  private resolveInputPath(sourcePath: string): string {
    return path.isAbsolute(sourcePath)
      ? path.resolve(sourcePath)
      : path.resolve(this.repoPath, sourcePath);
  }

  private normalizeSourcePath(sourcePath: string): string {
    const relative = path.relative(this.repoPath, sourcePath);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }
    return sourcePath.split(path.sep).join("/");
  }

  private async statPath(filePath: string): Promise<Result<Stats, NotFoundError | StorageError>> {
    try {
      return ok(await fs.stat(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return err(new NotFoundError("SourcePath", filePath));
      }
      return err(new StorageError(`Failed to inspect ingest path: ${filePath}`, { cause: String(error) }));
    }
  }

  private async collectDirectoryFiles(directoryPath: string, recursive: boolean): Promise<string[]> {
    const results: string[] = [];
    const visit = async (currentPath: string): Promise<void> => {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (!recursive) continue;
          if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
          const normalized = this.normalizeSourcePath(fullPath);
          if (normalized === "knowledge" || normalized.startsWith("knowledge/")) continue;
          await visit(fullPath);
          continue;
        }

        if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          results.push(fullPath);
        }
      }
    };

    await visit(directoryPath);
    return results.sort((left, right) => left.localeCompare(right));
  }

  private async readSourceFile(filePath: string): Promise<Result<string, StorageError>> {
    try {
      return ok(await fs.readFile(filePath, "utf-8"));
    } catch (error) {
      return err(new StorageError(`Failed to read ingest source: ${filePath}`, { cause: String(error) }));
    }
  }

  private async buildKnowledgeInput(
    filePath: string,
    sourcePath: string,
    raw: string,
    categoryOverride: string | undefined,
    tagOverrides: readonly string[],
    codeRefOverrides: readonly string[],
    mode: IngestMode,
    noImportedTag: boolean,
  ): Promise<{
    title: string;
    category: string;
    content: string;
    tags: string[];
    codeRefs: string[];
  }> {
    const frontmatter = this.parseSourceFrontmatter(raw);
    const content = frontmatter.body.trim() || raw.trim();
    const title = firstNonEmptyString(
      stringValue(frontmatter.data.title),
      extractFirstHeading(content),
      humanizeStem(path.basename(filePath, path.extname(filePath))),
    );
    const category = firstNonEmptyString(
      categoryOverride,
      stringValue(frontmatter.data.category),
      inferCategory(sourcePath),
      "imported",
    );
    const tags = dedupeStrings([
      ...tagOverrides,
      ...arrayValue(frontmatter.data.tags),
      ...(mode === "summary" ? ["summary"] : []),
      ...(noImportedTag ? [] : ["imported"]),
    ]);
    const codeRefs = dedupeStrings([
      ...codeRefOverrides,
      ...arrayValue(frontmatter.data.codeRefs),
      ...(await this.extractExistingCodeRefs(content)),
    ]);
    const normalizedContent = mode === "summary"
      ? buildSummaryContent({ title, sourcePath, content, codeRefs })
      : content;

    return {
      title,
      category,
      content: normalizedContent,
      tags,
      codeRefs,
    };
  }

  private parseSourceFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
    const parsed = parseMarkdown(raw);
    if (!parsed.ok) {
      return { data: {}, body: raw };
    }
    return {
      data: parsed.value.frontmatter,
      body: parsed.value.body,
    };
  }

  private async extractExistingCodeRefs(content: string): Promise<string[]> {
    const matches = content.match(PATH_REF_RE) ?? [];
    const unique = [...new Set(matches)];
    const existence = await Promise.all(unique.map(async (candidate) => ({
      candidate,
      exists: await this.pathExists(path.resolve(this.repoPath, candidate)),
    })));
    return existence.filter((entry) => entry.exists).map((entry) => entry.candidate);
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async syncIndexedArticle(id: string): Promise<void> {
    if (!this.searchSync) return;
    const syncResult = await this.searchSync.indexKnowledgeArticle(id);
    if (!syncResult.ok) {
      this.logger.warn("Imported article indexed with warnings", {
        operation: "indexKnowledgeArticle",
        id,
        error: syncResult.error.message,
      });
    }
  }

  private async refreshCounts(importedAt: string): Promise<void> {
    if (!this.status) return;
    const countResult = await this.knowledgeRepo.findMany();
    if (countResult.ok) {
      this.status.recordStat("knowledgeArticleCount", countResult.value.length);
    }
    this.status.recordStat("lastIngestAt", importedAt);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function firstNonEmptyString(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim()) return value.trim();
  }
  return "Untitled";
}

function extractFirstHeading(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function humanizeStem(stem: string): string {
  return stem
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Untitled";
}

function inferCategory(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/");
  const [root] = normalized.split("/");
  if (!root) return "imported";
  return root.toLowerCase();
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function truncateCommitTitle(subject: string): string {
  const title = subject.trim() || "Untitled commit";
  return title.length <= 200 ? title : `${title.slice(0, 199).trimEnd()}…`;
}

function buildCommitContent(commit: SessionFactsCommit, range: string): string {
  return [
    `## Commit \`${commit.sha.slice(0, 12)}\``,
    "",
    `- **SHA:** \`${commit.sha}\``,
    `- **Date:** ${commit.timestamp}`,
    `- **Subject:** ${commit.subject}`,
    "",
    `Ingested from git history (range \`${range}\`).`,
    "",
  ].join("\n");
}

function toIngestedItem(article: KnowledgeArticle, status: "created" | "updated"): IngestedKnowledgeItem {
  return {
    sourcePath: article.sourcePath ?? "",
    articleId: article.id,
    slug: article.slug,
    title: article.title,
    category: article.category,
    status,
    tagCount: article.tags.length,
    codeRefCount: article.codeRefs.length,
  };
}

function buildSummaryContent(input: {
  title: string;
  sourcePath: string;
  content: string;
  codeRefs: readonly string[];
}): string {
  const { title, sourcePath, content, codeRefs } = input;
  const summary = extractSummaryParagraph(content);
  const keyPoints = extractKeyPoints(content, 5);
  const headings = extractHeadings(content, title, 6);
  const sections: string[] = [
    "## Source",
    `- Path: \`${sourcePath}\``,
    "- Import mode: `summary`",
    "",
    "## Summary",
    summary,
  ];

  if (keyPoints.length > 0) {
    sections.push("", "## Key points", ...keyPoints.map((point) => `- ${point}`));
  }

  if (headings.length > 0) {
    sections.push("", "## Important headings", ...headings.map((heading) => `- ${heading}`));
  }

  if (codeRefs.length > 0) {
    sections.push("", "## Code references", ...codeRefs.map((ref) => `- \`${ref}\``));
  }

  sections.push(
    "",
    "## Import note",
    "This article was normalized from a local source to make the important context easier to browse and index inside Monsthera.",
  );

  return sections.join("\n").trim();
}

function extractSummaryParagraph(content: string): string {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => chunk.replace(/^#+\s+/gm, "").trim())
    .filter((chunk) => !chunk.startsWith("- ") && !chunk.startsWith("* "));

  for (const paragraph of paragraphs) {
    const plain = normalizeWhitespace(stripMarkdown(paragraph));
    if (plain.length >= 40) {
      return truncateText(plain, 420);
    }
  }

  const fallback = normalizeWhitespace(stripMarkdown(content));
  return fallback ? truncateText(fallback, 420) : "No summary available from the imported source.";
}

function extractKeyPoints(content: string, limit: number): string[] {
  const bullets = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean)
    .filter((line) => line.length >= 10)
    .filter((line, index, values) => values.indexOf(line) === index);

  if (bullets.length > 0) {
    return bullets.slice(0, limit).map((line) => truncateText(normalizeWhitespace(stripMarkdown(line)), 160));
  }

  const sentences = normalizeWhitespace(stripMarkdown(content))
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20);

  return sentences.slice(0, Math.min(limit, 3)).map((sentence) => truncateText(sentence, 160));
}

function extractHeadings(content: string, title: string, limit: number): string[] {
  const normalizedTitle = normalizeWhitespace(stripMarkdown(title)).toLowerCase();
  const headings = content
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .map((heading) => normalizeWhitespace(stripMarkdown(heading)))
    .filter(Boolean)
    .filter((heading, index, values) => values.indexOf(heading) === index)
    .filter((heading) => heading.toLowerCase() !== normalizedTitle);

  return headings.slice(0, limit);
}

function stripMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[*_>#-]/g, " ");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
