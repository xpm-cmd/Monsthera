import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type Parser from "web-tree-sitter";
import type { SupportedLanguage } from "../core/constants.js";
import { detectLanguage } from "../git/language.js";
import { parseFile, parseSyntaxTree, type ExtractedSymbol } from "../indexing/parser.js";

export const COMPLEXITY_METHODOLOGY_VERSION = "v1";

export interface ComplexityMetrics {
  loc: number;
  nonEmptyLines: number;
  functionCount: number;
  classCount: number;
  branchPoints: number;
  maxNesting: number;
  cyclomaticLike: number;
}

export interface ComplexityDefinitions {
  loc: string;
  nonEmptyLines: string;
  functionCount: string;
  classCount: string;
  branchPoints: string;
  maxNesting: string;
  cyclomaticLike: string;
}

export interface ComplexityAnalysisSuccess {
  filePath: string;
  exists: true;
  supported: true;
  language: SupportedLanguage;
  methodologyVersion: typeof COMPLEXITY_METHODOLOGY_VERSION;
  syntaxErrorsPresent: boolean;
  metrics: ComplexityMetrics;
  definitions: ComplexityDefinitions;
}

export interface ComplexityAnalysisFailure {
  filePath: string;
  exists: boolean;
  supported: boolean;
  language: SupportedLanguage | null;
  methodologyVersion: typeof COMPLEXITY_METHODOLOGY_VERSION;
  syntaxErrorsPresent: null;
  metrics: null;
  definitions: ComplexityDefinitions;
  reason: "not_found" | "unsupported_language";
  message: string;
}

export type ComplexityAnalysis = ComplexityAnalysisSuccess | ComplexityAnalysisFailure;

const COMPLEXITY_DEFINITIONS: ComplexityDefinitions = {
  loc: "Total line count including blanks.",
  nonEmptyLines: "Lines that contain non-whitespace characters.",
  functionCount: "Named functions and methods discovered from the syntax tree.",
  classCount: "Class-like declarations discovered from the syntax tree.",
  branchPoints: "Control-flow decision points counted from the syntax tree.",
  maxNesting: "Maximum depth of nested control-flow nodes.",
  cyclomaticLike: "Heuristic complexity score computed as 1 + branchPoints.",
};

const BRANCH_NODE_TYPES: Record<SupportedLanguage, ReadonlySet<string>> = {
  typescript: new Set([
    "if_statement",
    "switch_case",
    "switch_default",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "catch_clause",
    "ternary_expression",
  ]),
  javascript: new Set([
    "if_statement",
    "switch_case",
    "switch_default",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "catch_clause",
    "ternary_expression",
  ]),
  python: new Set([
    "if_statement",
    "elif_clause",
    "for_statement",
    "while_statement",
    "except_clause",
    "conditional_expression",
    "case_clause",
  ]),
  go: new Set([
    "if_statement",
    "for_statement",
    "expression_case",
    "type_case",
    "communication_case",
  ]),
  rust: new Set([
    "if_expression",
    "for_expression",
    "while_expression",
    "loop_expression",
    "match_arm",
  ]),
};

const NESTING_NODE_TYPES: Record<SupportedLanguage, ReadonlySet<string>> = {
  typescript: new Set([
    "if_statement",
    "switch_statement",
    "switch_case",
    "switch_default",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "catch_clause",
    "try_statement",
    "ternary_expression",
  ]),
  javascript: new Set([
    "if_statement",
    "switch_statement",
    "switch_case",
    "switch_default",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "catch_clause",
    "try_statement",
    "ternary_expression",
  ]),
  python: new Set([
    "if_statement",
    "elif_clause",
    "for_statement",
    "while_statement",
    "except_clause",
    "conditional_expression",
    "match_statement",
    "case_clause",
  ]),
  go: new Set([
    "if_statement",
    "for_statement",
    "expression_switch_statement",
    "type_switch_statement",
    "select_statement",
    "expression_case",
    "type_case",
    "communication_case",
  ]),
  rust: new Set([
    "if_expression",
    "for_expression",
    "while_expression",
    "loop_expression",
    "match_expression",
    "match_arm",
  ]),
};

