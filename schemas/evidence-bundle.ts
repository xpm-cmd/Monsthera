import { z } from "zod/v4";

export const TrustTier = z.enum(["A", "B"]);
export type TrustTier = z.infer<typeof TrustTier>;

export const RedactionPolicy = z.enum(["none", "code_stripped"]);
export type RedactionPolicy = z.infer<typeof RedactionPolicy>;

export const SearchBackend = z.enum(["zoekt", "fts5", "fts5+semantic", "zoekt+semantic"]);
export type SearchBackend = z.infer<typeof SearchBackend>;

export const Provenance = z.enum(["search_hit", "import_trace", "symbol_ref", "change_ref", "manual"]);
export type Provenance = z.infer<typeof Provenance>;

export const SymbolInfo = z.object({
  name: z.string(),
  kind: z.enum(["function", "class", "method", "type", "variable", "import", "export"]),
  line: z.number().int().nonnegative(),
});
export type SymbolInfo = z.infer<typeof SymbolInfo>;

export const Candidate = z.object({
  path: z.string(),
  language: z.string(),
  relevanceScore: z.number().min(0).max(1),
  summary: z.string(),
  symbols: z.array(SymbolInfo).default([]),
  provenance: Provenance,
});
export type Candidate = z.infer<typeof Candidate>;

export const ExpandedCandidate = Candidate.extend({
  codeSpan: z.string().nullable(), // null for Tier B
  spanLines: z.object({ start: z.number().int(), end: z.number().int() }).nullable(),
  changeRefs: z.array(z.string()).default([]), // commit SHAs
  relatedNotes: z.array(z.string()).default([]), // note IDs
  redactionApplied: z.boolean().default(false),
});
export type ExpandedCandidate = z.infer<typeof ExpandedCandidate>;

export const RankingMetadata = z.object({
  scoringWeights: z.record(z.string(), z.number()).default({}),
  tieBreakRationale: z.string().optional(),
});
export type RankingMetadata = z.infer<typeof RankingMetadata>;

export const EvidenceBundle = z.object({
  bundleId: z.string(), // deterministic hash
  repoId: z.string(),
  commit: z.string(),
  query: z.string(),
  timestamp: z.string().datetime(),
  trustTier: TrustTier,
  redactionPolicy: RedactionPolicy,
  searchBackend: SearchBackend,
  latencyMs: z.number().nonnegative(),

  // Stage A
  candidates: z.array(Candidate).max(5),

  // Stage B (optional expansion)
  expanded: z.array(ExpandedCandidate).max(3).default([]),

  rankingMetadata: RankingMetadata.default({ scoringWeights: {} }),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundle>;
