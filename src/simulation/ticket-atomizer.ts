/**
 * Ticket atomization decision tree.
 *
 * Takes a parent ticket (title, description, affectedPaths) and breaks it
 * into micro/small sub-tickets using file-level complexity metrics and
 * per-function symbol data from the parser.
 *
 * Decision flow:
 *   1 file  → Step 2a (single-file analysis)
 *   2-3     → Step 2b (small-scope, check independence via imports)
 *   4+      → Step 2c (multi-scope, build dep graph, find components)
 *
 * Each emitted ticket gets an estimatedLines heuristic and suggestedModel.
 */

import { readFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import type { ComplexityMetrics } from "../analysis/complexity.js";
import { analyzeFileComplexity } from "../analysis/complexity.js";
import { detectLanguage } from "../git/language.js";
import { parseFile, type ExtractedImport, type ExtractedSymbol } from "../indexing/parser.js";
import type {
  AtomizationInput,
  AtomizationResult,
  AtomizationScope,
  PlanningEvidence,
  TicketAtomicityLevel,
  TicketDescriptor,
  SuggestedModel,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MICRO_LINES = 50;
const MAX_SMALL_LINES = 150;
const COMPLEXITY_SPLIT_LOW = 15;
const COMPLEXITY_SPLIT_HIGH = 30;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function atomizeTicket(
  repoPath: string,
  input: AtomizationInput,
): Promise<AtomizationResult> {
  const { affectedPaths } = input;

  // Filter to paths that exist and have a supported language
  const validPaths: string[] = [];
  const skippedPaths: string[] = [];

  for (const p of affectedPaths) {
    const lang = detectLanguage(p);
    if (!lang) {
      skippedPaths.push(p);
      continue;
    }
    try {
      await readFile(resolve(repoPath, p), "utf8");
      validPaths.push(p);
    } catch {
      skippedPaths.push(p);
    }
  }

  if (validPaths.length === 0) {
    return { descriptors: [], scope: "single_file", skippedPaths };
  }

  // Build complexity map for valid paths not already provided
  for (const p of validPaths) {
    if (!input.complexityByFile.has(p)) {
      const analysis = await analyzeFileComplexity(repoPath, p);
      if (analysis.metrics) {
        input.complexityByFile.set(p, analysis.metrics);
      }
    }
  }

  let scope: AtomizationScope;
  let descriptors: TicketDescriptor[];

  if (validPaths.length === 1) {
    scope = "single_file";
    descriptors = await atomizeSingleFile(repoPath, input, validPaths[0]!);
  } else if (validPaths.length <= 3) {
    scope = "small_scope";
    descriptors = await atomizeSmallScope(repoPath, input, validPaths);
  } else {
    scope = "multi_scope";
    descriptors = await atomizeMultiScope(repoPath, input, validPaths);
  }

  return { descriptors, scope, skippedPaths };
}

// ---------------------------------------------------------------------------
// Step 2a: Single-file analysis
// ---------------------------------------------------------------------------

async function atomizeSingleFile(
  repoPath: string,
  input: AtomizationInput,
  filePath: string,
): Promise<TicketDescriptor[]> {
  const metrics = input.complexityByFile.get(filePath);
  if (!metrics) return [];

  const language = detectLanguage(filePath);
  if (!language) return [];

  const content = await readFile(resolve(repoPath, filePath), "utf8");
  const parsed = await parseFile(content, language);
  const functions = parsed.symbols.filter((s) => s.kind === "function" || s.kind === "method");

  if (metrics.cyclomaticLike <= COMPLEXITY_SPLIT_LOW) {
    // Simple file — one micro ticket for the whole file
    return [
      buildDescriptor({
        input,
        paths: [filePath],
        suffix: filePath,
        atomicity: "micro",
        estimatedLines: estimateLines("refactor", metrics),
      }),
    ];
  }

  if (metrics.cyclomaticLike <= COMPLEXITY_SPLIT_HIGH && functions.length > 3) {
    // Medium complexity — one micro ticket per function
    return functions.map((fn) =>
      buildDescriptor({
        input,
        paths: [filePath],
        suffix: `${fn.name} in ${filePath}`,
        atomicity: "micro",
        estimatedLines: Math.ceil(metrics.nonEmptyLines / functions.length),
        functionTarget: fn,
      }),
    );
  }

  // High complexity — one micro ticket per function (all)
  if (functions.length === 0) {
    return [
      buildDescriptor({
        input,
        paths: [filePath],
        suffix: filePath,
        atomicity: "small",
        estimatedLines: estimateLines("refactor", metrics),
      }),
    ];
  }

  return functions.map((fn) =>
    buildDescriptor({
      input,
      paths: [filePath],
      suffix: `${fn.name} in ${filePath}`,
      atomicity: "micro",
      estimatedLines: Math.ceil(metrics.nonEmptyLines / functions.length),
      functionTarget: fn,
    }),
  );
}

// ---------------------------------------------------------------------------
// Step 2b: Small-scope analysis (2-3 files)
// ---------------------------------------------------------------------------

async function atomizeSmallScope(
  repoPath: string,
  input: AtomizationInput,
  paths: string[],
): Promise<TicketDescriptor[]> {
  // Determine independence by checking import relationships
  const importMap = await buildImportMap(repoPath, paths);
  const independent = areFilesIndependent(paths, importMap);

  if (independent) {
    // Independent files — one micro ticket per file
    const results: TicketDescriptor[] = [];
    for (const p of paths) {
      const singleResult = await atomizeSingleFile(repoPath, input, p);
      results.push(...singleResult);
    }
    return results;
  }

  // Coupled files — one small ticket keeping them together
  const totalMetrics = aggregateMetrics(paths, input.complexityByFile);
  const descriptors: TicketDescriptor[] = [
    buildDescriptor({
      input,
      paths,
      suffix: paths.join(", "),
      atomicity: "small",
      estimatedLines: totalMetrics.nonEmptyLines,
    }),
  ];

  // Check for missing test files and add test tickets
  const testTickets = generateTestTickets(repoPath, input, paths);
  descriptors.push(...testTickets);

  return descriptors;
}

// ---------------------------------------------------------------------------
// Step 2c: Multi-scope decomposition (4+ files)
// ---------------------------------------------------------------------------

async function atomizeMultiScope(
  repoPath: string,
  input: AtomizationInput,
  paths: string[],
): Promise<TicketDescriptor[]> {
  const importMap = await buildImportMap(repoPath, paths);
  const components = findConnectedComponents(paths, importMap);

  const descriptors: TicketDescriptor[] = [];

  for (const component of components) {
    if (component.length <= 3) {
      // Small enough — recurse to small-scope
      const subResult = await atomizeSmallScope(repoPath, input, component);
      descriptors.push(...subResult);
    } else {
      // Large component — emit a prerequisite ticket for shared deps
      // then recurse remaining files
      const sharedDeps = findSharedDependencies(component, importMap);
      if (sharedDeps.length > 0) {
        descriptors.push(
          buildDescriptor({
            input,
            paths: sharedDeps,
            suffix: `shared dependencies: ${sharedDeps.join(", ")}`,
            atomicity: "small",
            estimatedLines: MAX_SMALL_LINES,
            isPrerequisite: true,
          }),
        );
      }

      // Recurse remaining (non-shared) files in smaller groups
      const remaining = component.filter((p) => !sharedDeps.includes(p));
      for (let i = 0; i < remaining.length; i += 3) {
        const chunk = remaining.slice(i, i + 3);
        const subResult = await atomizeSmallScope(repoPath, input, chunk);
        descriptors.push(...subResult);
      }
    }
  }

  return descriptors;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let corpusCounter = 0;

export function resetCorpusCounter(): void {
  corpusCounter = 0;
}

function nextCorpusId(): string {
  corpusCounter += 1;
  return `corpus-${corpusCounter.toString().padStart(4, "0")}`;
}

interface BuildDescriptorOpts {
  input: AtomizationInput;
  paths: string[];
  suffix: string;
  atomicity: TicketAtomicityLevel;
  estimatedLines: number;
  functionTarget?: ExtractedSymbol;
  isPrerequisite?: boolean;
}

function buildDescriptor(opts: BuildDescriptorOpts): TicketDescriptor {
  const { input, paths, suffix, atomicity, estimatedLines, functionTarget, isPrerequisite } = opts;

  // Re-atomize if too large
  const clampedLevel: TicketAtomicityLevel =
    estimatedLines > MAX_SMALL_LINES ? "small" : estimatedLines <= MAX_MICRO_LINES ? "micro" : atomicity;

  const model: SuggestedModel = clampedLevel === "micro" ? "haiku" : "sonnet";

  const titleAction = functionTarget
    ? `Refactor ${functionTarget.name} (line ${functionTarget.line})`
    : isPrerequisite
      ? `Update shared dependencies`
      : input.title;

  const title = `${titleAction} in ${suffix}`;

  return {
    corpusId: nextCorpusId(),
    title: title.length > 120 ? title.slice(0, 117) + "..." : title,
    description: buildDescription(input, paths, functionTarget),
    affectedPaths: paths,
    tags: ["autoresearch", ...(isPrerequisite ? ["prerequisite"] : [])],
    severity: "medium",
    priority: isPrerequisite ? 3 : 5,
    acceptanceCriteria: buildAcceptanceCriteria(paths, functionTarget),
    source: input.parentTicketId ? "backlog_atomized" : "auto_detected",
    atomicityLevel: clampedLevel,
    suggestedModel: model,
    estimatedLines,
    parentTicketId: input.parentTicketId,
    planningEvidence: buildPlanningEvidence(input, paths, functionTarget),
  };
}

function buildDescription(
  input: AtomizationInput,
  paths: string[],
  fn?: ExtractedSymbol,
): string {
  const base = input.description || input.title;
  if (fn) {
    return `${base}\n\nTarget: function/method \`${fn.name}\` at line ${fn.line} in \`${paths[0]}\`.`;
  }
  return `${base}\n\nAffected files: ${paths.map((p) => `\`${p}\``).join(", ")}.`;
}

function buildAcceptanceCriteria(paths: string[], fn?: ExtractedSymbol): string {
  const items = ["All existing tests pass after changes."];
  if (fn) {
    items.push(`Function \`${fn.name}\` is refactored with reduced complexity.`);
  }
  items.push(`Files modified: ${paths.join(", ")}.`);
  items.push("No new lint errors introduced.");
  return items.join("\n");
}

