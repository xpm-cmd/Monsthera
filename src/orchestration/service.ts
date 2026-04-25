import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";
import type { Logger } from "../core/logger.js";
import type { NotFoundError, StorageError, StateTransitionError } from "../core/errors.js";
import { GuardFailedError } from "../core/errors.js";
import { workId } from "../core/types.js";
import type { WorkPhase } from "../core/types.js";
import type { WorkArticleRepository, WorkArticle } from "../work/repository.js";
import type { OrchestrationEventRepository } from "./repository.js";
import { getGuardSet, getNextPhase } from "../work/lifecycle.js";
import type { GuardSetDeps } from "../work/lifecycle.js";
import { WORK_TEMPLATES, getPhaseOrder } from "../work/templates.js";
import type { PolicyLoader } from "../work/policy-loader.js";
import type { ConvoyRepository } from "./convoy-repository.js";
import type {
  ReadinessReport,
  AdvanceResult,
  GuardFailure,
  WavePlan,
  WaveResult,
  DispatchedAgentRequest,
} from "./types.js";
import type { AgentDispatcher } from "./agent-dispatcher.js";

// ─── Dependencies ───────────────────────────────────────────────────────────

export interface OrchestrationServiceDeps {
  workRepo: WorkArticleRepository;
  orchestrationRepo: OrchestrationEventRepository;
  logger: Logger;
  autoAdvance?: boolean;
  pollIntervalMs?: number;
  maxConcurrentAgents?: number;
  /**
   * Optional: consulted before every guard evaluation so knowledge-authored
   * policies gate transitions. Absent = no policy enforcement (legacy behavior).
   */
  policyLoader?: PolicyLoader;
  /**
   * Optional: when wired, every wave execution converts `guardFailures` into
   * `agent_needed` events via the dispatcher. Absent = no dispatch (legacy
   * behavior; tests that pre-date ADR-008 still pass).
   */
  agentDispatcher?: AgentDispatcher;
  /**
   * Optional: when wired, planWave loads active convoys and prepends a
   * `convoy_lead_ready` guard for members. Absent = legacy behavior, no
   * convoy gating. Decoupled from the work repo so existing tests that
   * construct an OrchestrationService without convoys keep passing.
   */
  convoyRepo?: ConvoyRepository;
}

// ─── OrchestrationService ───────────────────────────────────────────────────

