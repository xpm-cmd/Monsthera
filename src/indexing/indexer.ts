import { createHash } from "node:crypto";
import { type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, and, sql } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import * as tables from "../db/schema.js";
import { getHead, getAllTrackedFiles, getFileContent, getChangedFilesSinceCommit } from "../git/operations.js";
import { detectLanguage } from "../git/language.js";
import { parseFile, isParserAvailable } from "./parser.js";
import { generateSummary, generateRawSummary, generateMarkdownSummary } from "./summary.js";
import { scanForSecrets, isSensitiveFile, type SecretPattern } from "../trust/secret-patterns.js";
import type { SemanticReranker } from "../search/semantic.js";
import { buildEmbeddingText, type EmbeddingTextOptions } from "../search/semantic.js";
import {
  buildRepoAgentSearchSummary,
  buildRepoAgentSymbols,
  isRepoAgentManifestPath,
  parseRepoAgentManifest,
} from "../repo-agents/catalog.js";
import { loadCustomWorkflows } from "../workflows/loader.js";

export interface IndexOptions {
  repoPath: string;
  repoId: number;
  db: BetterSQLite3Database<typeof schema>;
  sensitiveFilePatterns?: string[];
  secretPatterns?: SecretPattern[];
  excludePatterns?: string[];
  onProgress?: (msg: string) => void;
  semanticReranker?: SemanticReranker | null;
}

/** Check if a file should be excluded from indexing (binary assets, lock files, etc.) */
function isExcludedFile(filePath: string, patterns: string[] = []): boolean {
  const fileName = filePath.split("/").pop() ?? "";
  return patterns.some((pattern) => {
    if (pattern.startsWith("*.")) {
      // Extension match: "*.png" → endsWith ".png"
      return fileName.endsWith(pattern.slice(1));
    }
    // Exact filename match: "package-lock.json"
    return fileName === pattern;
  });
}

export interface IndexResult {
  commit: string;
  filesIndexed: number;
  filesSkipped: number;
  errors: Array<{ path: string; error: string }>;
  durationMs: number;
}

export async function fullIndex(opts: IndexOptions): Promise<IndexResult> {
  const start = Date.now();
  const { repoPath, repoId, db, onProgress } = opts;
  const errors: Array<{ path: string; error: string }> = [];

  const commit = await getHead({ cwd: repoPath });
  onProgress?.(`Indexing at commit ${commit.slice(0, 7)}`);

  const trackedFiles = await getAllTrackedFiles(commit, { cwd: repoPath });
  onProgress?.(`Found ${trackedFiles.length} tracked files`);

  let filesIndexed = 0;
  let filesSkipped = 0;

  // Clear existing records — imports first (FK → files.id)
  db.delete(tables.imports).run();
  db.delete(tables.files).where(eq(tables.files.repoId, repoId)).run();

  for (const filePath of trackedFiles) {
    try {
      const result = await indexSingleFile(filePath, commit, opts);
      if (result === "skipped") {
        filesSkipped++;
      } else {
        filesIndexed++;
      }
    } catch (err) {
      errors.push({ path: filePath, error: err instanceof Error ? err.message : String(err) });
      filesSkipped++;
    }
  }

  await validateCustomWorkflows(repoPath, onProgress);

  // Update index state
  const now = new Date().toISOString();
  const lastError = errors.length > 0
    ? errors.map(e => `${e.path}: ${e.error}`).join('; ').slice(0, 1000)
    : null;
  const existing = db.select().from(tables.indexState).where(eq(tables.indexState.repoId, repoId)).get();

  if (existing) {
    db.update(tables.indexState)
      .set({
        dbIndexedCommit: commit,
        indexedAt: now,
        ...(errors.length === 0 ? { lastSuccess: now } : {}),
        lastError,
      })
      .where(eq(tables.indexState.repoId, repoId))
      .run();
  } else {
    db.insert(tables.indexState)
      .values({
        repoId,
        dbIndexedCommit: commit,
        indexedAt: now,
        ...(errors.length === 0 ? { lastSuccess: now } : {}),
        lastError,
      })
      .run();
  }

  onProgress?.(`Indexed ${filesIndexed} files, skipped ${filesSkipped}, ${errors.length} errors`);

  return {
    commit,
    filesIndexed,
    filesSkipped,
    errors,
    durationMs: Date.now() - start,
  };
}

