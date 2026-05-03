/**
 * `SymbolExtractor` — the seam introduced in ADR-017 D2 so M4 (provider
 * bridge) can swap TextMate for tree-sitter behind the same interface.
 *
 * M3 ships a single implementation backed by `vscode-textmate` +
 * `vscode-oniguruma` + per-language `@shikijs/langs`. Token classification
 * follows ADR-017 D2 — `entity.name.function.*` (excluding
 * `entity.name.function.call.*`) maps to a function declaration; the
 * specific `entity.name.type.<class|interface|alias|enum|module|record>.*`
 * subtypes map to their corresponding `ArtifactKind`.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { IGrammar, IRawGrammar, Registry as TextmateRegistry } from "vscode-textmate";

import type { Logger } from "../../core/logger.js";

import {
  descriptorFor,
  languageForExtension,
  loadGrammars,
  SUPPORTED_LANGUAGE_IDS,
} from "./language-map.js";
import type { ArtifactKind, CodeArtifact, SymbolKind } from "./types.js";

export interface SymbolExtractor {
  /**
   * Identifier for diagnostics and telemetry. Examples: `"textmate-shiki"`,
   * `"tree-sitter-curated"`, `"regex-fallback"`.
   */
  readonly name: string;

  /**
   * Languages this extractor supports. Each entry is a Shiki-style
   * language name (`"typescript"`, `"python"`, ...). Used by the
   * dispatch layer to select an extractor for a file.
   */
  readonly languages: readonly string[];

  /**
   * Returns true when this extractor can handle a file with the given
   * extension. Lazy-loading hint: callers should resolve a language for
   * the extension first; this fallback is for extensions that map to
   * multiple languages or to no language at all.
   */
  supports(extension: string): boolean;

  /**
   * Extract declared symbols from a single file's content. Should never
   * throw on malformed input — return an empty array and log at debug if
   * the parse fails.
   *
   * `path` is relative to the repository root. `content` is UTF-8 text.
   */
  extract(input: { readonly path: string; readonly content: string }): Promise<readonly CodeArtifact[]>;
}

// ─── Module-level lazy state ──────────────────────────────────────────────
//
// vscode-oniguruma and vscode-textmate are CommonJS packages with global
// initialization (the WASM regex engine is loaded once per process). Wrapping
// the load in a memoised promise means concurrent first calls share a single
// initialization, and subsequent calls hit a fast path.

interface OnigLib {
  createOnigScanner(sources: string[]): unknown;
  createOnigString(str: string): unknown;
}

const requireFromHere = createRequire(import.meta.url);

let onigLibPromise: Promise<OnigLib> | null = null;

function loadOniguruma(): Promise<OnigLib> {
  if (onigLibPromise) return onigLibPromise;
  onigLibPromise = (async () => {
    // vscode-oniguruma is published as CommonJS; load via createRequire to
    // avoid any ESM/CJS interop surprises with `verbatimModuleSyntax`.
    const oniguruma = requireFromHere("vscode-oniguruma") as {
      loadWASM(data: ArrayBuffer | ArrayBufferView): Promise<void>;
      OnigScanner: new (sources: string[]) => unknown;
      OnigString: new (str: string) => unknown;
    };
    const wasmPath = requireFromHere.resolve("vscode-oniguruma/release/onig.wasm");
    const wasmBuffer = fs.readFileSync(wasmPath);
    await oniguruma.loadWASM(wasmBuffer.buffer.slice(
      wasmBuffer.byteOffset,
      wasmBuffer.byteOffset + wasmBuffer.byteLength,
    ));
    return {
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (str) => new oniguruma.OnigString(str),
    };
  })();
  return onigLibPromise;
}

// Scope name → IRawGrammar. Populated as we lazy-load grammar bundles.
const grammarsByScope: Map<string, IRawGrammar> = new Map();
// Language id → resolved IGrammar (or null if loading failed previously).
const grammarByLanguage: Map<string, IGrammar | null> = new Map();
// Inflight per-language load promises so concurrent calls share work.
const inflightLanguageLoads: Map<string, Promise<IGrammar | null>> = new Map();

let registryPromise: Promise<TextmateRegistry> | null = null;

async function ensureRegistry(): Promise<TextmateRegistry> {
  if (registryPromise) return registryPromise;
  registryPromise = (async () => {
    const onigLib = await loadOniguruma();
    const textmate = requireFromHere("vscode-textmate") as {
      Registry: new (options: {
        onigLib: Promise<OnigLib>;
        loadGrammar(scopeName: string): Promise<IRawGrammar | null | undefined>;
      }) => TextmateRegistry;
    };
    return new textmate.Registry({
      onigLib: Promise.resolve(onigLib),
      loadGrammar: async (scopeName) => grammarsByScope.get(scopeName) ?? null,
    });
  })();
  return registryPromise;
}

