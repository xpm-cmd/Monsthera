/**
 * KPI computation + JSONL persistence for simulation runs.
 *
 * Computes the 4-dimension scorecard (velocity, autonomy, quality, cost)
 * from ticket history, review verdicts, and telemetry data.
 *
 * Segment-aware: tickets can re-enter `in_review` or `blocked`,
 * so time calculations handle multiple rounds.
 */

import { appendFile, readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { tickets, ticketHistory, reviewVerdicts } from "../db/schema.js";
import type { TelemetryTracker } from "./telemetry.js";
import type {
  AutonomyKPIs,
  CostKPIs,
  KPIDeltas,
  KPIScorecard,
  QualityKPIs,
  SimulationResult,
  VelocityKPIs,
} from "./types.js";

// ---------------------------------------------------------------------------
// Composite score weights
// ---------------------------------------------------------------------------

const WEIGHTS = {
  velocity: 0.30,
  autonomy: 0.30,
  quality: 0.25,
  cost: 0.15,
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MetricsInput {
  db: BetterSQLite3Database<typeof schema>;
  repoId: number;
  telemetry: TelemetryTracker;

  /** Ticket retrieval precision@5 from Phase B measurement. */
  ticketRetrievalPrecision5: number;
  /** Code retrieval precision@5 from Phase B measurement. */
  codeRetrievalPrecision5: number;

  /** Test pass rate from Phase C (0-1). */
  testPassRate: number;
  /** Regression rate from Phase C (0-1). */
  regressionRate: number;

  /** Merge success rate from Phase C (0-1). */
  mergeSuccessRate: number;

  /** Workflow overhead percentage (0-1). */
  workflowOverheadPct: number;
}

/**
 * Compute the full KPI scorecard from DB + telemetry data.
 */
export function computeScorecard(input: MetricsInput): KPIScorecard {
  const velocity = computeVelocity(input);
  const autonomy = computeAutonomy(input);
  const quality: QualityKPIs = {
    testPassRate: input.testPassRate,
    regressionRate: input.regressionRate,
    ticketRetrievalPrecision5: input.ticketRetrievalPrecision5,
    codeRetrievalPrecision5: input.codeRetrievalPrecision5,
  };
  const cost = computeCost(input);
  const compositeScore = computeComposite(velocity, autonomy, quality, cost);

  return { velocity, autonomy, quality, cost, compositeScore };
}

/**
 * Append a simulation result to the JSONL file.
 */
export async function appendResult(
  outputPath: string,
  result: SimulationResult,
): Promise<void> {
  const line = JSON.stringify(result) + "\n";
  await appendFile(outputPath, line, "utf8");
}

/**
 * Read all previous results from the JSONL file.
 */
export async function readResults(outputPath: string): Promise<SimulationResult[]> {
  let content: string;
  try {
    content = await readFile(outputPath, "utf8");
  } catch {
    return [];
  }

  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SimulationResult);
}

/**
 * Compute deltas between current and previous run.
 */
export function computeDeltas(
  current: KPIScorecard,
  previous: KPIScorecard | null,
): KPIDeltas | null {
  if (!previous) return null;

  return {
    velocity: normalizeDimension(current.velocity) - normalizeDimension(previous.velocity),
    autonomy: normalizeDimension(current.autonomy) - normalizeDimension(previous.autonomy),
    quality: normalizeDimension(current.quality) - normalizeDimension(previous.quality),
    cost: normalizeDimension(current.cost) - normalizeDimension(previous.cost),
    composite: current.compositeScore - previous.compositeScore,
  };
}

// ---------------------------------------------------------------------------
// Velocity KPIs
// ---------------------------------------------------------------------------

function computeVelocity(input: MetricsInput): VelocityKPIs {
  const { db, repoId } = input;

  // Average time-to-resolve: from ticket creation to resolved status
  const resolvedTickets = db
    .select({
      ticketInternalId: tickets.id,
      createdAt: tickets.createdAt,
    })
    .from(tickets)
    .where(sql`${tickets.repoId} = ${repoId} AND ${tickets.status} = 'resolved'`)
    .all();

  let totalResolveTime = 0;
  let resolveCount = 0;

  for (const t of resolvedTickets) {
    // Find the first transition to 'resolved'
    const resolvedEntry = db
      .select({ timestamp: ticketHistory.timestamp })
      .from(ticketHistory)
      .where(
        sql`${ticketHistory.ticketId} = ${t.ticketInternalId} AND ${ticketHistory.toStatus} = 'resolved'`,
      )
      .limit(1)
      .all();

    if (resolvedEntry[0]) {
      const created = new Date(t.createdAt).getTime();
      const resolved = new Date(resolvedEntry[0].timestamp).getTime();
      totalResolveTime += resolved - created;
      resolveCount += 1;
    }
  }

  // Segment-aware time-in-review: sum all in_review → next-status segments
  const avgTimeInReviewMs = computeAvgTimeInReview(db, resolvedTickets.map((t) => t.ticketInternalId));

  return {
    avgTimeToResolveMs: resolveCount > 0 ? Math.round(totalResolveTime / resolveCount) : 0,
    avgTimeInReviewMs,
    workflowOverheadPct: input.workflowOverheadPct,
  };
}

/**
 * Segment-aware: for each ticket, find all consecutive in_review segments
 * (enter in_review → leave in_review), sum them, then average across tickets.
 */
function computeAvgTimeInReview(
  db: BetterSQLite3Database<typeof schema>,
  ticketInternalIds: number[],
): number {
  if (ticketInternalIds.length === 0) return 0;

  let totalReviewTime = 0;
  let ticketsWithReview = 0;

  for (const ticketInternalId of ticketInternalIds) {
    const history = db
      .select({
        toStatus: ticketHistory.toStatus,
        timestamp: ticketHistory.timestamp,
      })
      .from(ticketHistory)
      .where(sql`${ticketHistory.ticketId} = ${ticketInternalId}`)
      .orderBy(ticketHistory.id)
      .all();

    let reviewStartTime: number | null = null;
    let ticketReviewTime = 0;

    for (const entry of history) {
      if (entry.toStatus === "in_review") {
        reviewStartTime = new Date(entry.timestamp).getTime();
      } else if (reviewStartTime !== null) {
        // Left in_review
        ticketReviewTime += new Date(entry.timestamp).getTime() - reviewStartTime;
        reviewStartTime = null;
      }
    }

    if (ticketReviewTime > 0) {
      totalReviewTime += ticketReviewTime;
      ticketsWithReview += 1;
    }
  }

  return ticketsWithReview > 0 ? Math.round(totalReviewTime / ticketsWithReview) : 0;
}

// ---------------------------------------------------------------------------
// Autonomy KPIs
// ---------------------------------------------------------------------------

function computeAutonomy(input: MetricsInput): AutonomyKPIs {
  const { db, repoId } = input;

  // Resolved tickets in this repo
  const resolvedTicketIds = db
    .select({ id: tickets.id })
    .from(tickets)
    .where(sql`${tickets.repoId} = ${repoId} AND ${tickets.status} = 'resolved'`)
    .all()
    .map((t) => t.id);

  if (resolvedTicketIds.length === 0) {
    return {
      firstPassSuccessRate: 0,
      councilApprovalRate: 0,
      mergeSuccessRate: input.mergeSuccessRate,
    };
  }

  // First-pass success: resolved without re-entering in_review or blocked
  let firstPassCount = 0;
  for (const ticketInternalId of resolvedTicketIds) {
    const history = db
      .select({ toStatus: ticketHistory.toStatus })
      .from(ticketHistory)
      .where(sql`${ticketHistory.ticketId} = ${ticketInternalId}`)
      .all();

    const inReviewCount = history.filter((h) => h.toStatus === "in_review").length;
    const blockedCount = history.filter((h) => h.toStatus === "blocked").length;

    if (inReviewCount <= 1 && blockedCount === 0) {
      firstPassCount += 1;
    }
  }

  // Council approval rate: tickets where first round of verdicts had no 'fail'
  let approvedFirstRound = 0;
  let ticketsWithVerdicts = 0;
  for (const ticketInternalId of resolvedTicketIds) {
    const verdicts = db
      .select({
        verdict: reviewVerdicts.verdict,
        supersededBy: reviewVerdicts.supersededBy,
      })
      .from(reviewVerdicts)
      .where(sql`${reviewVerdicts.ticketId} = ${ticketInternalId}`)
      .all();

    // First round = verdicts not superseded
    const firstRound = verdicts.filter((v) => v.supersededBy === null);
    if (firstRound.length > 0) {
      ticketsWithVerdicts += 1;
      const hasFail = firstRound.some((v) => v.verdict === "fail");
      if (!hasFail) approvedFirstRound += 1;
    }
  }

  return {
    firstPassSuccessRate: firstPassCount / resolvedTicketIds.length,
    councilApprovalRate: ticketsWithVerdicts > 0 ? approvedFirstRound / ticketsWithVerdicts : 1,
    mergeSuccessRate: input.mergeSuccessRate,
  };
}

// ---------------------------------------------------------------------------
// Cost KPIs
// ---------------------------------------------------------------------------

function computeCost(input: MetricsInput): CostKPIs {
  const summary = input.telemetry.summarize();
  const totalPayload = summary.avgPayloadCharsIn + summary.avgPayloadCharsOut;

  return {
    avgPayloadCharsPerTicket: totalPayload,
    haikuSuccessRate: summary.haikuSuccessRate,
    sonnetSuccessRate: summary.sonnetSuccessRate,
    escalationCount: summary.escalated,
    modelDistribution: {
      haiku: summary.haikuCount,
      sonnet: summary.sonnetCount,
    },
    note: "operational estimate, not accounting-grade",
  };
}

// ---------------------------------------------------------------------------
// Composite score
// ---------------------------------------------------------------------------

function computeComposite(
  velocity: VelocityKPIs,
  autonomy: AutonomyKPIs,
  quality: QualityKPIs,
  cost: CostKPIs,
): number {
  const v = normalizeDimension(velocity);
  const a = normalizeDimension(autonomy);
  const q = normalizeDimension(quality);
  const c = normalizeDimension(cost);

  return WEIGHTS.velocity * v + WEIGHTS.autonomy * a + WEIGHTS.quality * q + WEIGHTS.cost * c;
}

/**
 * Normalize a KPI dimension to 0-1 range.
 * Each dimension uses different normalization strategies.
 */
function normalizeDimension(kpis: VelocityKPIs | AutonomyKPIs | QualityKPIs | CostKPIs): number {
  if ("avgTimeToResolveMs" in kpis) {
    // Velocity: faster is better. Normalize against 5-minute target.
    const timeScore = Math.max(0, 1 - kpis.avgTimeToResolveMs / 300_000);
    const overheadScore = Math.max(0, 1 - kpis.workflowOverheadPct);
    return (timeScore + overheadScore) / 2;
  }

  if ("firstPassSuccessRate" in kpis) {
    // Autonomy: higher rates are better (already 0-1)
    return (kpis.firstPassSuccessRate + kpis.councilApprovalRate + kpis.mergeSuccessRate) / 3;
  }

  if ("testPassRate" in kpis) {
    // Quality: higher is better (already 0-1), except regressionRate (lower is better)
    return (
      kpis.testPassRate * 0.3 +
      (1 - kpis.regressionRate) * 0.3 +
      kpis.ticketRetrievalPrecision5 * 0.2 +
      kpis.codeRetrievalPrecision5 * 0.2
    );
  }

  if ("avgPayloadCharsPerTicket" in kpis) {
    // Cost: lower payload is better. Normalize against 50k target.
    const payloadScore = Math.max(0, 1 - kpis.avgPayloadCharsPerTicket / 50_000);
    const successScore = (kpis.haikuSuccessRate + kpis.sonnetSuccessRate) / 2;
    return (payloadScore + successScore) / 2;
  }

  return 0;
}