export async function analyzeFileComplexity(repoPath: string, filePath: string): Promise<ComplexityAnalysis> {
  const absolutePath = resolveRepoRelativePath(repoPath, filePath);
  const language = detectLanguage(filePath);

  let content: string;
  try {
    content = await readFile(absolutePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        filePath,
        exists: false,
        supported: language !== null,
        language,
        methodologyVersion: COMPLEXITY_METHODOLOGY_VERSION,
        syntaxErrorsPresent: null,
        metrics: null,
        definitions: COMPLEXITY_DEFINITIONS,
        reason: "not_found",
        message: "File not found under the repo root.",
      };
    }
    throw error;
  }

  if (!language) {
    return {
      filePath,
      exists: true,
      supported: false,
      language: null,
      methodologyVersion: COMPLEXITY_METHODOLOGY_VERSION,
      syntaxErrorsPresent: null,
      metrics: null,
      definitions: COMPLEXITY_DEFINITIONS,
      reason: "unsupported_language",
      message: "Supported languages are TypeScript, JavaScript, Python, Go, and Rust.",
    };
  }

  return analyzeComplexityContent(filePath, content, language);
}

export async function analyzeComplexityContent(
  filePath: string,
  content: string,
  language: SupportedLanguage,
): Promise<ComplexityAnalysisSuccess> {
  const parsed = await parseFile(content, language);
  const syntaxTree = await parseSyntaxTree(content, language);

  try {
    const metrics = buildMetrics(content, parsed.symbols, syntaxTree.rootNode, language);
    return {
      filePath,
      exists: true,
      supported: true,
      language,
      methodologyVersion: COMPLEXITY_METHODOLOGY_VERSION,
      syntaxErrorsPresent: syntaxTree.rootNode.hasError(),
      metrics,
      definitions: COMPLEXITY_DEFINITIONS,
    };
  } finally {
    syntaxTree.tree.delete();
  }
}

function buildMetrics(
  content: string,
  symbols: ExtractedSymbol[],
  rootNode: Parser.SyntaxNode,
  language: SupportedLanguage,
): ComplexityMetrics {
  const { loc, nonEmptyLines } = countLines(content);
  const complexity = countControlFlow(rootNode, language);

  return {
    loc,
    nonEmptyLines,
    functionCount: symbols.filter((symbol) => symbol.kind === "function" || symbol.kind === "method").length,
    classCount: symbols.filter((symbol) => symbol.kind === "class").length,
    branchPoints: complexity.branchPoints,
    maxNesting: complexity.maxNesting,
    cyclomaticLike: complexity.branchPoints + 1,
  };
}

function countLines(content: string): { loc: number; nonEmptyLines: number } {
  const lines = content.split("\n");
  return {
    loc: lines.length,
    nonEmptyLines: lines.filter((line) => line.trim().length > 0).length,
  };
}

function countControlFlow(
  rootNode: Parser.SyntaxNode,
  language: SupportedLanguage,
): { branchPoints: number; maxNesting: number } {
  const branchNodes = BRANCH_NODE_TYPES[language];
  const nestingNodes = NESTING_NODE_TYPES[language];
  let branchPoints = 0;
  let maxNesting = 0;

  function walk(node: Parser.SyntaxNode, currentDepth: number): void {
    const nextDepth = nestingNodes.has(node.type) ? currentDepth + 1 : currentDepth;
    if (branchNodes.has(node.type)) branchPoints += 1;
    if (nextDepth > maxNesting) maxNesting = nextDepth;

    for (const child of node.children) {
      walk(child, nextDepth);
    }
  }

  walk(rootNode, 0);
  return { branchPoints, maxNesting };
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
