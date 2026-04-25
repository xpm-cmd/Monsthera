import type { Logger } from "../core/logger.js";
import { workId, timestamp } from "../core/types.js";
import type { WorkPhase } from "../core/types.js";
import type { WorkArticle, WorkArticleRepository } from "../work/repository.js";
import type { PolicyLoader } from "../work/policy-loader.js";
import { getPolicyViolations } from "../work/guards.js";
import { getNextPhase } from "../work/lifecycle.js";
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
  readonly triggeredBy: AgentNeededDetails["triggeredBy"];
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

      for (const slot of slots) {
        // ADR-009: a requires_chain slot targets a DIFFERENT article (the
        // referenced one, not the one whose guard failed). Resolve the
        // target article so the context pack, the event's workId, and the
        // dedup lookup are all keyed on whoever actually needs the work.
        const targetIsSame = slot.workId === article.id;
        const targetArticle = targetIsSame
          ? article
          : await this.resolveSlotTarget(slot.workId);
        if (!targetArticle) continue;

        const dedupEvents = await this.eventRepo.findByWorkId(workId(targetArticle.id));
        if (!dedupEvents.ok) {
          this.logger.warn("Failed to load events for dedup; emitting without dedup", {
            workId: targetArticle.id,
            error: dedupEvents.error.message,
          });
        }
        const recentEvents = dedupEvents.ok ? dedupEvents.value : [];

        const dedupHit = this.findOpenAgentNeeded(recentEvents, slot.role, slot.transition);
        if (dedupHit) {
          requests.push({ ...slot, deduped: true });
          continue;
        }

        const extraGuidance = slot.reason === "requires_chain" && slot.triggeredBy.blockingArticle
          ? [
              `Advance ${targetArticle.id} so ${slot.triggeredBy.blockingArticle} can pass policy "${slot.triggeredBy.policySlug ?? "(unknown)"}".`,
            ]
          : undefined;

        const details: AgentNeededDetails = {
          role: slot.role,
          transition: slot.transition,
          reason: slot.reason,
          triggeredBy: slot.triggeredBy,
          contextPackSummary: this.buildContextPackSummary(targetArticle, slot.role, extraGuidance),
          requestedAt: timestamp(),
        };

        const logged = await this.eventRepo.logEvent({
          workId: workId(targetArticle.id),
          eventType: "agent_needed",
          details: details as unknown as Record<string, unknown>,
        });
        if (!logged.ok) {
          this.logger.error("Failed to persist agent_needed event", {
            workId: targetArticle.id,
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
   * Look up the work article a slot is targeted at. Used by `dispatchFor`
   * to handle `requires_chain` slots whose `workId` is the referenced
   * article, not the one whose guard failed.
   */
  private async resolveSlotTarget(targetId: string): Promise<WorkArticle | null> {
    const result = await this.workRepo.findById(targetId);
    if (!result.ok) {
      this.logger.warn("Slot target work article not found; dropping slot", {
        targetId,
        error: result.error.message,
      });
      return null;
    }
    return result.value;
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
   * Compute one slot per missing role per applicable policy, plus one
   * `requires_chain` slot per referenced work article that exists but is
   * not yet `done` (ADR-009). Re-uses `getPolicyViolations` so the
   * dispatcher and the lint pipeline see identical "what is missing"
   * answers.
   *
   * The `requires_chain` slot targets the referenced article (NOT the
   * article that triggered the guard) with `role: "author"` and
   * `triggeredBy.blockingArticle = article.id`. The harness reads this
   * as "advance B so A can proceed" — the assignment is to whoever owns
   * B, not to a fresh enrichment slot on A.
   */
  private async collectPolicySlots(
    article: WorkArticle,
    failure: GuardFailure,
  ): Promise<DispatcherSlot[]> {
    if (!this.policyLoader) return [];
    const all = await this.policyLoader.getAll();
    const applicable = this.policyLoader.getApplicablePolicies(all, article, failure.transition);
    if (applicable.length === 0) return [];

    // Re-resolve referenced phases here so the dispatcher and the guard
    // agree on which articles are "not done" — matters when the dispatcher
    // is invoked outside a wave (e.g., a CLI ad-hoc evaluation).
    const refPhases = await this.resolveReferencedArticlePhases(article, applicable);
    const violations = getPolicyViolations(article, applicable, refPhases);
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

      // ADR-009: present-but-not-done references → dispatch on the
      // referenced article so the harness can advance it. The transition
      // surfaces the referenced article's NEXT forward edge so the
      // harness has a concrete target ("from enrichment to implementation").
      // Articles already at terminal phases or with no forward edge are
      // skipped (no productive work for an agent).
      const notDone = violation.missing.referencedArticlesNotDone ?? [];
      for (const entry of notDone) {
        const refResult = await this.workRepo.findById(entry.id);
        if (!refResult.ok) {
          this.logger.warn("requires_chain dispatch skipped: referenced article not found", {
            workId: article.id,
            referencedId: entry.id,
            error: refResult.error.message,
          });
          continue;
        }
        const refArticle = refResult.value;
        const next = getNextPhase(refArticle);
        if (next === null) continue;
        slots.push({
          workId: refArticle.id,
          role: "author",
          transition: { from: refArticle.phase, to: next },
          reason: "requires_chain",
          triggeredBy: {
            policySlug: violation.policySlug,
            blockingArticle: workId(article.id),
          },
        });
      }
    }
    return slots;
  }

  /**
   * Build the {workId → phase} map needed by `getPolicyViolations` to
   * detect not-done references. Scoped to references touched by the
   * applicable policies (not all work articles) — the dispatcher is
   * invoked off the hot path so a focused fetch reads cleaner than a
   * full enumerate. Falls back to an empty map on infra errors so
   * presence-only checks still pass.
   */
  private async resolveReferencedArticlePhases(
    article: WorkArticle,
    policies: ReadonlyArray<{ requires: { referencedArticles: readonly string[] } }>,
  ): Promise<ReadonlyMap<string, WorkPhase>> {
    const referenced = new Set(article.references);
    const ids = new Set<string>();
    for (const policy of policies) {
      for (const ref of policy.requires.referencedArticles) {
        if (referenced.has(ref)) ids.add(ref);
      }
    }
    const map = new Map<string, WorkPhase>();
    for (const id of ids) {
      const result = await this.workRepo.findById(id);
      if (result.ok) {
        map.set(id, result.value.phase);
      }
      // Knowledge articles or unknown ids: silently absent → exempt from phase check.
    }
    return map;
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

  private buildContextPackSummary(
    article: WorkArticle,
    role: string,
    extraGuidance?: readonly string[],
  ): AgentContextPackSummary {
    const cdLine = this.worktreePath
      ? `cd ${this.worktreePath} && pwd # safe-parallel-dispatch invariant from ADR-012`
      : "cd <target-worktree> && pwd # safe-parallel-dispatch invariant from ADR-012; alt: monsthera ... --assert-worktree <path>";
    const guidance: string[] = [
      `Read context pack: build_context_pack({ work_id: "${article.id}", query: "${article.id}" })`,
      cdLine,
      `Acting as ${role}, contribute the ${role} Perspective section to ${article.id}.`,
      ...(extraGuidance ?? []),
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