export async function incrementalIndex(lastCommit: string, opts: IndexOptions): Promise<IndexResult> {
  const start = Date.now();
  const { repoPath, repoId, db, onProgress } = opts;
  const errors: Array<{ path: string; error: string }> = [];

  // Fix 2: Validate SHA format before any git calls
  if (!/^[0-9a-f]{40}$/i.test(lastCommit)) {
    onProgress?.(`Invalid commit SHA format, falling back to full index`);
    return fullIndex(opts);
  }

  const currentHead = await getHead({ cwd: repoPath });
  if (currentHead === lastCommit) {
    return { commit: currentHead, filesIndexed: 0, filesSkipped: 0, errors: [], durationMs: Date.now() - start };
  }

  // Fix 1: Catch bad commit ref and fall back to full index
  let changedFiles;
  try {
    changedFiles = await getChangedFilesSinceCommit(lastCommit, { cwd: repoPath });
  } catch {
    onProgress?.(`Bad ref ${lastCommit.slice(0, 7)}, falling back to full index`);
    return fullIndex(opts);
  }
  onProgress?.(`${changedFiles.length} files changed since ${lastCommit.slice(0, 7)}`);

  let filesIndexed = 0;
  let filesSkipped = 0;

  // Wrap all DB writes in a single transaction for atomicity and batched fsync.
  // Async parsing (tree-sitter) happens in-memory; DB ops are sync (better-sqlite3).
  db.run(sql`BEGIN IMMEDIATE`);
  try {
    for (const change of changedFiles) {
      // Helper: delete a file and its imports (imports FK → files.id)
      const deleteFileByPath = () => {
        const existing = db.select({ id: tables.files.id }).from(tables.files)
          .where(and(eq(tables.files.repoId, repoId), eq(tables.files.path, change.path)))
          .get();
        if (existing) {
          db.delete(tables.imports).where(eq(tables.imports.sourceFileId, existing.id)).run();
          db.delete(tables.files).where(eq(tables.files.id, existing.id)).run();
        }
      };

      if (change.status === "D") {
        deleteFileByPath();
        filesIndexed++;
        continue;
      }

      try {
        // Delete old record and re-index
        deleteFileByPath();

        const result = await indexSingleFile(change.path, currentHead, opts);
        if (result === "skipped") {
          filesSkipped++;
        } else {
          filesIndexed++;
        }
      } catch (err) {
        errors.push({ path: change.path, error: err instanceof Error ? err.message : String(err) });
        filesSkipped++;
      }
    }

    await validateCustomWorkflows(repoPath, onProgress);

    // Update index state
    const now = new Date().toISOString();
    const lastError = errors.length > 0
      ? errors.map(e => `${e.path}: ${e.error}`).join('; ').slice(0, 1000)
      : null;
    db.update(tables.indexState)
      .set({
        dbIndexedCommit: currentHead,
        indexedAt: now,
        ...(errors.length === 0 ? { lastSuccess: now } : {}),
        lastError,
      })
      .where(eq(tables.indexState.repoId, repoId))
      .run();

    db.run(sql`COMMIT`);
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }

  return {
    commit: currentHead,
    filesIndexed,
    filesSkipped,
    errors,
    durationMs: Date.now() - start,
  };
}

