import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, posix as pathPosix, relative, resolve, sep } from "node:path";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import { detectLanguage, isSupportedLanguage } from "../git/language.js";

type DB = BetterSQLite3Database<typeof schema>;

export const TEST_COVERAGE_METHODOLOGY_VERSION = "v1";

export interface TestCoverageMatch {
  path: string;
  matchKinds: Array<"naming" | "imports" | "fallback">;
  notes: string;
}

export interface TestCoverageResult {
  filePath: string;
  language: string | null;
  methodologyVersion: typeof TEST_COVERAGE_METHODOLOGY_VERSION;
  status: "tested" | "untested" | "unknown";
  confidence: "high" | "medium" | "low";
  matchedTests: TestCoverageMatch[];
  signals: {
    namingMatches: number;
    importMatches: number;
    fallbackMatches: number;
  };
  limitations: string[];
  reason?: string;
}

const RESOLVABLE_IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"] as const;
const LIMITATIONS = [
  "Structural heuristics only. This is not runtime coverage.",
  "No line, branch, or statement percentages are reported.",
  "Dynamic imports, generated code, and framework magic may be missed.",
  "Integration and end-to-end tests may execute behavior without a direct structural match.",
];
const TEST_ROOT_SEGMENTS = new Set(["tests", "test", "__tests__", "unit", "integration", "e2e"]);
const SOURCE_ROOT_SEGMENTS = new Set(["src", "lib", "app", "pkg"]);

export async function analyzeTestCoverage(
  db: DB,
  repoId: number,
  repoPath: string,
  filePath: string,
): Promise<TestCoverageResult> {
  const absolutePath = resolveRepoRelativePath(repoPath, filePath);
  const fileExists = await pathExists(absolutePath);
  const indexedTarget = queries.getFileByPath(db, repoId, filePath);
  const detectedLanguage = detectLanguage(filePath);
  const language = detectedLanguage ?? (indexedTarget?.language && isSupportedLanguage(indexedTarget.language) ? indexedTarget.language : null);

  if (!fileExists) {
    return unknownResult(filePath, language, "Target file not found under the repo root.");
  }

  if (!language) {
    return unknownResult(filePath, null, "Supported languages are TypeScript, JavaScript, Python, Go, and Rust.");
  }

  if (isLikelyTestFile(filePath)) {
    return unknownResult(filePath, language, "The target appears to be a test file; v1 is intended for source files.");
  }

  if (!indexedTarget) {
    return unknownResult(filePath, language, "The target file is not indexed yet, so structural import heuristics are unavailable.");
  }

  const allFiles = queries.getAllFiles(db, repoId);
  const indexedPaths = new Set(allFiles.map((file) => file.path));
  const candidateTests = allFiles.filter((file) => isLikelyTestFile(file.path));
  const matches: TestCoverageMatch[] = [];

  for (const candidate of candidateTests) {
    const matchKinds: TestCoverageMatch["matchKinds"] = [];

    if (hasStrongNamingMatch(indexedTarget.path, candidate.path)) {
      matchKinds.push("naming");
    }
    if (hasImportMatch(db, candidate.id, candidate.path, indexedTarget.path, indexedPaths)) {
      matchKinds.push("imports");
    }
    if (hasFallbackMatch(indexedTarget.path, candidate.path, language) && !matchKinds.includes("fallback")) {
      matchKinds.push("fallback");
    }

    if (!matchKinds.length) continue;

    matches.push({
      path: candidate.path,
      matchKinds,
      notes: buildNotes(matchKinds),
    });
  }

  matches.sort((left, right) => left.path.localeCompare(right.path) || left.matchKinds.join(",").localeCompare(right.matchKinds.join(",")));

  const signals = {
    namingMatches: matches.filter((match) => match.matchKinds.includes("naming")).length,
    importMatches: matches.filter((match) => match.matchKinds.includes("imports")).length,
    fallbackMatches: matches.filter((match) => match.matchKinds.includes("fallback")).length,
  };

  if (signals.importMatches > 0) {
    return {
      filePath,
      language,
      methodologyVersion: TEST_COVERAGE_METHODOLOGY_VERSION,
      status: "tested",
      confidence: "high",
      matchedTests: matches,
      signals,
      limitations: [...LIMITATIONS],
    };
  }

  if (signals.namingMatches > 0) {
    return {
      filePath,
      language,
      methodologyVersion: TEST_COVERAGE_METHODOLOGY_VERSION,
      status: "tested",
      confidence: "medium",
      matchedTests: matches,
      signals,
      limitations: [...LIMITATIONS],
    };
  }

  if (signals.fallbackMatches > 0) {
    return unknownResult(
      filePath,
      language,
      "Only weak package-level fallback matches were found, so v1 does not promote this file to tested.",
      matches,
      signals,
    );
  }

  return {
    filePath,
    language,
    methodologyVersion: TEST_COVERAGE_METHODOLOGY_VERSION,
    status: "untested",
    confidence: "low",
    matchedTests: [],
    signals,
    limitations: [...LIMITATIONS],
  };
}

function unknownResult(
  filePath: string,
  language: string | null,
  reason: string,
  matchedTests: TestCoverageMatch[] = [],
  signals = { namingMatches: 0, importMatches: 0, fallbackMatches: 0 },
): TestCoverageResult {
  return {
    filePath,
    language,
    methodologyVersion: TEST_COVERAGE_METHODOLOGY_VERSION,
    status: "unknown",
    confidence: "low",
    matchedTests,
    signals,
    limitations: [...LIMITATIONS],
    reason,
  };
}

