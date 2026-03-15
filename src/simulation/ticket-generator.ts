/**
 * Ticket generator: produces atomic TicketDescriptors from 3 sources.
 *
 * Source 1: Existing backlog/approved tickets → atomize into sub-tasks
 * Source 2: Auto-detection from code analysis (complexity, nesting, LOC, missing tests, coupling)
 * Source 3: Manual ticket descriptors (passed in)
 *
 * All descriptors pass through anti-basura validation before inclusion in the corpus.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, sql, inArray } from "drizzle-orm";
import { analyzeFileComplexity, type ComplexityMetrics } from "../analysis/complexity.js";
import { detectLanguage } from "../git/language.js";
import type * as dbSchema from "../db/schema.js";
import { files, imports, tickets } from "../db/schema.js";
import { atomizeTicket, resetCorpusCounter } from "./ticket-atomizer.js";
import { validateBatch, type AntiBasuraContext } from "./anti-basura.js";
import type {
  AutoDetectedIssue,
  AutoDetectionSignal,
  CorpusSources,
  PlanningEvidence,
  SimulationCorpus,
  TicketDescriptor,
  RejectionReason,
} from "./types.js";

// ---------------------------------------------------------------------------
// Auto-detection thresholds (Source 2)
// ---------------------------------------------------------------------------

const THRESHOLDS: Record<AutoDetectionSignal, number> = {
  high_complexity: 20,
  deep_nesting: 4,
  large_file: 400,
  missing_tests: 0, // binary: has test file or not
  high_coupling: 10,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type DB = BetterSQLite3Database<typeof dbSchema>;

export interface GeneratorConfig {
  repoPath: string;
  db: DB;
  repoId: number;
  gitCommit: string;
  /** Manual ticket descriptors (Source 3). */
  manualDescriptors?: TicketDescriptor[];
  /** Max tickets to generate (0 = unlimited). */
  targetCorpusSize?: number;
  /** Skip specific sources. */
  skipSources?: Array<"backlog" | "auto" | "manual">;
}

export interface GeneratorResult {
  corpus: SimulationCorpus;
  sources: CorpusSources;
}

export async function generateCorpus(config: GeneratorConfig): Promise<GeneratorResult> {
  resetCorpusCounter();

  const allDescriptors: TicketDescriptor[] = [];
  const allRejections: SimulationCorpus["rejections"] = [];
  const sources: CorpusSources = { backlog: 0, autoDetected: 0, manual: 0 };
  const skip = new Set(config.skipSources ?? []);

  // Collect existing ticket titles for dedup
  const existingTicketRows = config.db
    .select({ title: tickets.title })
    .from(tickets)
    .all();
  const existingTitles = existingTicketRows.map((r) => r.title);

  const ctx: AntiBasuraContext = {
    repoPath: config.repoPath,
    existingTitles,
    corpusTitles: [],
  };

  // Source 1: Atomize existing backlog/approved tickets
  if (!skip.has("backlog")) {
    const backlogDescriptors = await generateFromBacklog(config);
    const { valid, rejected } = await validateBatch(backlogDescriptors, ctx);
    allDescriptors.push(...valid);
    sources.backlog = valid.length;
    for (const r of rejected) {
      allRejections.push({
        title: r.descriptor.title,
        reason: r.result.rejections[0]?.reason ?? ("unknown" as RejectionReason),
        message: r.result.rejections.map((rj) => rj.message).join("; "),
      });
    }
  }

  // Source 2: Auto-detection from code analysis
  if (!skip.has("auto")) {
    const autoDescriptors = await generateFromCodeAnalysis(config);
    const { valid, rejected } = await validateBatch(autoDescriptors, ctx);
    allDescriptors.push(...valid);
    sources.autoDetected = valid.length;
    for (const r of rejected) {
      allRejections.push({
        title: r.descriptor.title,
        reason: r.result.rejections[0]?.reason ?? ("unknown" as RejectionReason),
        message: r.result.rejections.map((rj) => rj.message).join("; "),
      });
    }
  }

  // Source 3: Manual descriptors
  if (!skip.has("manual") && config.manualDescriptors) {
    const { valid, rejected } = await validateBatch(config.manualDescriptors, ctx);
    allDescriptors.push(...valid);
    sources.manual = valid.length;
    for (const r of rejected) {
      allRejections.push({
        title: r.descriptor.title,
        reason: r.result.rejections[0]?.reason ?? ("unknown" as RejectionReason),
        message: r.result.rejections.map((rj) => rj.message).join("; "),
      });
    }
  }

  // Apply target corpus size limit
  const target = config.targetCorpusSize ?? 0;
  const finalDescriptors = target > 0 ? allDescriptors.slice(0, target) : allDescriptors;

  const corpus: SimulationCorpus = {
    generatedAt: new Date().toISOString(),
    gitCommit: config.gitCommit,
    descriptors: finalDescriptors,
    rejections: allRejections,
  };

  return { corpus, sources };
}

