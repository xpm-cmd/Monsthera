import type { Logger } from "../core/logger.js";
import { workId, timestamp } from "../core/types.js";
import type { WorkPhase } from "../core/types.js";
import type { WorkArticle, WorkArticleRepository } from "../work/repository.js";
import type { PolicyLoader } from "../work/policy-loader.js";
import { getPolicyViolations } from "../work/guards.js";
import type {
  OrchestrationEvent,
  OrchestrationEventRepository,
} from "./repository.js";
import type {
  AgentContextPackSummary,
  AgentNeededDetails,
  AgentNeededReason,
  DispatchedAgentRequest,
  GuardFailure,
} from "./types.js";

/**
 * Default lookback window for deduplicating `agent_needed` events. One
 * hour is short enough to renew forgotten requests as signal, long enough
 * that a 30-second wave loop does not flood the event repo.
 */
const DEFAULT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Cap on event scan per `findByWorkId` lookup. Articles trapped in tight
 * policy loops accumulate hundreds of events; slicing keeps dedup O(window).
 */
const DEDUP_LOOKBACK_LIMIT = 200;

export interface AgentDispatcherDeps {
  readonly workRepo: WorkArticleRepository;
  readonly eventRepo: OrchestrationEventRepository;
  readonly logger: Logger;
  readonly policyLoader?: PolicyLoader;
  /**
   * Window after an `agent_needed` event during which the dispatcher will
   * not re-emit for the same `(workId, role, transition)`. An intermediate
   * `agent_started`/`agent_completed`/`agent_failed` resets the window.
   */
  readonly dedupWindowMs?: number;
  /**
   * Hint baked into the safe-parallel-dispatch line of `guidance[]`. When
   * set, the dispatcher prints the literal `cd <path>` form; absent, the
   * line uses a placeholder for the agent to substitute.
   */
  readonly worktreePath?: string;
}

interface DispatcherSlot {
  readonly workId: string;
  readonly role: string;
  readonly transition: { readonly from: WorkPhase; readonly to: WorkPhase };
  readonly reason: AgentNeededReason;
  readonly triggeredBy: { readonly policySlug?: string; readonly guardName?: string };
}

/**
 * Translate guard failures into `agent_needed` events. Three sources of
 * failure are recognised:
 *
 *  - `policy_requirements_met` — a knowledge-authored policy (ADR-007) is
 *    blocking advance because a role hasn't contributed or a referenced
 *    article hasn't been added. The dispatcher walks `getPolicyViolations`
 *    so the emitted event carries the policy's slug.
 *  - `min_enrichment_met` — the template's hard-coded floor is unmet. Each
 *    `enrichmentRoles[]` entry still in `pending` becomes one request.
 *  - `all_reviewers_approved` — review phase is stuck. Each non-approved
 *    reviewer becomes a request with `role="reviewer"`.
 *
 * Content-shape guards (`has_objective`, `has_acceptance_criteria`,
 * `implementation_linked`, `snapshot_ready`) are intentionally NOT
 * dispatched — there is no role to request; the work article author must
 * fill in the missing piece. Surfacing those would noisify the events
 * stream without giving the harness anything to act on.
 *
 * Monsthera does not spawn agents. This class only emits events; an
 * external harness consumes them and decides how (or whether) to spawn.
 * See ADR-008 for the contract rationale and
 * `agent-dispatch-design-decisions.md` for the trade-offs against an
 * alternative webhook-style design.
 */
export class AgentDispatcher {
  private readonly workRepo: WorkArticleRepository;
  private readonly eventRepo: OrchestrationEventRepository;
  private readonly logger: Logger;
  private readonly policyLoader?: PolicyLoader;
  private readonly dedupWindowMs: number;
  private readonly worktreePath?: string;

  constructor(deps: AgentDispatcherDeps) {
    this.workRepo = deps.workRepo;
    this.eventRepo = deps.eventRepo;
    this.logger = deps.logger.child({ domain: "dispatcher" });
    this.policyLoader = deps.policyLoader;
    this.dedupWindowMs = Math.max(0, deps.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS);
    this.worktreePath = deps.worktreePath?.trim() ? deps.worktreePath : undefined;
  }