export class OrchestrationService {
  private readonly workRepo: WorkArticleRepository;
  private readonly eventRepo: OrchestrationEventRepository;
  private readonly logger: Logger;
  private readonly autoAdvance: boolean;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrentAgents: number;
  private readonly policyLoader?: PolicyLoader;
  private readonly agentDispatcher?: AgentDispatcher;
  private readonly convoyRepo?: ConvoyRepository;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: OrchestrationServiceDeps) {
    this.workRepo = deps.workRepo;
    this.eventRepo = deps.orchestrationRepo;
    this.logger = deps.logger.child({ domain: "orchestration" });
    this.autoAdvance = deps.autoAdvance ?? false;
    this.pollIntervalMs = deps.pollIntervalMs ?? 30000;
    this.maxConcurrentAgents = Math.max(1, deps.maxConcurrentAgents ?? 5);
    this.policyLoader = deps.policyLoader;
    this.agentDispatcher = deps.agentDispatcher;
    this.convoyRepo = deps.convoyRepo;
  }

  /**
   * Build the deps object passed into `getGuardSet`. When a `PolicyLoader` is
   * wired, all loaded policies are handed over along with the loader's
   * `getApplicablePolicies` filter so `getGuardSet` can narrow to policies
   * that match this article + transition. When a `ConvoyRepository` is wired,
   * active convoys are pre-loaded and a `convoyLeadByMember` lookup is built
   * so the lifecycle layer can prepend `convoy_lead_ready` for members
   * without re-scanning the convoy table per article.
   *
   * Called once per readiness check / wave so the convoy + policy lookups
   * cost O(scan) per pass instead of O(scan × articles).
   */
  /**
   * Build the deps wired into `getGuardSet`. Returns a Result so the
   * referenced-article phase lookup (ADR-009 hard block) can fail closed
   * — degrading silently to legacy presence-only would let a work
   * article advance past a policy that should have blocked it. Convoy
   * lookup failures stay non-fatal (they only ever block, never unblock).
   */
  private async buildGuardDeps(): Promise<Result<GuardSetDeps | undefined, StorageError>> {
    const convoyLookup = await this.buildConvoyLookup();
    let referencedPhases: ReadonlyMap<string, WorkPhase> | undefined;
    if (this.policyLoader) {
      const phasesResult = await this.buildReferencedArticlePhases();
      if (!phasesResult.ok) return phasesResult;
      referencedPhases = phasesResult.value;
    }
    if (!this.policyLoader && !convoyLookup) return ok(undefined);

    const out: { -readonly [K in keyof GuardSetDeps]: GuardSetDeps[K] } = {};
    if (this.policyLoader) {
      const policies = await this.policyLoader.getAll();
      out.policies = policies;
      out.applicablePolicyFilter = (loaded, article, transition) =>
        this.policyLoader!.getApplicablePolicies(loaded, article, transition);
    }
    if (convoyLookup) {
      out.convoyLeadByMember = convoyLookup;
    }
    if (referencedPhases) {
      out.referencedArticlePhases = referencedPhases;
    }
    return ok(out);
  }

  /**
   * Build the {workId → phase} lookup that lets `policy_requires_articles`
   * enforce "referenced article must be done" without giving guards a
   * repository handle (ADR-009). Snapshots ALL known work articles in one
   * pass — cheaper than a per-policy fetch when policies cluster references.
   * Knowledge-article ids are deliberately absent so the guard treats them
   * as exempt.
   *
   * Fails CLOSED on enumeration errors: the alternative (returning
   * undefined and letting the guard run in legacy presence-only mode)
   * silently downgrades the hard-block contract — a transient storage
   * blip could let A advance even though B is not done. Surfacing the
   * error halts the wave; the next pass retries.
   */
  private async buildReferencedArticlePhases(): Promise<Result<ReadonlyMap<string, WorkPhase>, StorageError>> {
    const allResult = await this.workRepo.findMany();
    if (!allResult.ok) {
      this.logger.error("Failed to load work articles for referenced-phase lookup; failing wave closed", {
        operation: "buildReferencedArticlePhases",
        error: allResult.error.message,
      });
      return allResult;
    }
    const map = new Map<string, WorkPhase>();
    for (const article of allResult.value) {
      map.set(article.id, article.phase);
    }
    return ok(map);
  }

  /**
   * Build the per-member convoy lookup consumed by `getGuardSet`. Returns
   * undefined when no `ConvoyRepository` is wired or no active convoys
   * exist — both conditions short-circuit the convoy guard and keep the
   * legacy code path clean for tests that don't care about convoys.
   *
   * For each active convoy, fetches the lead's current phase from the work
   * repo (a convoy referencing a deleted/unknown lead is logged and
   * skipped — fail open rather than block the entire wave).
   */
  private async buildConvoyLookup(): Promise<GuardSetDeps["convoyLeadByMember"] | undefined> {
    if (!this.convoyRepo) return undefined;
    const activeResult = await this.convoyRepo.findActive();
    if (!activeResult.ok) {
      this.logger.warn("Failed to load active convoys; convoy guard disabled this wave", {
        operation: "buildConvoyLookup",
        error: activeResult.error.message,
      });
      return undefined;
    }
    if (activeResult.value.length === 0) return undefined;

    const lookup = new Map<string, NonNullable<GuardSetDeps["convoyLeadByMember"]> extends ReadonlyMap<string, infer V> ? V : never>();
    for (const convoy of activeResult.value) {
      const leadResult = await this.workRepo.findById(convoy.leadWorkId);
      if (!leadResult.ok) {
        this.logger.warn("Convoy lead not found; skipping convoy", {
          operation: "buildConvoyLookup",
          convoyId: convoy.id,
          leadWorkId: convoy.leadWorkId,
          error: leadResult.error.message,
        });
        continue;
      }
      const lead = leadResult.value;
      const phaseOrder = getPhaseOrder(lead.template);
      for (const memberId of convoy.memberWorkIds) {
        lookup.set(memberId, {
          convoyId: convoy.id,
          leadWorkId: convoy.leadWorkId,
          leadPhase: lead.phase,
          targetPhase: convoy.targetPhase,
          phaseOrder,
        });
      }
    }
    return lookup.size > 0 ? lookup : undefined;
  }

  // ─── Scanning ─────────────────────────────────────────────────────────────

  async scanActiveWork(): Promise<Result<WorkArticle[], StorageError>> {
    this.logger.debug("Scanning active work articles", { operation: "scanActiveWork" });
    return this.workRepo.findActive();
  }

  // ─── Guard Evaluation ─────────────────────────────────────────────────────

  async evaluateReadiness(
    id: string,
  ): Promise<Result<ReadinessReport, NotFoundError | StorageError>> {
    const articleResult = await this.workRepo.findById(id);
    if (!articleResult.ok) return articleResult;

    const article = articleResult.value;
    const nextPhase = getNextPhase(article);

    if (nextPhase === null) {
      const report: ReadinessReport = {
        workId: id,
        currentPhase: article.phase,
        nextPhase: null,
        ready: false,
        guardResults: [],
      };
      return ok(report);
    }

    const guardDepsResult = await this.buildGuardDeps();
    if (!guardDepsResult.ok) return guardDepsResult;
    const guards = getGuardSet(article, article.phase, nextPhase, guardDepsResult.value);
    const guardResults = guards.map((g) => ({
      name: g.name,
      passed: g.check(article),
    }));
    const ready = guardResults.length === 0 || guardResults.every((r) => r.passed);

    // Log guard evaluation event
    await this.eventRepo.logEvent({
      workId: workId(id),
      eventType: "guard_evaluated",
      details: {
        currentPhase: article.phase,
        targetPhase: nextPhase,
        ready,
        guardResults,
      },
    });

    const report: ReadinessReport = {
      workId: id,
      currentPhase: article.phase,
      nextPhase,
      ready,
      guardResults,
    };
    return ok(report);
  }

  // ─── Phase Advancement ────────────────────────────────────────────────────

  async tryAdvance(
    id: string,
  ): Promise<Result<AdvanceResult, NotFoundError | StateTransitionError | GuardFailedError | StorageError>> {
    const readinessResult = await this.evaluateReadiness(id);
    if (!readinessResult.ok) return readinessResult;

    const report = readinessResult.value;
    if (!report.ready || report.nextPhase === null) {
      const failedGuards = report.guardResults
        .filter((g) => !g.passed)
        .map((g) => g.name);
      return err(
        new GuardFailedError(
          failedGuards.join(", ") || "no_next_phase",
          `Work article "${id}" is not ready to advance: ${failedGuards.join(", ") || "terminal phase"}`,
        ),
      );
    }

    const from = report.currentPhase;
    const to = report.nextPhase;

    const advanceResult = await this.workRepo.advancePhase(workId(id), to);
    if (!advanceResult.ok) {
      // Log error event
      await this.eventRepo.logEvent({
        workId: workId(id),
        eventType: "error_occurred",
        details: { operation: "tryAdvance", error: advanceResult.error.message },
      });
      return advanceResult;
    }

    // Log phase advancement event
    await this.eventRepo.logEvent({
      workId: workId(id),
      eventType: "phase_advanced",
      details: { from, to },
    });

    this.logger.info("Work article advanced", { operation: "tryAdvance", workId: id, from, to });

    const result: AdvanceResult = {
      workId: id,
      from,
      to,
      article: advanceResult.value,
    };
    return ok(result);
  }

  // ─── Wave Planning ────────────────────────────────────────────────────────

  async planWave(opts?: { autoAdvanceOnly?: boolean }): Promise<Result<WavePlan, StorageError>> {
    const activeResult = await this.scanActiveWork();
    if (!activeResult.ok) return activeResult;

    const articles = activeResult.value;
    const items: Array<{ workId: string; from: WorkPhase; to: WorkPhase }> = [];
    const blockedItems: Array<{ workId: string; reason: string }> = [];

    // Collect IDs of terminal articles to check dependency resolution
    const allArticleResults = await this.workRepo.findMany();
    if (!allArticleResults.ok) return allArticleResults;
    const terminalIds = new Set<string>();
    for (const a of allArticleResults.value) {
      if (a.phase === "done" || a.phase === "cancelled") {
        terminalIds.add(a.id);
      }
    }

    const guardDepsResult = await this.buildGuardDeps();
    if (!guardDepsResult.ok) return guardDepsResult;
    const guardDeps = guardDepsResult.value;
    const guardFailures: GuardFailure[] = [];
    for (const article of articles) {
      // Check if blocked by unresolved dependencies
      const unresolvedDeps = article.blockedBy.filter((dep) => !terminalIds.has(dep));
      if (unresolvedDeps.length > 0) {
        blockedItems.push({
          workId: article.id,
          reason: `Blocked by: ${unresolvedDeps.join(", ")}`,
        });
        continue;
      }

      // Skip articles whose template disallows auto-advance when in auto mode
      if (opts?.autoAdvanceOnly) {
        const templateConfig = WORK_TEMPLATES[article.template];
        if (!templateConfig.autoAdvance) continue;
      }

      const nextPhase = getNextPhase(article);
      if (nextPhase === null) continue;

      const guards = getGuardSet(article, article.phase, nextPhase, guardDeps);
      const guardResults = guards.map((g) => ({ name: g.name, passed: g.check(article) }));
      const allPassed = guardResults.every((g) => g.passed);

      if (allPassed) {
        items.push({ workId: article.id, from: article.phase, to: nextPhase });
      } else {
        guardFailures.push({
          workId: article.id,
          transition: { from: article.phase, to: nextPhase },
          failed: guardResults.filter((g) => !g.passed),
        });
      }
    }

    const plan: WavePlan = { items, blockedItems, guardFailures };

    // Log wave planning event
    await this.eventRepo.logEvent({
      workId: workId("wave"),
      eventType: "guard_evaluated",
      details: {
        operation: "planWave",
        readyCount: items.length,
        blockedCount: blockedItems.length,
      },
    });

    this.logger.info("Wave planned", {
      operation: "planWave",
      readyCount: items.length,
      blockedCount: blockedItems.length,
    });

    return ok(plan);
  }

  // ─── Wave Execution ───────────────────────────────────────────────────────

  async executeWave(plan: WavePlan): Promise<Result<WaveResult, StorageError>> {
    const advanced: AdvanceResult[] = [];
    const failed: Array<{ workId: string; error: string }> = [];
    let dispatched: readonly DispatchedAgentRequest[] = [];

    // Dispatch BEFORE advancing — surfaces "this article is blocked, here's
    // what's missing" even when the wave advances zero items. Failures here
    // are logged and swallowed: a dispatcher fault must not block the wave.
    if (this.agentDispatcher && plan.guardFailures.length > 0) {
      try {
        dispatched = await this.agentDispatcher.dispatchFor(plan.guardFailures);
      } catch (e) {
        this.logger.error("Agent dispatch failed mid-wave; continuing", {
          operation: "executeWave",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const processItem = async (item: WavePlan["items"][number]): Promise<void> => {
      // Verify the article is still in the expected phase (guard against stale plans)
      const currentResult = await this.workRepo.findById(item.workId);
      if (!currentResult.ok) {
        failed.push({ workId: item.workId, error: currentResult.error.message });
        return;
      }
      if (currentResult.value.phase !== item.from) {
        failed.push({
          workId: item.workId,
          error: `Phase changed since planning: expected "${item.from}", found "${currentResult.value.phase}"`,
        });
        return;
      }

      const result = await this.tryAdvance(item.workId);
      if (result.ok) {
        advanced.push(result.value);
      } else {
        failed.push({ workId: item.workId, error: result.error.message });
      }
    };

    const workerCount = Math.min(this.maxConcurrentAgents, plan.items.length);
    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      while (nextIndex < plan.items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const item = plan.items[currentIndex];
        if (!item) return;
        await processItem(item);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    if (plan.items.length === 0) {
      this.logger.debug("Wave executed with no ready items", {
        operation: "executeWave",
        maxConcurrentAgents: this.maxConcurrentAgents,
      });
    }

    this.logger.info("Wave executed", {
      operation: "executeWave",
      advancedCount: advanced.length,
      failedCount: failed.length,
      dispatchedCount: dispatched.length,
      maxConcurrentAgents: this.maxConcurrentAgents,
    });

    return ok({ advanced, failed, dispatched });
  }

  // ─── Auto-Advance Loop ────────────────────────────────────────────────────

  start(): void {
    if (!this.autoAdvance) {
      this.logger.debug("Auto-advance is disabled, not starting polling loop", { operation: "start" });
      return;
    }
    if (this.running) return;

    this.running = true;
    this.logger.info("Starting orchestration polling loop", {
      operation: "start",
      pollIntervalMs: this.pollIntervalMs,
    });

    this.pollTimer = setInterval(async () => {
      try {
        const planResult = await this.planWave({ autoAdvanceOnly: true });
        if (!planResult.ok) {
          this.logger.error("Wave planning failed", { operation: "autoAdvance", error: planResult.error.message });
          return;
        }
        if (planResult.value.items.length > 0) {
          await this.executeWave(planResult.value);
        }
      } catch (e) {
        this.logger.error("Orchestration loop error", {
          operation: "autoAdvance",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.running = false;
    this.logger.info("Orchestration polling loop stopped", { operation: "stop" });
  }

  get isRunning(): boolean {
    return this.running;
  }
}
