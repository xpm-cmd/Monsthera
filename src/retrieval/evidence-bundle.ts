import { createHash } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import type { SearchBackendName, SearchResult } from "../search/interface.js";
import { getFileContent } from "../git/operations.js";
import { scanForSecrets, type SecretPattern } from "../trust/secret-patterns.js";
import { STAGE_A_MAX_CANDIDATES, STAGE_B_MAX_EXPANDED, MAX_CODE_SPAN_LINES } from "../core/constants.js";
import type { TrustTier } from "../../schemas/evidence-bundle.js";

export interface BundleBuildOptions {
  query: string;
  repoId: number;
  repoPath: string;
  commit: string;
  trustTier: TrustTier;
  searchBackend: SearchBackendName;
  searchResults: SearchResult[];
  db: BetterSQLite3Database<typeof schema>;
  expand: boolean;
  maxFiles?: number;
  secretPatterns?: SecretPattern[];
}

export interface BundleCandidate {
  path: string;
  language: string;
  relevanceScore: number;
  summary: string;
  symbols: Array<{ name: string; kind: string; line: number }>;
  provenance: "search_hit" | "import_trace" | "symbol_ref" | "change_ref" | "manual";
}

export interface ExpandedBundleCandidate extends BundleCandidate {
  codeSpan: string | null;
  spanLines: { start: number; end: number } | null;
  changeRefs: string[];
  relatedNotes: string[];
  redactionApplied: boolean;
}

export interface EvidenceBundleResult {
  bundleId: string;
  repoId: string;
  commit: string;
  query: string;
  timestamp: string;
  trustTier: TrustTier;
  redactionPolicy: "none" | "code_stripped";
  searchBackend: SearchBackendName;
  latencyMs: number;
  candidates: BundleCandidate[];
  expanded: ExpandedBundleCandidate[];
  rankingMetadata: { scoringWeights: Record<string, number> };
}

export async function buildEvidenceBundle(opts: BundleBuildOptions): Promise<EvidenceBundleResult> {
  const start = Date.now();

  const candidates = buildCandidates(opts);
  let expanded: ExpandedBundleCandidate[] = [];

  if (opts.expand && opts.trustTier === "A") {
    const expandLimit = opts.maxFiles ?? STAGE_B_MAX_EXPANDED;
    expanded = await expandCandidates(candidates.slice(0, expandLimit), opts);
  }

  const timestamp = new Date().toISOString();
  const bundleId = computeBundleId(opts.query, opts.commit, candidates);

  return {
    bundleId,
    repoId: String(opts.repoId),
    commit: opts.commit,
    query: opts.query,
    timestamp,
    trustTier: opts.trustTier,
    redactionPolicy: opts.trustTier === "B" ? "code_stripped" : "none",
    searchBackend: opts.searchBackend,
    latencyMs: Date.now() - start,
    candidates,
    expanded,
    rankingMetadata: {
      scoringWeights: opts.searchBackend.includes("+semantic")
        ? { relevance: 0.4, semantic: 0.6 }
        : { relevance: 1.0 },
    },
  };
}

function buildCandidates(opts: BundleBuildOptions): BundleCandidate[] {
  const { searchResults, db, repoId } = opts;
  const sliced = searchResults.slice(0, STAGE_A_MAX_CANDIDATES);
  const paths = sliced.map((r) => r.path);
  const fileRecords = queries.getFilesByPaths(db, repoId, paths);
  const fileMap = new Map(fileRecords.map((f) => [f.path, f]));

  const candidates: BundleCandidate[] = [];
  for (const result of sliced) {
    const fileRecord = fileMap.get(result.path);
    if (!fileRecord) continue;

    const symbols = fileRecord.symbolsJson ? JSON.parse(fileRecord.symbolsJson) : [];

    candidates.push({
      path: result.path,
      language: fileRecord.language ?? "unknown",
      relevanceScore: result.score,
      summary: fileRecord.summary ?? "",
      symbols,
      provenance: "search_hit",
    });
  }

  return candidates;
}

async function expandCandidates(
  candidates: BundleCandidate[],
  opts: BundleBuildOptions,
): Promise<ExpandedBundleCandidate[]> {
  const expanded: ExpandedBundleCandidate[] = [];
  if (candidates.length === 0) return expanded;

  // Batch-load file records and notes once (avoid N+1)
  const paths = candidates.map((c) => c.path);
  const fileRecords = queries.getFilesByPaths(opts.db, opts.repoId, paths);
  const fileMap = new Map(fileRecords.map((f) => [f.path, f]));

  const allNotes = queries.getNotesByRepo(opts.db, opts.repoId);
  const notesByPath = new Map<string, string[]>();
  for (const note of allNotes) {
    if (note.linkedPathsJson) {
      const linkedPaths = JSON.parse(note.linkedPathsJson) as string[];
      for (const lp of linkedPaths) {
        const existing = notesByPath.get(lp);
        if (existing) {
          existing.push(note.key);
        } else {
          notesByPath.set(lp, [note.key]);
        }
      }
    }
  }

  for (const candidate of candidates) {
    const fileRecord = fileMap.get(candidate.path);
    let codeSpan: string | null = null;
    let spanLines: { start: number; end: number } | null = null;
    let redactionApplied = false;

    // Tier B never gets code spans
    if (opts.trustTier === "A") {
      const content = await getFileContent(candidate.path, opts.commit, { cwd: opts.repoPath });
      if (content) {
        const lines = content.split("\n");
        const end = Math.min(lines.length, MAX_CODE_SPAN_LINES);
        let span = lines.slice(0, end).join("\n");

        // Check for secrets and redact secret lines
        const secretHits = scanForSecrets(span, opts.secretPatterns);
        if (secretHits.length > 0) {
          const secretLineNumbers = new Set(secretHits.map((h) => h.line));
          const redactedLines = lines.slice(0, end).map((line, i) => {
            if (secretLineNumbers.has(i + 1)) {
              return "// [REDACTED — secret detected]";
            }
            return line;
          });
          span = redactedLines.join("\n");
          redactionApplied = true;
        }

        codeSpan = span;
        spanLines = { start: 1, end };
      }
    }

    const relatedNotes = fileRecord ? (notesByPath.get(candidate.path) ?? []) : [];

    expanded.push({
      ...candidate,
      codeSpan,
      spanLines,
      changeRefs: [],
      relatedNotes,
      redactionApplied,
    });
  }

  return expanded;
}

function computeBundleId(query: string, commit: string, candidates: BundleCandidate[]): string {
  const data = JSON.stringify({
    query,
    commit,
    paths: candidates.map((c) => c.path).sort(),
  });
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}
