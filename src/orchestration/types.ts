import type { ConvoyId, Timestamp, WorkId, WorkPhase } from "../core/types.js";
import type { WorkArticle } from "../work/repository.js";

export interface GuardResult {
  readonly name: string;
  readonly passed: boolean;
}

export interface ReadinessReport {
  readonly workId: string;
  readonly currentPhase: WorkPhase;
  readonly nextPhase: WorkPhase | null;
  readonly ready: boolean;
  readonly guardResults: readonly GuardResult[];
}

export interface AdvanceResult {
  readonly workId: string;
  readonly from: WorkPhase;
  readonly to: WorkPhase;
  readonly article: WorkArticle;
}

/**
 * Per-article record of a guard failure surfaced by `planWave`. The
 * dispatcher consumes this to decide which `agent_needed` events to emit.
 * Kept slim — the article itself is re-fetched (or re-used) by the caller
 * if more context is required.
 */
export interface GuardFailure {
  readonly workId: string;
  readonly transition: { readonly from: WorkPhase; readonly to: WorkPhase };
  readonly failed: readonly GuardResult[];
}

export interface WavePlan {
  readonly items: ReadonlyArray<{
    readonly workId: string;
    readonly from: WorkPhase;
    readonly to: WorkPhase;
  }>;
  readonly blockedItems: ReadonlyArray<{
    readonly workId: string;
    readonly reason: string;
  }>;
  /**
   * Articles whose `getNextPhase` is non-null but whose guards did not all
   * pass. Empty when every active article is either ready (in `items`),
   * blocked by an unresolved dependency (in `blockedItems`), or terminal.
   * Surfaced so the agent dispatcher can request the missing roles without
   * re-evaluating guards downstream.
   */
  readonly guardFailures: readonly GuardFailure[];
}

export interface WaveResult {
  readonly advanced: readonly AdvanceResult[];
  readonly failed: ReadonlyArray<{ readonly workId: string; readonly error: string }>;
  /**
   * `agent_needed` events emitted by the dispatcher during wave execution.
   * Empty when no dispatcher is wired or no roles were missing. Useful for
   * tests and for a CLI/dashboard caller that wants to surface what just
   * got requested without re-querying the event repo.
   */
  readonly dispatched: readonly DispatchedAgentRequest[];
}

// ─── Agent dispatch contract ───────────────────────────────────────────────

/**
 * Reason a dispatcher emits `agent_needed`. Tracks the *category* of trigger
 * so a harness can prioritise its queue: a policy-driven request is more
 * urgent than a freeform enrichment top-up.
 *
 * `requires_chain` is emitted when policy A has `policy_requires_articles: [B]`
 * and B is not in `phase: done`. The slot targets B (not A) so the harness can
 * advance B and unblock A on the next wave. Carries `triggeredBy.blockingArticle`
 * pointing back at A.
 */
export type AgentNeededReason =
  | "policy"
  | "template_enrichment"
  | "reviewer_missing"
  | "requires_chain";

/**
 * Slim pointer to a context pack — the dispatcher does NOT serialise the
 * pack itself into the event. Storing 100+ KB of pack content per event
 * would balloon the events table; the harness re-builds the pack via
 * `build_context_pack` using the slugs/refs provided here.
 */
export interface AgentContextPackSummary {
  readonly workArticleSlug: string;
  readonly relatedKnowledgeSlugs: readonly string[];
  readonly codeRefs: readonly string[];
  /**
   * Free-form lines an agent should read before contributing. The
   * dispatcher always includes (in order): a context-pack pointer,
   * a worktree-assertion reminder (per ADR-012 safe parallel dispatch),
   * and a phrasing of the role the agent must take. See
   * `agent-dispatch-design-decisions.md` for the rationale.
   */
  readonly guidance: readonly string[];
}

/**
 * Provenance for an `agent_needed` event. Shared between the public
 * event detail payload and the dispatcher's internal slot type so a
 * future field addition stays in one place. `policySlug` is set for
 * policy-driven slots; `guardName` for template/reviewer guards;
 * `blockingArticle` for `requires_chain` slots (ADR-009) — the article
 * whose policy is waiting on the referenced article to be `done`.
 */
