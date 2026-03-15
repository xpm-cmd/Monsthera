/**
 * Simulation runner — 4-phase orchestration.
 *
 * Phase A: Generate corpus (ticket descriptors from 3 sources)
 * Phase B: Measure infrastructure (sandbox DB, FTS5 retrieval quality)
 * Phase C: Execute real work (dev loop + council, sequential)
 * Phase D: Persist results + compare with previous runs
 *
 * Each phase is independently runnable via the `phase` parameter.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { sql } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import { tickets } from "../db/schema.js";
import { generateCorpus, type GeneratorConfig } from "./ticket-generator.js";
import { createSandbox, registerSandboxAgent } from "./harness.js";
import { TelemetryTracker } from "./telemetry.js";
import {
  computeScorecard,
  appendResult,
  readResults,
  computeDeltas,
  type MetricsInput,
} from "./metrics.js";
import type {
  SimulationCorpus,
  SimulationPhase,
  SimulationResult,
  TicketDescriptor,
} from "./types.js";
import type { WorkflowRuntime, WorkflowSpec } from "../workflows/types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunnerConfig {
  /** Production DB handle. */
  db: BetterSQLite3Database<typeof schema>;
  sqlite: DatabaseType;
  repoId: number;
  repoPath: string;

  /** Which phases to run. "all" = A+B+C+D. */
  phase: "all" | SimulationPhase;

  /** Max tickets to generate in Phase A. */
  targetCorpusSize: number;
  /** Max tickets to process in Phase C. */
  realWorkBatchSize: number;
  /** Skip Phase C (real work). */
  skipRealWork: boolean;

  /** JSONL output path. */
  outputPath: string;

  /** Callback for progress reporting. */
  onProgress?: (event: ProgressEvent) => void;

  /** Workflow dependencies for Phase C real work execution. */
  workflow?: {
    /** Resolved developer-loop workflow spec. */
    spec: WorkflowSpec;
    /** Workflow runtime (tool runner, actor, hooks). */
    runtime: WorkflowRuntime;
    /** Per-ticket timeout in ms (default: 120_000). */
    ticketTimeoutMs?: number;
  };
}

export interface ProgressEvent {
  phase: SimulationPhase;
  message: string;
  detail?: Record<string, unknown>;
}