  /**
   * Walk every guard failure and emit one `agent_needed` event per missing
   * role, deduping against the current event log. Returns one
   * `DispatchedAgentRequest` per *requested* slot — including dedup hits,
   * so a caller can show "this is what would have been requested" without
   * cross-referencing the event repo.
   */
  async dispatchFor(failures: readonly GuardFailure[]): Promise<DispatchedAgentRequest[]> {
    const requests: DispatchedAgentRequest[] = [];

    for (const failure of failures) {
      const articleResult = await this.workRepo.findById(failure.workId);
      if (!articleResult.ok) {
        this.logger.warn("Skipping dispatch for unknown work article", {
          workId: failure.workId,
          error: articleResult.error.message,
        });
        continue;
      }
      const article = articleResult.value;
      const slots = await this.collectSlots(article, failure);
      if (slots.length === 0) continue;

      const events = await this.eventRepo.findByWorkId(workId(article.id));
      if (!events.ok) {
        this.logger.warn("Failed to load events for dedup; emitting without dedup", {
          workId: article.id,
          error: events.error.message,
        });
      }
      const recentEvents = events.ok ? events.value : [];

      for (const slot of slots) {
        const dedupHit = this.findOpenAgentNeeded(recentEvents, slot.role, slot.transition);
        if (dedupHit) {
          requests.push({ ...slot, deduped: true });
          continue;
        }

        const details: AgentNeededDetails = {
          role: slot.role,
          transition: slot.transition,
          reason: slot.reason,
          triggeredBy: slot.triggeredBy,
          contextPackSummary: this.buildContextPackSummary(article, slot.role),
          requestedAt: timestamp(),
        };

        const logged = await this.eventRepo.logEvent({
          workId: workId(article.id),
          eventType: "agent_needed",
          details: details as unknown as Record<string, unknown>,
        });
        if (!logged.ok) {
          this.logger.error("Failed to persist agent_needed event", {
            workId: article.id,
            role: slot.role,
            error: logged.error.message,
          });
          continue;
        }
        requests.push({ ...slot, deduped: false });
      }
    }

    if (requests.length > 0) {
      this.logger.info("Dispatch pass complete", {
        operation: "dispatchFor",
        emitted: requests.filter((r) => !r.deduped).length,
        deduped: requests.filter((r) => r.deduped).length,
      });
    }

    return requests;
  }

  /**
   * Build the per-failure list of `(role, reason, triggeredBy)` slots.
   * Pure w.r.t. the event repo — dedup happens in `dispatchFor` so this
   * helper stays testable on its own.
   */
  private async collectSlots(
    article: WorkArticle,
    failure: GuardFailure,
  ): Promise<DispatcherSlot[]> {
    const slots: DispatcherSlot[] = [];
    for (const guard of failure.failed) {
      switch (guard.name) {
        case "policy_requirements_met": {
          const policySlots = await this.collectPolicySlots(article, failure);
          slots.push(...policySlots);
          break;
        }
        case "min_enrichment_met": {
          for (const role of article.enrichmentRoles) {
            if (role.status === "pending") {
              slots.push({
                workId: article.id,
                role: role.role,
                transition: failure.transition,
                reason: "template_enrichment",
                triggeredBy: { guardName: "min_enrichment_met" },
              });
            }
          }
          break;
        }
        case "all_reviewers_approved": {
          for (const reviewer of article.reviewers) {
            if (reviewer.status !== "approved") {
              slots.push({
                workId: article.id,
                role: "reviewer",
                transition: failure.transition,
                reason: "reviewer_missing",
                triggeredBy: { guardName: "all_reviewers_approved" },
              });
            }
          }
          break;
        }
        // `convoy_lead_ready` (ADR-009) is a passive wait — no agent
        // dispatch on the member. The lead is independently scanned by
        // planWave and dispatched on its own merits when its guards fail.
        case "convoy_lead_ready":
          break;
        // Content-shape guards have no role to dispatch — author task.
        default:
          break;
      }
    }
    return slots;
  }

