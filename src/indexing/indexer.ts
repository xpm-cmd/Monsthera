import { createHash } from "node:crypto";
import { type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, and } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import * as tables from "../db/schema.js";
import { getHead, getAllTrackedFiles, getFileContent, getChangedFilesSinceCommit } from "../git/operations.js";
import { detectLanguage } from "../git/language.js";
import { parseFile, isParserAvailable } from "./parser.js";
import { generateSummary, generateRawSummary } from "./summary.js";
import { scanForSecrets, isSensitiveFile } from "../trust/secret-patterns.js";
import { IndexError } from "../core/errors.js";
import type { SemanticReranker } from "../search/semantic.js";
import { buildEmbeddingText, type EmbeddingTextOptions } from "../search/semantic.js";

export interface IndexOptions {
  repoPath: string;
  repoId: number;
  db: BetterSQLite3Database<typeof schema>;
  sensitiveFilePatterns?: string[];
  onProgress?: (msg: string) => void;
  semanticReranker?: SemanticReranker | null;
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

  // Clear existing file records for this repo
  db.delete(tables.files).where(eq(tables.files.repoId, repoId)).run();
  db.delete(tables.imports).run(); // imports reference files, so clear them too

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

  // Update index state
  const now = new Date().toISOString();
  const existing = db.select().from(tables.indexState).where(eq(tables.indexState.repoId, repoId)).get();

  if (existing) {
    db.update(tables.indexState)
      .set({ dbIndexedCommit: commit, indexedAt: now, lastSuccess: now })
      .where(eq(tables.indexState.repoId, repoId))
      .run();
  } else {
    db.insert(tables.indexState)
      .values({ repoId, dbIndexedCommit: commit, indexedAt: now, lastSuccess: now })
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

  const currentHead = await getHead({ cwd: repoPath });
  if (currentHead === lastCommit) {
    return { commit: currentHead, filesIndexed: 0, filesSkipped: 0, errors: [], durationMs: Date.now() - start };
  }

  const changedFiles = await getChangedFilesSinceCommit(lastCommit, { cwd: repoPath });
  onProgress?.(`${changedFiles.length} files changed since ${lastCommit.slice(0, 7)}`);

  let filesIndexed = 0;
  let filesSkipped = 0;

  for (const change of changedFiles) {
    if (change.status === "D") {
      // File deleted — remove from index
      db.delete(tables.files)
        .where(and(eq(tables.files.repoId, repoId), eq(tables.files.path, change.path)))
        .run();
      filesIndexed++;
      continue;
    }

    try {
      // Delete old record and re-index
      db.delete(tables.files)
        .where(and(eq(tables.files.repoId, repoId), eq(tables.files.path, change.path)))
        .run();

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

  // Update index state
  const now = new Date().toISOString();
  db.update(tables.indexState)
    .set({ dbIndexedCommit: currentHead, indexedAt: now, lastSuccess: now })
    .where(eq(tables.indexState.repoId, repoId))
    .run();

  return {
    commit: currentHead,
    filesIndexed,
    filesSkipped,
    errors,
    durationMs: Date.now() - start,
  };
}

async function indexSingleFile(
  filePath: string,
  commit: string,
  opts: IndexOptions,
): Promise<"indexed" | "skipped"> {
  const { repoPath, repoId, db, sensitiveFilePatterns } = opts;

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
  const secretHits = scanForSecrets(content);
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
    } catch {
      // Tree-sitter parse failed — fall through to raw indexing
      summary = generateRawSummary(filePath, content);
    }
  } else {
    summary = generateRawSummary(filePath, content);
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

export function getIndexedCommit(
  db: BetterSQLite3Database<typeof schema>,
  repoId: number,
): string | null {
  const state = db.select().from(tables.indexState).where(eq(tables.indexState.repoId, repoId)).get();
  return state?.dbIndexedCommit ?? null;
}
