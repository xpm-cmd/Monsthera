/**
 * Core types for the Monsthera continuous improvement loop (autoresearch).
 *
 * TicketDescriptor is the generation-time representation of a ticket —
 * it lives in the corpus JSON and is converted to a real DB ticket
 * only after passing anti-basura validation.
 */

import type { ComplexityMetrics } from "../analysis/complexity.js";

// ---------------------------------------------------------------------------
// Ticket descriptor (pre-DB, lives in corpus JSON)
// ---------------------------------------------------------------------------

export type TicketSource = "backlog_atomized" | "auto_detected" | "manual";
export type TicketAtomicityLevel = "micro" | "small";
export type SuggestedModel = "haiku" | "sonnet";

export interface TicketDescriptor {
  /** Stable id within a corpus run (not the DB ticketId). */
  corpusId: string;
  title: string;
  description: string;
  affectedPaths: string[];
  tags: string[];
  severity: "low" | "medium" | "high" | "critical";
  priority: number;
  acceptanceCriteria: string;

  source: TicketSource;
  atomicityLevel: TicketAtomicityLevel;
  suggestedModel: SuggestedModel;
  estimatedLines: number;

  /** If atomized from an existing ticket, the parent ticketId (TKT-...). */
  parentTicketId?: string;
  /** corpusIds this ticket depends on (maps to `blocks` links at creation). */
  dependsOn?: string[];

  /** Planning evidence comments to satisfy governance transitions. */
  planningEvidence: PlanningEvidence;
}

export interface PlanningEvidence {
  summary: string;
  approach: string;
  affectedAreas: string[];
  riskAssessment: string;
  testPlan: string;
}

// ---------------------------------------------------------------------------
// Anti-basura validation
// ---------------------------------------------------------------------------

export type RejectionReason =
  | "file_not_found"
  | "duplicate"
  | "not_actionable"
  | "too_large"
  | "missing_test_plan"
  | "missing_planning_evidence";

export interface ValidationResult {
  valid: boolean;
  rejections: Array<{
    reason: RejectionReason;
    message: string;
  }>;
}

// ---------------------------------------------------------------------------
// Atomizer
// ---------------------------------------------------------------------------

export type AtomizationScope = "single_file" | "small_scope" | "multi_scope";

export interface AtomizationInput {
  title: string;
  description: string;
  affectedPaths: string[];
  parentTicketId?: string;
  /** File-level complexity metrics, keyed by relative path. */
  complexityByFile: Map<string, ComplexityMetrics>;
}

export interface AtomizationResult {
  descriptors: TicketDescriptor[];
  scope: AtomizationScope;
  /** Paths that were rejected (not found, unsupported language, etc.). */
  skippedPaths: string[];
}

// ---------------------------------------------------------------------------
// KPI Scorecard
// ---------------------------------------------------------------------------

export interface VelocityKPIs {
  avgTimeToResolveMs: number;
  avgTimeInReviewMs: number;
  workflowOverheadPct: number;
}

export interface AutonomyKPIs {
  firstPassSuccessRate: number;
  councilApprovalRate: number;
  mergeSuccessRate: number;
}

export interface QualityKPIs {
  testPassRate: number;
  regressionRate: number;
  ticketRetrievalPrecision5: number;
  codeRetrievalPrecision5: number;
  /** Ratio of src/ files that have a corresponding test file (0-1). */
  testCoverageRatio: number;
  /** Auto-detected issues per source file (lower = healthier). */
  issueDensity: number;
}

export interface CostKPIs {
  avgPayloadCharsPerTicket: number;
  haikuSuccessRate: number;
  sonnetSuccessRate: number;
  escalationCount: number;
  modelDistribution: { haiku: number; sonnet: number };
  note: string;
}

export interface KPIScorecard {
  velocity: VelocityKPIs;
  autonomy: AutonomyKPIs;
  quality: QualityKPIs;
  cost: CostKPIs;
  compositeScore: number;
}

export interface KPIDeltas {
  velocity: number;
  autonomy: number;
  quality: number;
  cost: number;
  composite: number;
}

// ---------------------------------------------------------------------------
// Simulation run result (one line in JSONL)
// ---------------------------------------------------------------------------

export type SimulationPhase = "A" | "B" | "C" | "D" | "E";

export interface CorpusSources {
  backlog: number;
  autoDetected: number;
  manual: number;
}

export interface SimulationResult {
  runId: string;
  timestamp: string;
  gitCommit: string;
  corpusSize: number;
  durationMs: number;
  sources: CorpusSources;
  phasesRun: SimulationPhase[];

  velocity: VelocityKPIs;
  autonomy: AutonomyKPIs;
  quality: QualityKPIs;
  cost: CostKPIs;
  compositeScore: number;
  deltas: KPIDeltas | null;
  orchestrator?: OrchestratorKPIs;
}

export interface OrchestratorKPIs {
  spawnSuccessRate: number;       // spawned / attempted
  waveCompletionRate: number;     // waves completed / total waves
  conflictRecoveryRate: number;   // conflicts retried+merged / total conflicts
  durationMs: number;
  eventsCollected: number;
}

// ---------------------------------------------------------------------------
// Corpus file (.monsthera/simulation-corpus.json)
// ---------------------------------------------------------------------------

export interface SimulationCorpus {
  generatedAt: string;
  gitCommit: string;
  descriptors: TicketDescriptor[];
  rejections: Array<{
    title: string;
    reason: RejectionReason;
    message: string;
  }>;
}

// ---------------------------------------------------------------------------
// Per-ticket telemetry (Decision 1 Option B — independent of eventLogs)
// ---------------------------------------------------------------------------

export interface TicketTelemetry {
  corpusId: string;
  ticketId: string | null;
  model: SuggestedModel;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  outcome: "resolved" | "failed" | "timeout" | "escalated";
  escalatedTo?: SuggestedModel;
  payloadCharsIn: number;
  payloadCharsOut: number;
}

// ---------------------------------------------------------------------------
// Auto-detection signals (Source 3)
// ---------------------------------------------------------------------------

export type AutoDetectionSignal =
  | "high_complexity"
  | "deep_nesting"
  | "large_file"
  | "missing_tests"
  | "high_coupling";

export interface AutoDetectedIssue {
  signal: AutoDetectionSignal;
  filePath: string;
  value: number;
  threshold: number;
  ticketType: string;
  atomicityLevel: TicketAtomicityLevel;
}
