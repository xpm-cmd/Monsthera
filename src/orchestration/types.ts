import type { Timestamp, WorkPhase } from "../core/types.js";
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
 */
export type AgentNeededReason = "policy" | "template_enrichment" | "reviewer_missing";

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
 * Structured payload for `agent_needed` events. Stored as the `details`
 * blob on `OrchestrationEvent` so existing repos do not need new columns;
 * the typed shape is enforced at the dispatcher and at the CLI/MCP
 * validation layer.
 */
export interface AgentNeededDetails {
  readonly role: string;
  readonly transition: { readonly from: WorkPhase; readonly to: WorkPhase };
  readonly reason: AgentNeededReason;
  readonly triggeredBy: { readonly policySlug?: string; readonly guardName?: string };
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
  readonly triggeredBy: { readonly policySlug?: string; readonly guardName?: string };
  /** True when an open `agent_needed` already covered this slot — no new event was emitted. */
  readonly deduped: boolean;
}
