/**
 * Public types for the M3 lightweight code inventory (ADR-017).
 *
 * Shape parity with ADR-015 Layer 2's `CodeArtifact` / `CodeRelation`. The
 * inventory is *derived state* — these structures are persisted in
 * `.monsthera/cache/code-index.json` and never written into knowledge or
 * work markdown.
 */

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "module"
  | "record";

export type ArtifactKind = SymbolKind | "file";

export interface CodeArtifact {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly path: string;
  readonly language?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly exported?: boolean;
  readonly scope?: string;
  readonly stale?: boolean;
}

export type RelationKind = "contains" | "defines";

export interface CodeRelation {
  readonly sourceId: string;
  readonly targetId: string;
  readonly kind: RelationKind;
  readonly confidence: "high" | "medium" | "low";
}

export interface CodeInventoryFileEntry {
  readonly path: string;
  readonly language?: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly symbols: readonly CodeArtifact[];
}

export interface CodeInventorySnapshot {
  readonly schemaVersion: 1;
  readonly builtAt: string;
  readonly repoFingerprint: string;
  readonly files: readonly CodeInventoryFileEntry[];
}

export interface CodeInventoryStatus {
  readonly built: boolean;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly languages: readonly string[];
  readonly lastReindexAt?: string;
  readonly staleFileCount?: number;
  readonly degraded?: { readonly reason: string };
}

export interface CodeQueryInput {
  readonly query: string;
  readonly kinds?: readonly ArtifactKind[];
  readonly paths?: readonly string[];
  readonly languages?: readonly string[];
  readonly limit?: number;
}

export interface CodeQueryHit {
  readonly path: string;
  readonly symbol: string;
  readonly kind: ArtifactKind;
  readonly language?: string;
  readonly line?: number;
  readonly scope?: string;
  readonly score: number;
}

export interface CodeQueryResult {
  readonly query: string;
  readonly hits: readonly CodeQueryHit[];
  readonly summary: {
    readonly hitCount: number;
    readonly languageCount: number;
    readonly fileCount: number;
  };
  readonly recommendedNextActions: readonly string[];
}
