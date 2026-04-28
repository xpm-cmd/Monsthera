/**
 * Extension → language → Shiki grammar dispatch (ADR-017 D2/D3).
 *
 * Grammars are imported lazily on first use. A repository with no Python
 * files never pays the ~30 KB cost of importing the Python grammar.
 * Tests assert this property by inspecting `loadedLanguages()` after a
 * fixture parse.
 */

import type { IRawGrammar } from "vscode-textmate";

/**
 * `@shikijs/langs/<lang>` returns an array of `LanguageRegistration` objects;
 * each one is a superset of `vscode-textmate`'s `IRawGrammar` (it adds
 * Shiki-specific metadata we do not use). Treating them as `IRawGrammar`
 * is sufficient for the Registry callback contract and avoids a direct
 * dependency on `@shikijs/types` (which is not hoisted under pnpm).
 */
export type GrammarBundle = readonly IRawGrammar[];

export interface LanguageDescriptor {
  /** Shiki-style language id ("typescript", "tsx", "python", ...). */
  readonly id: string;
  /** Root TextMate scope for this language ("source.ts", ...). */
  readonly scopeName: string;
  /** Lazy loader for the grammar bundle. Invoked at most once per language. */
  readonly load: () => Promise<GrammarBundle>;
}

async function loadShikiBundle(
  importer: () => Promise<{ default: unknown }>,
): Promise<GrammarBundle> {
  const mod = await importer();
  return mod.default as GrammarBundle;
}

const DESCRIPTORS: Record<string, LanguageDescriptor> = {
  typescript: {
    id: "typescript",
    scopeName: "source.ts",
    load: () => loadShikiBundle(() => import("@shikijs/langs/typescript")),
  },
  tsx: {
    id: "tsx",
    scopeName: "source.tsx",
    load: () => loadShikiBundle(() => import("@shikijs/langs/tsx")),
  },
  javascript: {
    id: "javascript",
    scopeName: "source.js",
    load: () => loadShikiBundle(() => import("@shikijs/langs/javascript")),
  },
  jsx: {
    id: "jsx",
    scopeName: "source.js.jsx",
    load: () => loadShikiBundle(() => import("@shikijs/langs/jsx")),
  },
  python: {
    id: "python",
    scopeName: "source.python",
    load: () => loadShikiBundle(() => import("@shikijs/langs/python")),
  },
  go: {
    id: "go",
    scopeName: "source.go",
    load: () => loadShikiBundle(() => import("@shikijs/langs/go")),
  },
  rust: {
    id: "rust",
    scopeName: "source.rust",
    load: () => loadShikiBundle(() => import("@shikijs/langs/rust")),
  },
  java: {
    id: "java",
    scopeName: "source.java",
    load: () => loadShikiBundle(() => import("@shikijs/langs/java")),
  },
  ruby: {
    id: "ruby",
    scopeName: "source.ruby",
    load: () => loadShikiBundle(() => import("@shikijs/langs/ruby")),
  },
  markdown: {
    id: "markdown",
    scopeName: "text.html.markdown",
    load: () => loadShikiBundle(() => import("@shikijs/langs/markdown")),
  },
  json: {
    id: "json",
    scopeName: "source.json",
    load: () => loadShikiBundle(() => import("@shikijs/langs/json")),
  },
  yaml: {
    id: "yaml",
    scopeName: "source.yaml",
    load: () => loadShikiBundle(() => import("@shikijs/langs/yaml")),
  },
  toml: {
    id: "toml",
    scopeName: "source.toml",
    load: () => loadShikiBundle(() => import("@shikijs/langs/toml")),
  },
};

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".md": "markdown",
  ".markdown": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
};

/** All language ids the inventory knows about. */
export const SUPPORTED_LANGUAGE_IDS: readonly string[] = Object.freeze(
  Object.keys(DESCRIPTORS),
);

/** Returns the language id for a file extension (lowercased), or `null` for unknown. */
export function languageForExtension(extension: string): string | null {
  const ext = extension.toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

/** Returns the descriptor for a language id, or `null` if unknown. */
export function descriptorFor(languageId: string): LanguageDescriptor | null {
  return DESCRIPTORS[languageId] ?? null;
}

const loaded = new Map<string, Promise<GrammarBundle>>();

/**
 * Lazily imports the Shiki grammar bundle for a language. Subsequent calls
 * return the cached promise. The set of language ids that have been requested
 * is observable via `loadedLanguages()` for testing the lazy-load contract.
 */
export function loadGrammars(languageId: string): Promise<GrammarBundle> | null {
  const cached = loaded.get(languageId);
  if (cached !== undefined) return cached;
  const descriptor = DESCRIPTORS[languageId];
  if (!descriptor) return null;
  const promise = descriptor.load();
  loaded.set(languageId, promise);
  return promise;
}

/** Set of language ids that have been requested via `loadGrammars`. */
export function loadedLanguages(): readonly string[] {
  return Array.from(loaded.keys());
}

/** Drop the lazy-load cache. Tests use this to start from a clean slate. */
export function resetLoadedLanguagesForTesting(): void {
  loaded.clear();
}
