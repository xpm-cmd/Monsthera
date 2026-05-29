import pkg from "../../package.json";

/**
 * Single source of truth for the product version: `package.json`. Previously
 * this was a hand-maintained literal that silently drifted from the package
 * manifest (and from a third, dead `__MONSTHERA_VERSION__` build define), so
 * `status` / `doctor` / `--version` could all report a version no release ever
 * shipped. Importing the manifest keeps them in lockstep — esbuild/tsup inline
 * the value at build time, and tsx/vitest resolve it via `resolveJsonModule`.
 */
export const VERSION: string = pkg.version;

export const DEFAULT_CONFIG_DIR = ".monsthera";
export const DEFAULT_CONFIG_FILE = "config.json";

export const DEFAULT_MARKDOWN_ROOT = "knowledge";
export const DEFAULT_PORT = 3000;

export const DEFAULT_SEARCH_ALPHA = 0.5;
export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