// ---------------------------------------------------------------------------
// Source 1: Backlog atomization
// ---------------------------------------------------------------------------

async function generateFromBacklog(config: GeneratorConfig): Promise<TicketDescriptor[]> {
  const atomizableStatuses = ["backlog", "approved", "technical_analysis"];

  const ticketRows = config.db
    .select({
      ticketId: tickets.ticketId,
      title: tickets.title,
      description: tickets.description,
      status: tickets.status,
      affectedPathsJson: tickets.affectedPathsJson,
    })
    .from(tickets)
    .where(
      sql`${tickets.repoId} = ${config.repoId} AND ${tickets.status} IN (${sql.join(
        atomizableStatuses.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    )
    .all();

  const allDescriptors: TicketDescriptor[] = [];

  for (const row of ticketRows) {
    const affectedPaths: string[] = row.affectedPathsJson
      ? JSON.parse(row.affectedPathsJson)
      : [];

    if (affectedPaths.length === 0) continue;

    // Build complexity map (skip directories and missing files)
    const complexityByFile = new Map<string, ComplexityMetrics>();
    for (const p of affectedPaths) {
      try {
        const s = await stat(resolve(config.repoPath, p));
        if (!s.isFile()) continue;
      } catch { continue; }
      const analysis = await analyzeFileComplexity(config.repoPath, p);
      if (analysis.metrics) {
        complexityByFile.set(p, analysis.metrics);
      }
    }

    const result = await atomizeTicket(config.repoPath, {
      title: row.title,
      description: row.description,
      affectedPaths,
      parentTicketId: row.ticketId,
      complexityByFile,
    });

    allDescriptors.push(...result.descriptors);
  }

  return allDescriptors;
}

// ---------------------------------------------------------------------------
// Source 2: Auto-detection from code analysis
// ---------------------------------------------------------------------------

async function generateFromCodeAnalysis(config: GeneratorConfig): Promise<TicketDescriptor[]> {
  const issues = await detectIssues(config);
  return issues.map((issue) => issueToDescriptor(issue));
}

async function detectIssues(config: GeneratorConfig): Promise<AutoDetectedIssue[]> {
  const issues: AutoDetectedIssue[] = [];

  // Get all indexed source files
  const fileRows = config.db
    .select({ id: files.id, path: files.path, language: files.language })
    .from(files)
    .where(eq(files.repoId, config.repoId))
    .all();

  const sourceFiles = fileRows.filter((f) => {
    // Skip test files, config files, generated files
    if (!f.language) return false;
    if (f.path.includes(".test.") || f.path.includes(".spec.")) return false;
    if (f.path.includes("__tests__")) return false;
    if (f.path.includes("node_modules")) return false;
    if (f.path.endsWith(".d.ts")) return false;
    return true;
  });

  for (const file of sourceFiles) {
    // Complexity analysis (skip directories and missing files)
    try {
      const s = await stat(resolve(config.repoPath, file.path));
      if (!s.isFile()) continue;
    } catch { continue; }
    const analysis = await analyzeFileComplexity(config.repoPath, file.path);
    if (!analysis.metrics) continue;

    const m = analysis.metrics;

    if (m.cyclomaticLike > THRESHOLDS.high_complexity) {
      issues.push({
        signal: "high_complexity",
        filePath: file.path,
        value: m.cyclomaticLike,
        threshold: THRESHOLDS.high_complexity,
        ticketType: `Reduce complexity in \`${file.path}\``,
        atomicityLevel: "micro",
      });
    }

    if (m.maxNesting >= THRESHOLDS.deep_nesting) {
      issues.push({
        signal: "deep_nesting",
        filePath: file.path,
        value: m.maxNesting,
        threshold: THRESHOLDS.deep_nesting,
        ticketType: `Flatten nested logic in \`${file.path}\``,
        atomicityLevel: "micro",
      });
    }

    if (m.loc > THRESHOLDS.large_file) {
      issues.push({
        signal: "large_file",
        filePath: file.path,
        value: m.loc,
        threshold: THRESHOLDS.large_file,
        ticketType: `Split \`${file.path}\` into focused modules`,
        atomicityLevel: "small",
      });
    }

    // Missing test coverage (convention-based)
    if (hasNoTestFile(file.path, sourceFiles.map((f) => f.path))) {
      issues.push({
        signal: "missing_tests",
        filePath: file.path,
        value: 0,
        threshold: 0,
        ticketType: `Add tests for \`${file.path}\``,
        atomicityLevel: "micro",
      });
    }
  }

  // High coupling (import fan-out > 10)
  await detectHighCoupling(config.db, sourceFiles, issues);

  return issues;
}

