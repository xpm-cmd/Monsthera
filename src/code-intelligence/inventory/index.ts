export type {
  ArtifactKind,
  CodeArtifact,
  CodeInventoryFileEntry,
  CodeInventorySnapshot,
  CodeInventoryStatus,
  CodeQueryHit,
  CodeQueryInput,
  CodeQueryResult,
  CodeRelation,
  RelationKind,
  SymbolKind,
} from "./types.js";

export type { SymbolExtractor } from "./extractor.js";
// `TextMateSymbolExtractor` is intentionally NOT re-exported from this
// barrel during Phase 1 — Phase 3 wires the extractor into the container
// and the MCP surface. Phase 1 keeps it internal to the inventory module.