export interface RunnerResult {
  runId: string;
  phasesRun: SimulationPhase[];
  corpus: SimulationCorpus | null;
  result: SimulationResult | null;
  summary: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runSimulation(config: RunnerConfig): Promise<RunnerResult> {
  const runId = `sim-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  const phasesRun: SimulationPhase[] = [];
  const telemetry = new TelemetryTracker();
  const emit = config.onProgress ?? (() => {});

  let corpus: SimulationCorpus | null = null;
  let gitCommit = "unknown";

  try {
    const result = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: config.repoPath,
    });
    gitCommit = result.stdout.trim();
  } catch {
    // Non-critical
  }

  const shouldRun = (p: SimulationPhase) => config.phase === "all" || config.phase === p;

  // ─── Phase A: Generate Corpus ───────────────────────────
  if (shouldRun("A")) {
    emit({ phase: "A", message: "Generating corpus..." });
    phasesRun.push("A");

    const genConfig: GeneratorConfig = {
      repoPath: config.repoPath,
      db: config.db,
      repoId: config.repoId,
      gitCommit,
      targetCorpusSize: config.targetCorpusSize,
    };

    const genResult = await generateCorpus(genConfig);
    corpus = genResult.corpus;

    // Cache corpus to disk
    const corpusPath = resolve(config.repoPath, ".agora/simulation-corpus.json");
    await writeFile(corpusPath, JSON.stringify(corpus, null, 2), "utf8");

    emit({
      phase: "A",
      message: `Corpus generated: ${corpus.descriptors.length} tickets (${genResult.sources.backlog} backlog, ${genResult.sources.autoDetected} auto, ${genResult.sources.manual} manual). ${corpus.rejections.length} rejected.`,
      detail: { sources: genResult.sources, rejected: corpus.rejections.length },
    });
  }

  // ─── Phase B: Measure Infrastructure (sandbox) ──────────
  let ticketRetrievalP5 = 0;
  let codeRetrievalP5 = 0;

  if (shouldRun("B") && corpus) {
    emit({ phase: "B", message: "Sandbox measurement..." });
    phasesRun.push("B");

    const sandboxResult = await runPhaseB(config, corpus, emit);
    ticketRetrievalP5 = sandboxResult.ticketRetrievalP5;
    codeRetrievalP5 = sandboxResult.codeRetrievalP5;

    emit({
      phase: "B",
      message: `Sandbox: ticket-retrieval@5=${ticketRetrievalP5.toFixed(2)}, code-retrieval@5=${codeRetrievalP5.toFixed(2)}`,
    });
  }

  // ─── Phase C: Execute Real Work ─────────────────────────
  let testPassRate = 1;
  let regressionRate = 0;
  let mergeSuccessRate = 1;
  let workflowOverheadPct = 0;

  if (shouldRun("C") && corpus && !config.skipRealWork) {
    emit({ phase: "C", message: "Real work execution..." });
    phasesRun.push("C");

    const phaseCResult = await runPhaseC(config, corpus, telemetry, emit);
    testPassRate = phaseCResult.testPassRate;
    regressionRate = phaseCResult.regressionRate;
    mergeSuccessRate = phaseCResult.mergeSuccessRate;
    workflowOverheadPct = phaseCResult.workflowOverheadPct;
  } else if (shouldRun("C") && config.skipRealWork) {
    emit({ phase: "C", message: "Phase C skipped (skipRealWork=true)" });
  }

  // ─── Phase D: Persist & Compare ─────────────────────────
  let simResult: SimulationResult | null = null;

  if (shouldRun("D") && corpus) {
    emit({ phase: "D", message: "Persisting results..." });
    phasesRun.push("D");

    const metricsInput: MetricsInput = {
      db: config.db,
      repoId: config.repoId,
      telemetry,
      ticketRetrievalPrecision5: ticketRetrievalP5,
      codeRetrievalPrecision5: codeRetrievalP5,
      testPassRate,
      regressionRate,
      mergeSuccessRate,
      workflowOverheadPct,
    };

    const scorecard = computeScorecard(metricsInput);
    const previousResults = await readResults(config.outputPath);
    const previousScorecard = previousResults.length > 0
      ? {
          velocity: previousResults[previousResults.length - 1]!.velocity,
          autonomy: previousResults[previousResults.length - 1]!.autonomy,
          quality: previousResults[previousResults.length - 1]!.quality,
          cost: previousResults[previousResults.length - 1]!.cost,
          compositeScore: previousResults[previousResults.length - 1]!.compositeScore,
        }
      : null;
    const deltas = computeDeltas(scorecard, previousScorecard);

    const _telemetrySummary = telemetry.summarize();

    simResult = {
      runId,
      timestamp: new Date().toISOString(),
      gitCommit,
      corpusSize: corpus.descriptors.length,
      durationMs: Date.now() - startedAt,
      sources: {
        backlog: corpus.descriptors.filter((d) => d.source === "backlog_atomized").length,
        autoDetected: corpus.descriptors.filter((d) => d.source === "auto_detected").length,
        manual: corpus.descriptors.filter((d) => d.source === "manual").length,
      },
      phasesRun,
      velocity: scorecard.velocity,
      autonomy: scorecard.autonomy,
      quality: scorecard.quality,
      cost: scorecard.cost,
      compositeScore: scorecard.compositeScore,
      deltas,
    };

    await appendResult(config.outputPath, simResult);

    const deltaStr = deltas ? ` (${deltas.composite >= 0 ? "+" : ""}${deltas.composite.toFixed(3)})` : "";
    emit({
      phase: "D",
      message: `Results persisted. Composite=${scorecard.compositeScore.toFixed(3)}${deltaStr}`,
    });
  }

  const summary = buildSummary(runId, phasesRun, corpus, simResult);

  return { runId, phasesRun, corpus, result: simResult, summary };
}

// ---------------------------------------------------------------------------
// Phase B: Sandbox measurement
// ---------------------------------------------------------------------------

interface PhaseBResult {
  ticketRetrievalP5: number;
  codeRetrievalP5: number;
}

async function runPhaseB(
  config: RunnerConfig,
  corpus: SimulationCorpus,
  emit: (e: ProgressEvent) => void,
): Promise<PhaseBResult> {
  const sandbox = createSandbox({ repoPath: config.repoPath });

  try {
    const { agentId, sessionId } = registerSandboxAgent(sandbox, "sim-phase-b");

    // Bulk-create all corpus tickets in sandbox
    let created = 0;
    for (const descriptor of corpus.descriptors) {
      createTicketInSandbox(sandbox.db, sandbox.repoId, descriptor, agentId, sessionId);
      created++;
    }

    // Rebuild FTS5 index
    sandbox.fts5.rebuildTicketFts(sandbox.repoId);

    emit({
      phase: "B",
      message: `Created ${created} tickets in sandbox. Measuring retrieval quality...`,
    });

    // Ticket retrieval quality: for each ticket, search by a topic keyword
    let ticketHits = 0;
    let ticketQueries = 0;
    const sampleSize = Math.min(corpus.descriptors.length, 50);
    const sample = corpus.descriptors.slice(0, sampleSize);

    for (const descriptor of sample) {
      const queryTerm = extractSearchTerm(descriptor.title);
      if (!queryTerm) continue;

      ticketQueries++;
      const results = sandbox.fts5.searchTickets(queryTerm, sandbox.repoId, 5);
      const found = results.some((r) => r.title === descriptor.title);
      if (found) ticketHits++;
    }

    // Code retrieval quality: check if affectedPaths match get_code_pack results
    // For sandbox, we measure against indexed files
    let codeHits = 0;
    let codeQueries = 0;

    for (const descriptor of sample) {
      if (descriptor.affectedPaths.length === 0) continue;
      codeQueries++;
      // Simple heuristic: check if any affected path exists in indexed files
      const firstPath = descriptor.affectedPaths[0]!;
      const exists = sandbox.db
        .select({ id: sql`1` })
        .from(sql`files`)
        .where(sql`path = ${firstPath}`)
        .limit(1)
        .all();
      if (exists.length > 0) codeHits++;
    }

    return {
      ticketRetrievalP5: ticketQueries > 0 ? ticketHits / ticketQueries : 0,
      codeRetrievalP5: codeQueries > 0 ? codeHits / codeQueries : 0,
    };
  } finally {
    sandbox.dispose();
  }
}

// ---------------------------------------------------------------------------
// Phase C: Real work execution (stub for V1 — sequential, single agent)
// ---------------------------------------------------------------------------

interface PhaseCResult {
  testPassRate: number;
  regressionRate: number;
  mergeSuccessRate: number;
  workflowOverheadPct: number;
}

async function runPhaseC(
  config: RunnerConfig,
  corpus: SimulationCorpus,
  telemetry: TelemetryTracker,
  emit: (e: ProgressEvent) => void,
): Promise<PhaseCResult> {
  const hasWorkflow = !!config.workflow;

  const batch = corpus.descriptors.slice(0, config.realWorkBatchSize);
  let resolved = 0;
  let failed = 0;
  let timedOut = 0;
  let totalWorkflowMs = 0;
  let totalElapsedMs = 0;
  const ticketTimeoutMs = config.workflow?.ticketTimeoutMs ?? 120_000;

  for (let i = 0; i < batch.length; i++) {
    const descriptor = batch[i]!;
    const ticketStartMs = Date.now();

    telemetry.startTicket(descriptor.corpusId, descriptor.suggestedModel);

    emit({
      phase: "C",
      message: `[${i + 1}/${batch.length}] ${descriptor.title}`,
      detail: { model: descriptor.suggestedModel, corpusId: descriptor.corpusId },
    });

    // Create the ticket in production DB
    const ticketId = createTicketInProduction(config, descriptor);
    if (!ticketId) {
      telemetry.completeTicket(descriptor.corpusId, "failed");
      failed++;
      continue;
    }
    telemetry.setTicketId(descriptor.corpusId, ticketId);

    // Transition to approved so the dev loop can pick it up
    try {
      config.db.update(tickets)
        .set({ status: "approved", updatedAt: new Date().toISOString() })
        .where(sql`ticket_id = ${ticketId} AND repo_id = ${config.repoId}`)
        .run();
    } catch {
      // Non-critical — ticket stays in backlog
    }

    if (hasWorkflow) {
      // Run the developer-loop workflow with timeout
      const workflowResult = await runTicketWorkflow(
        config,
        ticketId,
        descriptor,
        ticketTimeoutMs,
        emit,
      );

      const elapsed = Date.now() - ticketStartMs;
      totalElapsedMs += elapsed;
      totalWorkflowMs += workflowResult.workflowDurationMs;

      telemetry.addPayload(
        descriptor.corpusId,
        workflowResult.inputChars,
        workflowResult.outputChars,
      );

      if (workflowResult.status === "completed") {
        telemetry.completeTicket(descriptor.corpusId, "resolved");
        resolved++;
      } else if (workflowResult.status === "timeout") {
        telemetry.completeTicket(descriptor.corpusId, "escalated");
        timedOut++;
      } else {
        telemetry.completeTicket(descriptor.corpusId, "failed");
        failed++;
      }

      emit({
        phase: "C",
        message: `[${i + 1}/${batch.length}] ${workflowResult.status} in ${(elapsed / 1000).toFixed(1)}s`,
      });
    } else {
      // Stub mode: mark as resolved with synthetic timing
      const elapsed = Date.now() - ticketStartMs;
      totalElapsedMs += elapsed;
      totalWorkflowMs += elapsed * 0.15;
      telemetry.addPayload(descriptor.corpusId, descriptor.description.length, 500);
      telemetry.completeTicket(descriptor.corpusId, "resolved");
      resolved++;
    }
  }

  const total = resolved + failed + timedOut;
  emit({
    phase: "C",
    message: `Phase C complete: ${resolved} resolved, ${failed} failed, ${timedOut} timed out (${total}/${batch.length})`,
  });

  return {
    testPassRate: total > 0 ? resolved / total : 0,
    regressionRate: total > 0 ? failed / total : 0,
    mergeSuccessRate: batch.length > 0 ? resolved / batch.length : 1,
    workflowOverheadPct: totalElapsedMs > 0 ? totalWorkflowMs / totalElapsedMs : 0,
  };
}

// ---------------------------------------------------------------------------
// Workflow execution per ticket
// ---------------------------------------------------------------------------

interface TicketWorkflowResult {
  status: "completed" | "failed" | "timeout";
  workflowDurationMs: number;
  inputChars: number;
  outputChars: number;
}

async function runTicketWorkflow(
  config: RunnerConfig,
  ticketId: string,
  descriptor: TicketDescriptor,
  timeoutMs: number,
  emit: (e: ProgressEvent) => void,
): Promise<TicketWorkflowResult> {
  const wf = config.workflow!;
  const { runWorkflow } = await import("../workflows/engine.js");

  const workflowStart = Date.now();

  // Prepare params for the developer-loop workflow
  const params: Record<string, unknown> = {
    ticketId,
    limit: 5,
  };

  // Estimate input size from ticket content
  const inputChars = descriptor.title.length + descriptor.description.length
    + (descriptor.acceptanceCriteria?.length ?? 0);

  try {
    // Run with timeout
    const result = await Promise.race([
      runWorkflow(wf.spec, wf.runtime, params),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    const workflowDurationMs = Date.now() - workflowStart;

    if (result === null) {
      emit({
        phase: "C",
        message: `Ticket ${ticketId} timed out after ${(timeoutMs / 1000).toFixed(0)}s`,
      });
      return {
        status: "timeout",
        workflowDurationMs,
        inputChars,
        outputChars: 0,
      };
    }

    // Estimate output size from step results
    const outputChars = JSON.stringify(result.outputs).length;

    return {
      status: result.status === "completed" ? "completed" : "failed",
      workflowDurationMs,
      inputChars,
      outputChars,
    };
  } catch (err) {
    emit({
      phase: "C",
      message: `Ticket ${ticketId} workflow error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      status: "failed",
      workflowDurationMs: Date.now() - workflowStart,
      inputChars,
      outputChars: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTicketInSandbox(
  db: BetterSQLite3Database<typeof schema>,
  repoId: number,
  descriptor: TicketDescriptor,
  agentId: string,
  sessionId: string,
): void {
  const now = new Date().toISOString();
  db.insert(tickets).values({
    repoId,
    ticketId: `TKT-${descriptor.corpusId}`,
    title: descriptor.title,
    description: descriptor.description,
    status: "backlog",
    severity: descriptor.severity,
    priority: descriptor.priority,
    tagsJson: JSON.stringify(descriptor.tags),
    affectedPathsJson: JSON.stringify(descriptor.affectedPaths),
    acceptanceCriteria: descriptor.acceptanceCriteria,
    creatorAgentId: agentId,
    creatorSessionId: sessionId,
    commitSha: "sandbox",
    requiredRolesJson: null,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function createTicketInProduction(
  config: RunnerConfig,
  descriptor: TicketDescriptor,
): string | null {
  const now = new Date().toISOString();
  const ticketId = `TKT-sim-${descriptor.corpusId}`;

  try {
    config.db.insert(tickets).values({
      repoId: config.repoId,
      ticketId,
      title: descriptor.title,
      description: descriptor.description,
      status: "backlog",
      severity: descriptor.severity,
      priority: descriptor.priority,
      tagsJson: JSON.stringify([...descriptor.tags, "autoresearch"]),
      affectedPathsJson: JSON.stringify(descriptor.affectedPaths),
      acceptanceCriteria: descriptor.acceptanceCriteria,
      creatorAgentId: "simulation-runner",
      creatorSessionId: `sim-${Date.now()}`,
      commitSha: "simulation",
      requiredRolesJson: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    return ticketId;
  } catch {
    return null;
  }
}

function extractSearchTerm(title: string): string | null {
  // Extract a meaningful search term from ticket title
  const words = title
    .replace(/`/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .filter((w) => !["reduce", "flatten", "split", "into", "focused", "modules", "logic", "tests", "complexity"].includes(w.toLowerCase()));

  return words.length > 0 ? words.slice(0, 2).join(" ") : null;
}

function buildSummary(
  runId: string,
  phasesRun: SimulationPhase[],
  corpus: SimulationCorpus | null,
  result: SimulationResult | null,
): string {
  const lines: string[] = [];
  lines.push(`Simulation run: ${runId}`);
  lines.push(`Phases: ${phasesRun.join(", ") || "none"}`);

  if (corpus) {
    lines.push(`Corpus: ${corpus.descriptors.length} tickets, ${corpus.rejections.length} rejected`);
  }

  if (result) {
    lines.push(`Composite score: ${result.compositeScore.toFixed(3)}`);
    if (result.deltas) {
      const d = result.deltas;
      lines.push(`Deltas: velocity=${d.velocity >= 0 ? "+" : ""}${d.velocity.toFixed(3)}, autonomy=${d.autonomy >= 0 ? "+" : ""}${d.autonomy.toFixed(3)}, quality=${d.quality >= 0 ? "+" : ""}${d.quality.toFixed(3)}, cost=${d.cost >= 0 ? "+" : ""}${d.cost.toFixed(3)}`);
    }
    lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  }

  return lines.join("\n");
}
