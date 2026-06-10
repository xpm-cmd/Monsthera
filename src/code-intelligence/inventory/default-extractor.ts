/**
 * Default `SymbolExtractor` composition for the inventory service.
 *
 * Routes by file extension: `.lean` goes to the regex-based
 * `LeanSymbolExtractor` (no Shiki grammar required — see the rationale in
 * `lean-extractor.ts`); everything else goes to the TextMate extractor.
 * This keeps the ADR-017 D2 `SymbolExtractor` seam intact: the service
 * still drives a single extractor, and M4 can swap this composition for a
 * tree-sitter-backed one behind the same interface.
 */

import * as path from "node:path";

import type { Logger } from "../../core/logger.js";

import { TextMateSymbolExtractor, type SymbolExtractor } from "./extractor.js";
import { LeanSymbolExtractor } from "./lean-extractor.js";
import type { CodeArtifact } from "./types.js";

export function createDefaultSymbolExtractor(logger?: Logger): SymbolExtractor {
  const lean = new LeanSymbolExtractor(logger);
  const textmate = new TextMateSymbolExtractor(logger);
  return {
    name: `dispatch(${lean.name},${textmate.name})`,
    languages: Object.freeze([...new Set([...textmate.languages, ...lean.languages])]),
    supports(extension: string): boolean {
      return lean.supports(extension) || textmate.supports(extension);
    },
    async extract(input: {
      readonly path: string;
      readonly content: string;
    }): Promise<readonly CodeArtifact[]> {
      const extension = path.extname(input.path);
      if (lean.supports(extension)) return lean.extract(input);
      return textmate.extract(input);
    },
  };
}