function buildPlanningEvidence(
  input: AtomizationInput,
  paths: string[],
  fn?: ExtractedSymbol,
): PlanningEvidence {
  return {
    summary: fn
      ? `Refactor \`${fn.name}\` in \`${paths[0]}\` to reduce complexity.`
      : `Address: ${input.title}`,
    approach: fn
      ? "Extract logic, simplify control flow, improve readability."
      : "Apply targeted changes to affected files.",
    affectedAreas: paths,
    riskAssessment: "Low — changes scoped to specific functions/files with existing test coverage.",
    testPlan: "Run existing test suite. Verify no regressions.",
  };
}

function estimateLines(
  ticketType: "refactor" | "test" | "bug",
  metrics: ComplexityMetrics,
): number {
  switch (ticketType) {
    case "refactor":
      return metrics.cyclomaticLike * 3;
    case "test":
      return metrics.functionCount * 15;
    case "bug":
      return metrics.branchPoints * 2;
  }
}

// ---------------------------------------------------------------------------
// Import analysis
// ---------------------------------------------------------------------------

type ImportMap = Map<string, ExtractedImport[]>;

async function buildImportMap(repoPath: string, paths: string[]): Promise<ImportMap> {
  const map: ImportMap = new Map();
  for (const p of paths) {
    const lang = detectLanguage(p);
    if (!lang) continue;
    try {
      const content = await readFile(resolve(repoPath, p), "utf8");
      const parsed = await parseFile(content, lang);
      map.set(p, parsed.imports);
    } catch {
      map.set(p, []);
    }
  }
  return map;
}