async function detectHighCoupling(
  db: DB,
  sourceFiles: Array<{ id: number; path: string; language: string | null }>,
  issues: AutoDetectedIssue[],
): Promise<void> {
  const fileIds = sourceFiles.map((f) => f.id);
  if (fileIds.length === 0) return;

  // Query import fan-out per source file
  const fanOutRows = db
    .select({
      sourceFileId: imports.sourceFileId,
      count: sql<number>`COUNT(*)`,
    })
    .from(imports)
    .where(inArray(imports.sourceFileId, fileIds))
    .groupBy(imports.sourceFileId)
    .all();

  const fileById = new Map(sourceFiles.map((f) => [f.id, f]));

  for (const row of fanOutRows) {
    if (row.count > THRESHOLDS.high_coupling) {
      const file = fileById.get(row.sourceFileId);
      if (!file) continue;
      issues.push({
        signal: "high_coupling",
        filePath: file.path,
        value: row.count,
        threshold: THRESHOLDS.high_coupling,
        ticketType: `Reduce coupling in \`${file.path}\``,
        atomicityLevel: "small",
      });
    }
  }
}

function hasNoTestFile(filePath: string, allPaths: string[]): boolean {
  const lang = detectLanguage(filePath);
  if (!lang || !["typescript", "javascript"].includes(lang)) return false;

  // Check common test file patterns
  const testPatterns = [
    filePath.replace(/\.(ts|tsx|js|jsx)$/, ".test.$1"),
    filePath.replace(/\.(ts|tsx|js|jsx)$/, ".spec.$1"),
    filePath.replace(/^src\//, "tests/unit/").replace(/\.(ts|tsx|js|jsx)$/, ".test.$1"),
    filePath.replace(/^src\//, "tests/").replace(/\.(ts|tsx|js|jsx)$/, ".test.$1"),
  ];

  return !testPatterns.some((pattern) =>
    allPaths.some((p) => p === pattern),
  );
}

// ---------------------------------------------------------------------------
// Issue → Descriptor conversion
// ---------------------------------------------------------------------------

function issueToDescriptor(issue: AutoDetectedIssue): TicketDescriptor {
  const evidence: PlanningEvidence = {
    summary: issue.ticketType,
    approach: describeApproach(issue),
    affectedAreas: [issue.filePath],
    riskAssessment: "Low — single-file change with existing test coverage.",
    testPlan: "Run existing tests. Verify no regressions.",
  };

  return {
    corpusId: `auto-${issue.signal}-${sanitizeForId(issue.filePath)}`,
    title: issue.ticketType,
    description: buildIssueDescription(issue),
    affectedPaths: [issue.filePath],
    tags: ["autoresearch", issue.signal],
    severity: "medium",
    priority: 5,
    acceptanceCriteria: buildIssueAcceptanceCriteria(issue),
    source: "auto_detected",
    atomicityLevel: issue.atomicityLevel,
    suggestedModel: issue.atomicityLevel === "micro" ? "haiku" : "sonnet",
    estimatedLines: estimateIssueLines(issue),
    planningEvidence: evidence,
  };
}

function describeApproach(issue: AutoDetectedIssue): string {
  switch (issue.signal) {
    case "high_complexity":
      return "Extract complex logic into smaller functions, simplify conditional chains.";
    case "deep_nesting":
      return "Apply early returns, extract nested blocks into named functions.";
    case "large_file":
      return "Identify cohesive groups of exports and move them to dedicated modules.";
    case "missing_tests":
      return "Add unit tests covering the module's public API and edge cases.";
    case "high_coupling":
      return "Introduce facade or mediator patterns to reduce direct dependencies.";
  }
}

function buildIssueDescription(issue: AutoDetectedIssue): string {
  const signal = issue.signal.replace(/_/g, " ");
  return (
    `Auto-detected: ${signal} in \`${issue.filePath}\`.\n\n` +
    `Current value: ${issue.value} (threshold: ${issue.threshold}).\n` +
    `Approach: ${describeApproach(issue)}`
  );
}

function buildIssueAcceptanceCriteria(issue: AutoDetectedIssue): string {
  const base = "All existing tests pass after changes.\nNo new lint errors introduced.";
  switch (issue.signal) {
    case "high_complexity":
      return `${base}\nCyclomatic complexity reduced below ${issue.threshold}.`;
    case "deep_nesting":
      return `${base}\nMax nesting depth reduced below ${issue.threshold}.`;
    case "large_file":
      return `${base}\nFile LOC reduced below ${issue.threshold}.`;
    case "missing_tests":
      return `${base}\nUnit tests added with meaningful coverage for public API.`;
    case "high_coupling":
      return `${base}\nImport fan-out reduced below ${issue.threshold}.`;
  }
}

function estimateIssueLines(issue: AutoDetectedIssue): number {
  switch (issue.signal) {
    case "high_complexity":
      return Math.min(issue.value * 3, 150);
    case "deep_nesting":
      return Math.min(issue.value * 10, 80);
    case "large_file":
      return 150; // splitting always produces ~150 lines of changes
    case "missing_tests":
      return 50;
    case "high_coupling":
      return Math.min(issue.value * 5, 150);
  }
}

function sanitizeForId(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").slice(0, 40);
}
