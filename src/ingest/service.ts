import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Stats } from "node:fs";
import { NotFoundError, StorageError } from "../core/errors.js";
import type { ValidationError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { err, ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { StatusReporter } from "../core/status.js";
import { timestamp } from "../core/types.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import { parseMarkdown } from "../knowledge/markdown.js";
import type { SearchMutationSync } from "../search/sync.js";
import { validateIngestLocalInput } from "./schemas.js";
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
}

export class IngestService {
  private readonly knowledgeRepo: KnowledgeArticleRepository;
  private readonly repoPath: string;
  private readonly logger: Logger;
  private readonly searchSync?: SearchMutationSync;
  private readonly status?: StatusReporter;

  constructor(deps: IngestServiceDeps) {
    this.knowledgeRepo = deps.knowledgeRepo;
    this.repoPath = deps.repoPath;
    this.logger = deps.logger.child({ domain: "ingest" });
    this.searchSync = deps.searchSync;
    this.status = deps.status;
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
