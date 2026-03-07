import type { SupportedLanguage } from "../core/constants.js";
import { SUPPORTED_LANGUAGES } from "../core/constants.js";

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyw": "python",
  ".go": "go",
  ".rs": "rust",
};

export function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return EXTENSION_MAP[ext] ?? null;
}

export function isSupported(filePath: string): boolean {
  return detectLanguage(filePath) !== null;
}

export function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(lang);
}