/**
 * Two files are "independent" if neither imports from the other
 * (resolved relative to their directories within the repo).
 */
function areFilesIndependent(paths: string[], importMap: ImportMap): boolean {
  for (const p of paths) {
    const imports = importMap.get(p) ?? [];
    for (const imp of imports) {
      // Resolve relative import to see if it points to another affected file
      if (imp.source.startsWith(".")) {
        const resolvedImport = normalizeImportPath(p, imp.source);
        if (paths.some((other) => other !== p && pathMatches(other, resolvedImport))) {
          return false;
        }
      }
    }
  }
  return true;
}

function findConnectedComponents(paths: string[], importMap: ImportMap): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const p of paths) adjacency.set(p, new Set());

  for (const p of paths) {
    const imports = importMap.get(p) ?? [];
    for (const imp of imports) {
      if (imp.source.startsWith(".")) {
        const resolved = normalizeImportPath(p, imp.source);
        const match = paths.find((other) => other !== p && pathMatches(other, resolved));
        if (match) {
          adjacency.get(p)!.add(match);
          adjacency.get(match)!.add(p);
        }
      }
    }
  }

  const visited = new Set<string>();
  const components: string[][] = [];

  for (const p of paths) {
    if (visited.has(p)) continue;
    const component: string[] = [];
    const queue = [p];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    components.push(component);
  }

  return components;
}