export interface AgentTriggeredBy {
  readonly policySlug?: string;
  readonly guardName?: string;
  readonly blockingArticle?: WorkId;
}

/**
 * Structured payload for `agent_needed` events. Stored as the `details`
 * blob on `OrchestrationEvent` so existing repos do not need new columns;
 * the typed shape is enforced at the dispatcher and at the CLI/MCP
 * validation layer.
 */
export interface AgentNeededDetails {
  readonly role: string;
  readonly transition: { readonly from: WorkPhase; readonly to: WorkPhase };
  readonly reason: AgentNeededReason;
  readonly triggeredBy: AgentTriggeredBy;
  readonly contextPackSummary: AgentContextPackSummary;
  readonly requestedAt: Timestamp;
}

/**
 * Structured payload for `agent_started` / `agent_completed` / `agent_failed`
 * events. The `role` and `transition` fields are required so the dispatcher
 * can deduplicate against the originating `agent_needed` event.
 *
 * `error` is present only on `agent_failed`. The repository carries `agentId`
 * on the envelope, so it is not duplicated here.
 */
export interface AgentLifecycleDetails {
  readonly role: string;
  readonly transition: { readonly from: WorkPhase; readonly to: WorkPhase };
  readonly error?: string;
}

/**
 * Outcome of one dispatcher invocation. Mirrors the `agent_needed` event
 * envelope so a caller (CLI, dashboard, test) can render or assert without
 * re-reading the event store.
 */
export interface DispatchedAgentRequest {
  readonly workId: string;
  readonly role: string;
  readonly transition: { readonly from: WorkPhase; readonly to: WorkPhase };
  readonly reason: AgentNeededReason;
  readonly triggeredBy: AgentTriggeredBy;
  /** True when an open `agent_needed` already covered this slot — no new event was emitted. */
  readonly deduped: boolean;
}

// ─── Convoys (ADR-009) ─────────────────────────────────────────────────────

/** Lifecycle states for a convoy. */
export type ConvoyStatus = "active" | "completed" | "cancelled";

/**
 * A named group of work articles that share a goal and follow a lead. The
 * lead's progress past `targetPhase` is what unblocks members for wave
 * planning. Convoys are orchestration state (no markdown source-of-truth);
 * see ADR-009 for the carve-out from AGENTS.md §4.
 */
export interface Convoy {
  readonly id: ConvoyId;
  readonly leadWorkId: WorkId;
  readonly memberWorkIds: readonly WorkId[];
  readonly goal: string;
  readonly status: ConvoyStatus;
  /** Phase the lead must reach (or pass) before members are eligible. Defaults to `implementation`. */
  readonly targetPhase: WorkPhase;
  readonly createdAt: Timestamp;
  readonly completedAt?: Timestamp;
}

// ─── Resync events (ADR-009) ───────────────────────────────────────────────

/**
 * Observational event: an active agent's snapshot has diverged from the
 * latest captured snapshot. Emitted by the resync monitor on every drift
 * tick. No `guidance[]` — the harness may correlate but is not required to
 * act. The first drift past 2× resync interval escalates to an
 * `agent_needs_resync` event, which IS dispatch-like.
 */
export interface ContextDriftEventDetails {
  readonly role: string;
  readonly originalSnapshotId: string;
  readonly currentSnapshotId: string;
  readonly ageMinutes: number;
  readonly checkedAt: Timestamp;
}

/**
 * Dispatch-like event: an active agent has been running long enough that the
 * snapshot it started from is meaningfully stale, and the harness should
 * either re-spawn with a fresh context pack or cancel the work. Carries
 * `contextPackSummary` + `guidance[]` per ADR-008's contract for events the
 * harness is expected to act on.
 */
export interface AgentNeedsResyncEventDetails {
  readonly role: string;
  readonly originalSnapshotId: string;
  readonly currentSnapshotId: string;
  readonly ageMinutes: number;
  readonly contextPackSummary: AgentContextPackSummary;
  readonly requestedAt: Timestamp;
}
