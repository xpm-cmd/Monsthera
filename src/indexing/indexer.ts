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

  // Phase 1: Clear existing records in a short transaction (fast, write lock held briefly)
  db.run(sql`BEGIN IMMEDIATE`);
  try {
    db.delete(tables.codeChunks).run();
    db.delete(tables.imports).run();
    db.delete(tables.symbolReferences).run();
    db.delete(tables.files).where(eq(tables.files.repoId, repoId)).run();
    db.run(sql`COMMIT`);
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }

  // Phase 2: Index files — each indexSingleFile does its own synchronous DB writes.
  // No long-held transaction: individual inserts use SQLite's implicit transactions,
  // allowing other writers (tool handlers, coordination bus) to interleave.
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

  // Phase 3: Update index state in a short transaction
  db.run(sql`BEGIN IMMEDIATE`);
  try {
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

    db.run(sql`COMMIT`);
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
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

  // Helper: delete a file, its imports and chunks (FK → files.id)
  const deleteFileByPath = (path: string) => {
    const existing = db.select({ id: tables.files.id }).from(tables.files)
      .where(and(eq(tables.files.repoId, repoId), eq(tables.files.path, path)))
      .get();
    if (existing) {
      db.delete(tables.codeChunks).where(eq(tables.codeChunks.fileId, existing.id)).run();
      db.delete(tables.imports).where(eq(tables.imports.sourceFileId, existing.id)).run();
      db.delete(tables.symbolReferences).where(eq(tables.symbolReferences.sourceFileId, existing.id)).run();
      db.delete(tables.files).where(eq(tables.files.id, existing.id)).run();
    }
  };

  // Per-file delete+reindex without holding a long transaction.
  // Each file's DB ops are sync (better-sqlite3) and use implicit transactions.
  for (const change of changedFiles) {
    if (change.status === "D") {
      deleteFileByPath(change.path);
      filesIndexed++;
      continue;
    }

    try {
      deleteFileByPath(change.path);
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

  // Update index state in a short transaction
  db.run(sql`BEGIN IMMEDIATE`);
  try {
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

      // Batch insert imports
      if (parseResult.imports.length > 0) {
        db.insert(tables.imports)
          .values(parseResult.imports.map((imp) => ({
            sourceFileId: fileRecord.id,
            targetPath: imp.source,
            kind: imp.kind,
          })))
          .run();
      }

      // Batch insert symbol references
      if (parseResult.references.length > 0) {
        db.insert(tables.symbolReferences)
          .values(parseResult.references.map((ref) => ({
            sourceFileId: fileRecord.id,
            sourceSymbolName: ref.sourceSymbol,
            targetName: ref.targetName,
            referenceKind: ref.kind,
            line: ref.line,
          })))
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

      // Generate chunk-level embeddings for functions/classes
      await maybeEmbedChunks(opts, fileRecord.id, filePath, content, parseResult.symbols);

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

export interface CodeChunk {
  symbolName: string | null;
  kind: string;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * Split file content into chunks based on parsed symbols.
 * Each function/class/method becomes a chunk. Module-level code between
 * symbols becomes a "module" chunk if non-trivial (>= 3 lines).
 */
export function splitIntoChunks(
  content: string,
  symbols: Array<{ name: string; kind?: string; line: number }>,
): CodeChunk[] {
  const lines = content.split("\n");
  const totalLines = lines.length;
  if (totalLines === 0) return [];

  // Sort symbols by line number
  const sorted = symbols
    .filter((s) => s.kind === "function" || s.kind === "class" || s.kind === "method")
    .sort((a, b) => a.line - b.line);

  if (sorted.length === 0) {
    // No functions/classes — treat entire file as one module chunk
    if (totalLines >= 3) {
      return [{
        symbolName: null,
        kind: "module",
        startLine: 1,
        endLine: totalLines,
        content,
      }];
    }
    return [];
  }

  const chunks: CodeChunk[] = [];

  // Module-level code before first symbol
  if (sorted[0]!.line > 3) {
    chunks.push({
      symbolName: null,
      kind: "module",
      startLine: 1,
      endLine: sorted[0]!.line - 1,
      content: lines.slice(0, sorted[0]!.line - 1).join("\n"),
    });
  }

  // Each symbol gets a chunk from its start line to the next symbol (or EOF)
  for (let i = 0; i < sorted.length; i++) {
    const sym = sorted[i]!;
    const nextLine = i + 1 < sorted.length ? sorted[i + 1]!.line - 1 : totalLines;
    const startIdx = sym.line - 1; // 0-based
    const endIdx = nextLine;       // exclusive

    if (endIdx - startIdx < 3) continue; // Skip trivial chunks

    chunks.push({
      symbolName: sym.name,
      kind: sym.kind ?? "function",
      startLine: sym.line,
      endLine: nextLine,
      content: lines.slice(startIdx, endIdx).join("\n"),
    });
  }

  return chunks;
}

async function maybeEmbedChunks(
  opts: IndexOptions,
  fileId: number,
  filePath: string,
  content: string,
  symbols: Array<{ name: string; kind?: string; line: number }>,
): Promise<void> {
  if (!opts.semanticReranker?.isAvailable()) return;

  const chunks = splitIntoChunks(content, symbols);
  if (chunks.length === 0) return;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    try {
      const chunkText = [
        `file: ${filePath}`,
        `symbol: ${chunk.symbolName ?? "module-level"}`,
        `kind: ${chunk.kind}`,
        chunk.content.slice(0, 500), // Limit content for embedding input
      ].join(". ");

      const embedding = await opts.semanticReranker.embed(chunkText);
      if (embedding) {
        const contentHash = createHash("sha256").update(chunk.content).digest("hex");
        opts.db.insert(tables.codeChunks).values({
          fileId,
          chunkIndex: i,
          symbolName: chunk.symbolName,
          kind: chunk.kind,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          contentHash,
          embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        }).run();
      }
    } catch {
      // Non-fatal: chunk is skipped without embedding
    }
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