  /**
   * Compute one slot per missing role per applicable policy. Re-uses
   * `getPolicyViolations` so the dispatcher and the lint pipeline see
   * identical "what is missing" answers.
   */
  private async collectPolicySlots(
    article: WorkArticle,
    failure: GuardFailure,
  ): Promise<DispatcherSlot[]> {
    if (!this.policyLoader) return [];
    const all = await this.policyLoader.getAll();
    const applicable = this.policyLoader.getApplicablePolicies(all, article, failure.transition);
    if (applicable.length === 0) return [];

    const violations = getPolicyViolations(article, applicable);
    const slots: DispatcherSlot[] = [];
    for (const violation of violations) {
      const missingRoles = violation.missing.enrichmentRoles ?? [];
      for (const role of missingRoles) {
        slots.push({
          workId: article.id,
          role,
          transition: failure.transition,
          reason: "policy",
          triggeredBy: { policySlug: violation.policySlug },
        });
      }
      // Missing referenced articles do not map to a role — author task,
      // surfaced via lint, not via dispatch.
    }
    return slots;
  }

  /**
   * Look up the most recent agent-lifecycle event for `(role, transition)`.
   * The slot is "open" — and therefore eligible for dedup — when:
   *
   *   1. The most recent matching event is `agent_needed`, AND
   *   2. It was emitted within `dedupWindowMs`.
   *
   * Any later `agent_started` / `agent_completed` / `agent_failed` closes
   * the slot, so the next failure pass re-emits. Window-based dedup is
   * resilient to a harness that crashed before emitting `agent_failed`:
   * after the window, the dispatcher re-requests rather than waiting
   * forever for a closing event that never arrives.
   */
  private findOpenAgentNeeded(
    events: readonly OrchestrationEvent[],
    role: string,
    transition: { from: WorkPhase; to: WorkPhase },
  ): OrchestrationEvent | undefined {
    if (events.length === 0) return undefined;
    const sliced = events.slice(-DEDUP_LOOKBACK_LIMIT);
    let mostRecent: OrchestrationEvent | undefined;
    for (const event of sliced) {
      if (!matchesAgentSlot(event, role, transition)) continue;
      if (!mostRecent || event.createdAt > mostRecent.createdAt) {
        mostRecent = event;
      }
    }
    if (!mostRecent || mostRecent.eventType !== "agent_needed") return undefined;
    if (this.dedupWindowMs === 0) return undefined;
    const ageMs = Date.now() - new Date(mostRecent.createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > this.dedupWindowMs) return undefined;
    return mostRecent;
  }

  private buildContextPackSummary(article: WorkArticle, role: string): AgentContextPackSummary {
    const cdLine = this.worktreePath
      ? `cd ${this.worktreePath} && pwd # safe-parallel-dispatch invariant from ADR-012`
      : "cd <target-worktree> && pwd # safe-parallel-dispatch invariant from ADR-012; alt: monsthera ... --assert-worktree <path>";
    const guidance: string[] = [
      `Read context pack: build_context_pack({ work_id: "${article.id}", query: "${article.id}" })`,
      cdLine,
      `Acting as ${role}, contribute the ${role} Perspective section to ${article.id}.`,
    ];
    return {
      workArticleSlug: article.id,
      relatedKnowledgeSlugs: [...article.references],
      codeRefs: [...article.codeRefs],
      guidance,
    };
  }
}

function matchesAgentSlot(
  event: OrchestrationEvent,
  role: string,
  transition: { from: WorkPhase; to: WorkPhase },
): boolean {
  if (
    event.eventType !== "agent_needed" &&
    event.eventType !== "agent_started" &&
    event.eventType !== "agent_completed" &&
    event.eventType !== "agent_failed"
  ) {
    return false;
  }
  const details = event.details as Partial<AgentNeededDetails> | undefined;
  if (!details || details.role !== role) return false;
  if (
    !details.transition ||
    details.transition.from !== transition.from ||
    details.transition.to !== transition.to
  ) {
    return false;
  }
  return true;
}

/**
 * Read the `MONSTHERA_DISPATCH_DEDUP_MS` env var, falling back to the
 * default. Exported so tests can verify the env contract without a
 * container.
 */
export function readDedupWindowFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MONSTHERA_DISPATCH_DEDUP_MS;
  if (!raw) return DEFAULT_DEDUP_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DEDUP_WINDOW_MS;
  return parsed;
}

/**
 * Read the `MONSTHERA_DISPATCH_WORKTREE` env var. Empty/whitespace returns
 * `undefined` so the dispatcher prints the placeholder cd line.
 */
export function readWorktreePathFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.MONSTHERA_DISPATCH_WORKTREE;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