function hasStrongNamingMatch(sourcePath: string, testPath: string): boolean {
  const sourceComparable = normalizeSourceComparable(sourcePath);
  const testComparable = normalizeTestComparable(testPath);
  if (!sourceComparable || !testComparable) return false;
  if (sourceComparable === testComparable) return true;

  const sourceBase = pathPosix.basename(sourceComparable);
  const testBase = pathPosix.basename(testComparable);
  if (sourceBase !== testBase) return false;

  const sourceDir = pathPosix.dirname(sourceComparable);
  const testDir = pathPosix.dirname(testComparable);
  if (sourceDir === "." || testDir === ".") return true;

  return testDir.endsWith(`/${sourceDir}`) || sourceDir.endsWith(`/${testDir}`) || sourceDir === testDir;
}

function hasFallbackMatch(sourcePath: string, testPath: string, language: string): boolean {
  if (language === "go") {
    return pathPosix.dirname(sourcePath) === pathPosix.dirname(testPath) && testPath.endsWith("_test.go");
  }
  if (language === "rust") {
    return testPath.startsWith("tests/") && pathPosix.basename(stripExtension(testPath)) !== pathPosix.basename(stripExtension(sourcePath));
  }
  return false;
}

function hasImportMatch(
  db: DB,
  testFileId: number,
  testFilePath: string,
  targetPath: string,
  indexedPaths: Set<string>,
): boolean {
  return queries.getImportsForFile(db, testFileId).some((entry) => resolveImportTarget(testFilePath, entry.targetPath, indexedPaths) === targetPath);
}

function resolveImportTarget(sourcePath: string, importPath: string, indexedPaths: Set<string>): string | null {
  if (!importPath) return null;
  if (indexedPaths.has(importPath)) return importPath;

  const candidates = new Set<string>();
  const addCandidates = (basePath: string) => {
    const normalized = pathPosix.normalize(basePath).replace(/^\.\/+/, "");
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      return;
    }
    candidates.add(normalized);

    const ext = pathPosix.extname(normalized);
    const withoutExt = ext ? normalized.slice(0, -ext.length) : normalized;
    if (ext) {
      for (const candidateExt of RESOLVABLE_IMPORT_EXTENSIONS) {
        candidates.add(`${withoutExt}${candidateExt}`);
        candidates.add(pathPosix.join(withoutExt, `index${candidateExt}`));
      }
    } else {
      for (const candidateExt of RESOLVABLE_IMPORT_EXTENSIONS) {
        candidates.add(`${normalized}${candidateExt}`);
        candidates.add(pathPosix.join(normalized, `index${candidateExt}`));
      }
    }
  };

  if (importPath.startsWith(".")) {
    addCandidates(pathPosix.join(pathPosix.dirname(sourcePath), importPath));
  } else if (importPath.startsWith("/")) {
    addCandidates(importPath.slice(1));
  } else {
    addCandidates(importPath);
  }

  for (const candidate of candidates) {
    if (indexedPaths.has(candidate)) return candidate;
  }
  return null;
}

function normalizeSourceComparable(filePath: string): string {
  return trimLeadingSegments(stripExtension(filePath), SOURCE_ROOT_SEGMENTS);
}

function normalizeTestComparable(filePath: string): string {
  const withoutExt = stripExtension(filePath);
  const segments = withoutExt.split("/").filter(Boolean);
  while (segments.length && TEST_ROOT_SEGMENTS.has(segments[0]!)) {
    segments.shift();
  }
  if (!segments.length) return "";
  segments[segments.length - 1] = normalizeTestBasename(segments[segments.length - 1]!);
  return segments.join("/");
}

function normalizeTestBasename(base: string): string {
  return base
    .replace(/(?:\.test|\.spec)$/i, "")
    .replace(/_test$/i, "")
    .replace(/^test_/i, "");
}

function trimLeadingSegments(filePath: string, ignoredRoots: Set<string>): string {
  const segments = filePath.split("/").filter(Boolean);
  while (segments.length && ignoredRoots.has(segments[0]!)) {
    segments.shift();
  }
  return segments.join("/");
}

function stripExtension(filePath: string): string {
  const ext = pathPosix.extname(filePath);
  return ext ? filePath.slice(0, -ext.length) : filePath;
}

function isLikelyTestFile(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?|unit|integration|e2e)(\/|$)/i.test(filePath)
    || /\.(test|spec)\.[^.]+$/i.test(filePath)
    || /(^|\/)test_[^/]+\.py$/i.test(filePath)
    || /_test\.go$/i.test(filePath);
}

function buildNotes(matchKinds: TestCoverageMatch["matchKinds"]): string {
  return matchKinds.map((kind) => {
    switch (kind) {
      case "imports":
        return "Direct indexed import match.";
      case "naming":
        return "Mirrored naming/path match.";
      case "fallback":
        return "Package-level fallback match.";
    }
  }).join(" ");
}

function resolveRepoRelativePath(repoPath: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    throw new Error("filePath must be relative to the repo root");
  }

  const absolutePath = resolve(repoPath, filePath);
  const relativePath = relative(repoPath, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("filePath must stay within the repo root");
  }

  return absolutePath;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