async function validateCustomWorkflows(
  repoPath: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  try {
    const result = await loadCustomWorkflows(repoPath);
    if (result.workflows.length > 0) {
      onProgress?.(`Validated ${result.workflows.length} custom workflows`);
    }
    for (const warning of result.warnings) {
      onProgress?.(`Workflow warning (${warning.filePath}): ${warning.message}`);
    }
  } catch (error) {
    onProgress?.(`Workflow validation skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function indexSingleFile(
  filePath: string,
  commit: string,
  opts: IndexOptions,
): Promise<"indexed" | "skipped"> {
  const { repoPath, repoId, db, sensitiveFilePatterns, excludePatterns } = opts;

  // Skip excluded files (binary assets, lock files, etc.) — don't index at all
  if (isExcludedFile(filePath, excludePatterns)) {
    return "skipped";
  }

  // Check if sensitive file — index path only, no content
  if (isSensitiveFile(filePath, sensitiveFilePatterns)) {
    db.insert(tables.files)
      .values({
        repoId,
        path: filePath,
        language: null,
        contentHash: null,
        summary: "Sensitive file — path indexed only",
        symbolsJson: "[]",
        hasSecrets: true,
        secretLineRanges: "[]",
        indexedAt: new Date().toISOString(),
        commitSha: commit,
      })
      .run();
    return "indexed";
  }

  const content = await getFileContent(filePath, commit, { cwd: repoPath });
  if (content === null) return "skipped";

  const contentHash = createHash("sha256").update(content).digest("hex");
  const language = detectLanguage(filePath);

  // Scan for secrets
  const secretHits = scanForSecrets(content, opts.secretPatterns);
  const hasSecrets = secretHits.length > 0;
  const secretLineRanges = hasSecrets
    ? JSON.stringify(secretHits.map((h) => ({ line: h.line, pattern: h.pattern })))
    : "[]";

  let summary: string;
  let symbolsJson = "[]";

  if (language && (await isParserAvailable(language))) {
    try {
      const parseResult = await parseFile(content, language);
      summary = generateSummary(filePath, parseResult);
      symbolsJson = JSON.stringify(parseResult.symbols);

      // Insert file
      const fileRecord = db
        .insert(tables.files)
        .values({
          repoId,
          path: filePath,
          language,
          contentHash,
          summary,
          symbolsJson,
          hasSecrets,
          secretLineRanges,
          indexedAt: new Date().toISOString(),
          commitSha: commit,
        })
        .returning()
        .get();

      // Insert imports
      for (const imp of parseResult.imports) {
        db.insert(tables.imports)
          .values({
            sourceFileId: fileRecord.id,
            targetPath: imp.source,
            kind: imp.kind,
          })
          .run();
      }

      // Generate semantic embedding if available
      await maybeEmbed(opts, fileRecord.id, {
        path: filePath,
        language,
        summary,
        symbolsJson,
        imports: parseResult.imports.map((i) => i.source),
        leadingComment: parseResult.leadingComment,
      });

      return "indexed";
    } catch (err) {
      // Tree-sitter parse failed — log and fall through to raw indexing
      opts.onProgress?.(`⚠ Parse failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      summary = generateRawSummary(filePath, content);
    }
  } else {
    // Markdown-specific summary: extract headings + body text for FTS5
    const ext = filePath.slice(filePath.lastIndexOf("."));
    if (ext === ".md" && isRepoAgentManifestPath(filePath)) {
      const parsedManifest = parseRepoAgentManifest(filePath, content);
      for (const warning of parsedManifest.warnings) {
        opts.onProgress?.(`⚠ Repo agent manifest ${warning.filePath}: ${warning.message}`);
      }

      if (parsedManifest.agent) {
        summary = buildRepoAgentSearchSummary(parsedManifest.agent);
        symbolsJson = JSON.stringify(buildRepoAgentSymbols(parsedManifest.agent));
      } else {
        const mdResult = generateMarkdownSummary(filePath, content);
        summary = mdResult.summary;
        if (mdResult.headings.length > 0) {
          symbolsJson = JSON.stringify(
            mdResult.headings.map((h) => ({ name: h, kind: "heading" })),
          );
        }
      }
    } else if (ext === ".md" || ext === ".mdx") {
      const mdResult = generateMarkdownSummary(filePath, content);
      summary = mdResult.summary;
      // Treat headings as "symbols" — they get BM25 weight 2.0 (highest priority)
      if (mdResult.headings.length > 0) {
        symbolsJson = JSON.stringify(
          mdResult.headings.map((h) => ({ name: h, kind: "heading" })),
        );
      }
    } else {
      summary = generateRawSummary(filePath, content);
    }
  }

  // Raw fallback path — needs .returning().get() for embedding
  const fileRecord = db.insert(tables.files)
    .values({
      repoId,
      path: filePath,
      language,
      contentHash,
      summary,
      symbolsJson,
      hasSecrets,
      secretLineRanges,
      indexedAt: new Date().toISOString(),
      commitSha: commit,
    })
    .returning()
    .get();

  await maybeEmbed(opts, fileRecord.id, {
    path: filePath,
    language,
    summary,
    symbolsJson,
    // No imports or leading comment for raw fallback path
  });

  return "indexed";
}

async function maybeEmbed(
  opts: IndexOptions,
  fileId: number,
  embeddingOpts: EmbeddingTextOptions,
): Promise<void> {
  if (!opts.semanticReranker?.isAvailable()) return;
  try {
    const text = buildEmbeddingText(embeddingOpts);
    const embedding = await opts.semanticReranker.embed(text);
    if (embedding) {
      opts.semanticReranker.storeEmbedding(fileId, embedding);
    }
  } catch {
    // Non-fatal: file is indexed but without embedding
  }
}

/**
 * Build IndexOptions from a common context shape.
 * Deduplicates the IndexOptions construction used in index-tools, read-tools, and the CLI.
 */
export function buildIndexOptions(ctx: {
  db: BetterSQLite3Database<typeof schema>;
  repoId: number;
  repoPath: string;
  sensitiveFilePatterns?: string[];
  secretPatterns?: SecretPattern[];
  excludePatterns?: string[];
  onProgress?: (msg: string) => void;
  semanticReranker?: IndexOptions["semanticReranker"];
}): IndexOptions {
  return {
    repoPath: ctx.repoPath,
    repoId: ctx.repoId,
    db: ctx.db,
    sensitiveFilePatterns: ctx.sensitiveFilePatterns,
    secretPatterns: ctx.secretPatterns,
    excludePatterns: ctx.excludePatterns,
    onProgress: ctx.onProgress,
    semanticReranker: ctx.semanticReranker,
  };
}

export function getIndexedCommit(
  db: BetterSQLite3Database<typeof schema>,
  repoId: number,
): string | null {
  const state = db.select().from(tables.indexState).where(eq(tables.indexState.repoId, repoId)).get();
  return state?.dbIndexedCommit ?? null;
}