async function getGrammarForLanguage(languageId: string): Promise<IGrammar | null> {
  const cached = grammarByLanguage.get(languageId);
  if (cached !== undefined) return cached;
  const inflight = inflightLanguageLoads.get(languageId);
  if (inflight) return inflight;

  const promise = (async (): Promise<IGrammar | null> => {
    const descriptor = descriptorFor(languageId);
    if (!descriptor) return null;
    const bundlePromise = loadGrammars(languageId);
    if (!bundlePromise) return null;
    const bundle = await bundlePromise;
    for (const grammar of bundle) {
      if (!grammarsByScope.has(grammar.scopeName)) {
        grammarsByScope.set(grammar.scopeName, grammar);
      }
    }
    const registry = await ensureRegistry();
    const grammar = await registry.loadGrammar(descriptor.scopeName);
    return grammar ?? null;
  })();

  inflightLanguageLoads.set(languageId, promise);
  try {
    const grammar = await promise;
    grammarByLanguage.set(languageId, grammar);
    return grammar;
  } finally {
    inflightLanguageLoads.delete(languageId);
  }
}

// ─── Scope → ArtifactKind mapping (ADR-017 D2) ────────────────────────────
//
// ADR-017 D2 sketches the filter as
//   match  /^entity\.name\.function(\.|$)/
//          /^entity\.name\.type\.(class|interface|alias|enum|module|record)(\.|$)/
//   except entity.name.function.call.*
//
// Real Shiki grammars use additional conventions for call sites and
// references that share the `entity.name.function` prefix. The patterns
// below extend the ADR's exclusion list without changing the spirit of D2:
//   - `meta.function-call.*` (TS/JS, hyphenated)
//   - `meta.function.call.*` (Rust, dotted)
//   - `meta.function.decorator.*` and `entity.name.function.decorator.*`
//     (Python decorator usages — the *use* of a decorator, not its
//     definition)
//   - `entity.name.function.support.*` (Go builtins like `len` and
//     dotted-package functions like `errors.New`)
//   - `meta.definition.property.*` (TS interface properties whose type
//     is `() => ...` — function-typed *fields*, not function decls)
//
// These come from inspecting actual scope chains during Phase 1 fixture
// development. They are precision refinements of the ADR's exclusion
// list, not deviations from the ADR contract; an extractor that flagged
// `Promise.resolve` as a function definition in every TS file would not
// be useful for inventory queries.
//
// Type *references* like `entity.name.type.ts` (no class/interface/alias/
// enum/module/record subtype) appear in annotations and generic parameters
// and are intentionally NOT mapped to declarations.

const SCOPE_CALL_CONTEXT: readonly RegExp[] = [
  /^meta\.function-call(?:\.|$)/,
  /^meta\.function\.call(?:\.|$)/,
];

const SCOPE_DECORATOR_CONTEXT: readonly RegExp[] = [
  /^meta\.function\.decorator(?:\.|$)/,
  /^entity\.name\.function\.decorator(?:\.|$)/,
];

const SCOPE_PROPERTY_CONTEXT: readonly RegExp[] = [
  /^meta\.definition\.property(?:\.|$)/,
];

const SCOPE_FUNCTION_INCLUDE: readonly RegExp[] = [
  /^entity\.name\.function(?:\.|$)/,
];

const SCOPE_FUNCTION_EXCLUDE: readonly RegExp[] = [
  /^entity\.name\.function\.call(?:\.|$)/,
  /^entity\.name\.function\.decorator(?:\.|$)/,
  /^entity\.name\.function\.support(?:\.|$)/,
];

interface KindRule {
  readonly pattern: RegExp;
  readonly kind: SymbolKind;
}

const TYPE_RULES: readonly KindRule[] = [
  { pattern: /^entity\.name\.type\.class(?:\.|$)/, kind: "class" },
  { pattern: /^entity\.name\.type\.interface(?:\.|$)/, kind: "interface" },
  { pattern: /^entity\.name\.type\.alias(?:\.|$)/, kind: "type" },
  { pattern: /^entity\.name\.type\.enum(?:\.|$)/, kind: "enum" },
  { pattern: /^entity\.name\.type\.module(?:\.|$)/, kind: "namespace" },
  { pattern: /^entity\.name\.type\.record(?:\.|$)/, kind: "record" },
  // Some grammars (Rust) use `entity.name.type.struct` / `entity.name.type.trait`
  // — map struct → class and trait → interface.
  { pattern: /^entity\.name\.type\.struct(?:\.|$)/, kind: "class" },
  { pattern: /^entity\.name\.type\.trait(?:\.|$)/, kind: "interface" },
  // `entity.name.namespace.<lang>` (Rust `mod`, etc.).
  { pattern: /^entity\.name\.namespace(?:\.|$)/, kind: "namespace" },
  // `entity.name.module.<lang>` (some grammars use this for module decls).
  { pattern: /^entity\.name\.module(?:\.|$)/, kind: "namespace" },
];