function findSharedDependencies(component: string[], importMap: ImportMap): string[] {
  // Files imported by 2+ other files in the component
  const importCount = new Map<string, number>();
  for (const p of component) {
    const imports = importMap.get(p) ?? [];
    for (const imp of imports) {
      if (imp.source.startsWith(".")) {
        const resolved = normalizeImportPath(p, imp.source);
        const match = component.find((other) => other !== p && pathMatches(other, resolved));
        if (match) {
          importCount.set(match, (importCount.get(match) ?? 0) + 1);
        }
      }
    }
  }

  return [...importCount.entries()].filter(([, count]) => count >= 2).map(([path]) => path);
}

function normalizeImportPath(fromFile: string, importSource: string): string {
  const dir = dirname(fromFile);
  return relative(".", resolve(dir, importSource));
}

function pathMatches(filePath: string, importResolved: string): boolean {
  // Strip extension from filePath for comparison
  const withoutExt = filePath.replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, "");
  const importClean = importResolved.replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, "");
  return withoutExt === importClean || filePath === importResolved;
}

function aggregateMetrics(
  paths: string[],
  metricsMap: Map<string, ComplexityMetrics>,
): ComplexityMetrics {
  const aggregate: ComplexityMetrics = {
    loc: 0,
    nonEmptyLines: 0,
    functionCount: 0,
    classCount: 0,
    branchPoints: 0,
    maxNesting: 0,
    cyclomaticLike: 1,
  };

  for (const p of paths) {
    const m = metricsMap.get(p);
    if (!m) continue;
    aggregate.loc += m.loc;
    aggregate.nonEmptyLines += m.nonEmptyLines;
    aggregate.functionCount += m.functionCount;
    aggregate.classCount += m.classCount;
    aggregate.branchPoints += m.branchPoints;
    aggregate.maxNesting = Math.max(aggregate.maxNesting, m.maxNesting);
    aggregate.cyclomaticLike += m.branchPoints; // sum branchPoints + 1 base
  }

  return aggregate;
}

function generateTestTickets(
  _repoPath: string,
  input: AtomizationInput,
  paths: string[],
): TicketDescriptor[] {
  const tickets: TicketDescriptor[] = [];

  for (const p of paths) {
    // Skip if file is already a test file
    if (p.includes(".test.") || p.includes(".spec.") || p.includes("__tests__")) continue;

    // Check if a test file likely exists by naming convention
    const testPath = p.replace(/\.(ts|tsx|js|jsx)$/, ".test.$1");
    // We don't check disk here — anti-basura will validate later.
    // Just generate the ticket; if tests already exist, dedup catches it.

    const metrics = input.complexityByFile.get(p);
    tickets.push(
      buildDescriptor({
        input,
        paths: [p, testPath],
        suffix: p,
        atomicity: "micro",
        estimatedLines: metrics ? estimateLines("test", metrics) : 30,
      }),
    );
  }

  return tickets;
}
