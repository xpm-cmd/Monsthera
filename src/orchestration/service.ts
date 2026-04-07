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
import { WORK_TEMPLATES } from "../work/templates.js";
import type { ReadinessReport, AdvanceResult, WavePlan, WaveResult } from "./types.js";

// ─── Dependencies ───────────────────────────────────────────────────────────

export interface OrchestrationServiceDeps {
  workRepo: WorkArticleRepository;
  orchestrationRepo: OrchestrationEventRepository;
  logger: Logger;
  autoAdvance?: boolean;
  pollIntervalMs?: number;
}

// ─── OrchestrationService ───────────────────────────────────────────────────

export class OrchestrationService {
  private readonly workRepo: WorkArticleRepository;
  private readonly eventRepo: OrchestrationEventRepository;
  private readonly logger: Logger;
  private readonly autoAdvance: boolean;
  private readonly pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: OrchestrationServiceDeps) {
    this.workRepo = deps.workRepo;
    this.eventRepo = deps.orchestrationRepo;
    this.logger = deps.logger;
    this.autoAdvance = deps.autoAdvance ?? false;
    this.pollIntervalMs = deps.pollIntervalMs ?? 30000;
  }

  // ─── Scanning ─────────────────────────────────────────────────────────────

  async scanActiveWork(): Promise<Result<WorkArticle[], StorageError>> {
    this.logger.debug("Scanning active work articles");
    return this.workRepo.findActive();
  }

  // ─── Guard Evaluation ─────────────────────────────────────────────────────

  async evaluateReadiness(
    id: string,
  ): Promise<Result<ReadinessReport, NotFoundError | StorageError>> {
    const articleResult = await this.workRepo.findById(id);
    if (!articleResult.ok) return articleResult;

    const article = articleResult.value;
    const nextPhase = getNextPhase(article.phase);

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

    const guards = getGuardSet(article, article.phase, nextPhase);
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

    this.logger.info("Work article advanced", { workId: id, from, to });

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

      const nextPhase = getNextPhase(article.phase);
      if (nextPhase === null) continue;

      const guards = getGuardSet(article, article.phase, nextPhase);
      const allPassed = guards.every((g) => g.check(article));

      if (allPassed) {
        items.push({ workId: article.id, from: article.phase, to: nextPhase });
      }
    }

    const plan: WavePlan = { items, blockedItems };

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
      readyCount: items.length,
      blockedCount: blockedItems.length,
    });

    return ok(plan);
  }

  // ─── Wave Execution ───────────────────────────────────────────────────────

  async executeWave(plan: WavePlan): Promise<Result<WaveResult, StorageError>> {
    const advanced: AdvanceResult[] = [];
    const failed: Array<{ workId: string; error: string }> = [];

    for (const item of plan.items) {
      // Verify the article is still in the expected phase (guard against stale plans)
      const currentResult = await this.workRepo.findById(item.workId);
      if (!currentResult.ok) {
        failed.push({ workId: item.workId, error: currentResult.error.message });
        continue;
      }
      if (currentResult.value.phase !== item.from) {
        failed.push({
          workId: item.workId,
          error: `Phase changed since planning: expected "${item.from}", found "${currentResult.value.phase}"`,
        });
        continue;
      }

      const result = await this.tryAdvance(item.workId);
      if (result.ok) {
        advanced.push(result.value);
      } else {
        failed.push({ workId: item.workId, error: result.error.message });
      }
    }

    this.logger.info("Wave executed", {
      advancedCount: advanced.length,
      failedCount: failed.length,
    });

    return ok({ advanced, failed });
  }

  // ─── Auto-Advance Loop ────────────────────────────────────────────────────

  start(): void {
    if (!this.autoAdvance) {
      this.logger.debug("Auto-advance is disabled, not starting polling loop");
      return;
    }
    if (this.running) return;

    this.running = true;
    this.logger.info("Starting orchestration polling loop", {
      pollIntervalMs: this.pollIntervalMs,
    });

    this.pollTimer = setInterval(async () => {
      try {
        const planResult = await this.planWave({ autoAdvanceOnly: true });
        if (!planResult.ok) {
          this.logger.error("Wave planning failed", { error: planResult.error.message });
          return;
        }
        if (planResult.value.items.length > 0) {
          await this.executeWave(planResult.value);
        }
      } catch (e) {
        this.logger.error("Orchestration loop error", {
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
    this.logger.info("Orchestration polling loop stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }
}