function matchesAny(scope: string, patterns: readonly RegExp[]): boolean {
  for (const pattern of patterns) {
    if (pattern.test(scope)) return true;
  }
  return false;
}

function classifyScopes(scopes: readonly string[]): SymbolKind | null {
  // Reject if any scope places this token in a call / decorator / property
  // context that should not produce a symbol declaration.
  for (const scope of scopes) {
    if (matchesAny(scope, SCOPE_CALL_CONTEXT)) return null;
    if (matchesAny(scope, SCOPE_DECORATOR_CONTEXT)) return null;
    if (matchesAny(scope, SCOPE_PROPERTY_CONTEXT)) return null;
  }
  for (const scope of scopes) {
    if (
      matchesAny(scope, SCOPE_FUNCTION_INCLUDE) &&
      !matchesAny(scope, SCOPE_FUNCTION_EXCLUDE)
    ) {
      return "function";
    }
    for (const rule of TYPE_RULES) {
      if (rule.pattern.test(scope)) return rule.kind;
    }
  }
  return null;
}

// Identifiers can be plain (`foo`, `_bar`) or dotted (Ruby `self.greet`,
// some grammars carry a receiver into the name token). Reject anything
// that contains whitespace, brackets, or other non-identifier characters.
const NAME_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

function makeArtifact(input: {
  kind: ArtifactKind;
  name: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine?: number;
}): CodeArtifact {
  return {
    id: `${input.kind}:${input.filePath}:${input.name}@${input.startLine}`,
    kind: input.kind,
    name: input.name,
    path: input.filePath,
    language: input.language,
    startLine: input.startLine,
    endLine: input.endLine ?? input.startLine,
  };
}

export class TextMateSymbolExtractor implements SymbolExtractor {
  readonly name = "textmate-shiki";
  readonly languages: readonly string[] = SUPPORTED_LANGUAGE_IDS;

  constructor(private readonly logger?: Logger) {}

  supports(extension: string): boolean {
    return languageForExtension(extension) !== null;
  }

  async extract(input: {
    readonly path: string;
    readonly content: string;
  }): Promise<readonly CodeArtifact[]> {
    const { path: filePath, content } = input;
    const ext = path.extname(filePath);
    const languageId = languageForExtension(ext);
    if (!languageId) return [];

    let grammar: IGrammar | null;
    try {
      grammar = await getGrammarForLanguage(languageId);
    } catch (cause) {
      this.logger?.debug("textmate grammar load failed", {
        path: filePath,
        languageId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return [];
    }
    if (!grammar) return [];

    const artifacts: CodeArtifact[] = [];
    const seen = new Set<string>();

    try {
      const lines = content.split(/\r?\n/);
      let state: Parameters<IGrammar["tokenizeLine"]>[1] = null;
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx] ?? "";
        const result = grammar.tokenizeLine(line, state);
        for (const token of result.tokens) {
          const kind = classifyScopes(token.scopes);
          if (!kind) continue;
          const raw = line.slice(token.startIndex, token.endIndex);
          const name = raw.trim();
          if (!name || !NAME_PATTERN.test(name)) continue;
          const startLine = lineIdx + 1;
          const dedupeKey = `${kind}:${name}:${startLine}:${token.startIndex}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          artifacts.push(
            makeArtifact({
              kind,
              name,
              filePath,
              language: languageId,
              startLine,
            }),
          );
        }
        state = result.ruleStack;
      }
    } catch (cause) {
      this.logger?.debug("textmate tokenize failed", {
        path: filePath,
        languageId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return [];
    }

    return artifacts;
  }
}

/**
 * Drop module-level grammar caches. Tests use this to start from a clean
 * slate so the lazy-load contract can be asserted (`loadedLanguages()`
 * starts empty after a reset).
 */
export function resetExtractorCachesForTesting(): void {
  grammarsByScope.clear();
  grammarByLanguage.clear();
  inflightLanguageLoads.clear();
  registryPromise = null;
}
