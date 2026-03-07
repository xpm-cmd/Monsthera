import { createHash } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import type { SearchBackendName, SearchResult } from "../search/interface.js";
import { getFileContent } from "../git/operations.js";
import { scanForSecrets } from "../trust/secret-patterns.js";
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
    expanded = await expandCandidates(candidates.slice(0, STAGE_B_MAX_EXPANDED), opts);
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
  const candidates: BundleCandidate[] = [];

  for (const result of searchResults.slice(0, STAGE_A_MAX_CANDIDATES)) {
    const fileRecord = queries.getFileByPath(db, repoId, result.path);
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

  for (const candidate of candidates) {
    const fileRecord = queries.getFileByPath(opts.db, opts.repoId, candidate.path);
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
        const secretHits = scanForSecrets(span);
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

    // Find related notes
    const relatedNotes: string[] = [];
    if (fileRecord) {
      const notes = queries.getNotesByRepo(opts.db, opts.repoId);
      for (const note of notes) {
        if (note.linkedPathsJson) {
          const linkedPaths = JSON.parse(note.linkedPathsJson) as string[];
          if (linkedPaths.includes(candidate.path)) {
            relatedNotes.push(note.key);
          }
        }
      }
    }

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
