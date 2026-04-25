import type { Result } from "../core/result.js";
import { err } from "../core/result.js";
import { ValidationError } from "../core/errors.js";
import type { NotFoundError, StorageError, StateTransitionError, GuardFailedError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { StatusReporter } from "../core/status.js";
import type { WorkPhase as WorkPhaseType } from "../core/types.js";
import { workId, agentId, WorkPhase } from "../core/types.js";
import type { OrchestrationEventRepository, OrchestrationEventType } from "../orchestration/repository.js";
import type { ConvoyRepository } from "../orchestration/convoy-repository.js";
import type { ConvoyLeadCancelledWarningEventDetails } from "../orchestration/types.js";
import type { WorkArticle, WorkArticleRepository, CreateWorkArticleInput, UpdateWorkArticleInput, AdvancePhaseOptions } from "./repository.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { SearchMutationSync } from "../search/sync.js";
import type { WikiBookkeeper } from "../knowledge/wiki-bookkeeper.js";
import type { SnapshotService } from "../context/snapshot-service.js";
import { validateCreateWorkInput, validateUpdateWorkInput } from "./schemas.js";
import { WORK_TEMPLATES } from "./templates.js";
import { readHeadLockfileHashes } from "./lockfile-hashes.js";

// ─── WorkService ─────────────────────────────────────────────────────────────

export interface WorkServiceDeps {
  workRepo: WorkArticleRepository;
  logger: Logger;
  searchSync?: SearchMutationSync;
  status?: StatusReporter;
  orchestrationRepo?: OrchestrationEventRepository;
  bookkeeper?: WikiBookkeeper;
  /** Required for templates that opt into the async `snapshot_ready` guard. */
  snapshotService?: SnapshotService;
  /** Absolute path to the repo root; used to hash HEAD lockfiles for the guard. */
  repoPath?: string;
  /**
   * Optional: when wired, cancelling a work article that is the lead of any
   * active convoy emits a `convoy_lead_cancelled_warning` event per affected
   * convoy (ADR-013). Members are NOT auto-cancelled; the event is the
   * operator's signal to decide. Decoupled so existing tests that don't
   * care about convoys keep passing without a fake repo.
   */
  convoyRepo?: ConvoyRepository;
}

export class WorkService {
  private readonly repo: WorkArticleRepository;
  private readonly logger: Logger;
  private readonly searchSync?: SearchMutationSync;
  private readonly status?: StatusReporter;
  private readonly orchestrationRepo?: OrchestrationEventRepository;
  private readonly bookkeeper?: WikiBookkeeper;
  private readonly snapshotService?: SnapshotService;
  private readonly repoPath?: string;
  private readonly convoyRepo?: ConvoyRepository;

  constructor(deps: WorkServiceDeps) {
    this.repo = deps.workRepo;
    this.logger = deps.logger.child({ domain: "work" });
    this.searchSync = deps.searchSync;
    this.status = deps.status;
    this.orchestrationRepo = deps.orchestrationRepo;
    this.bookkeeper = deps.bookkeeper;
    this.snapshotService = deps.snapshotService;
    this.repoPath = deps.repoPath;
    this.convoyRepo = deps.convoyRepo;
  }

  async createWork(
    input: unknown,
  ): Promise<Result<WorkArticle, ValidationError | StorageError>> {
    const validated = validateCreateWorkInput(input);
    if (!validated.ok) return validated;
    this.logger.info("Creating work article", { operation: "createWork", title: validated.value.title });
    const result = await this.repo.create(validated.value as unknown as CreateWorkArticleInput);
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
      await this.refreshCounts();
      await this.bookkeeper?.appendLog("create", "work", result.value.title, result.value.id);
      await this.rebuildIndex();
    }
    return result;
  }

  async getWork(
    id: string,
  ): Promise<Result<WorkArticle, NotFoundError | StorageError>> {
    this.logger.debug("Getting work article", { operation: "getWork", id });
    return this.repo.findById(id);
  }

  async updateWork(
    id: string,
    input: unknown,
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const validated = validateUpdateWorkInput(input);
    if (!validated.ok) return validated;
    this.logger.info("Updating work article", { operation: "updateWork", id });
    const result = await this.repo.update(id, validated.value as unknown as UpdateWorkArticleInput);
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
      await this.bookkeeper?.appendLog("update", "work", result.value.title, result.value.id);
      await this.rebuildIndex();
    }
    return result;
  }

  async deleteWork(
    id: string,
  ): Promise<Result<void, NotFoundError | StateTransitionError | StorageError>> {
    this.logger.info("Deleting work article", { operation: "deleteWork", id });
    const existing = await this.repo.findById(id);
    const title = existing.ok ? existing.value.title : id;
    const result = await this.repo.delete(id);
    if (result.ok) {
      await this.removeIndexedArticle(id);
      await this.refreshCounts();
      await this.bookkeeper?.appendLog("delete", "work", title, id);
      await this.rebuildIndex();
    }
    return result;
  }

  async listWork(
    phase?: WorkPhaseType,
  ): Promise<Result<WorkArticle[], StorageError>> {
    if (phase) {
      this.logger.debug("Listing work articles by phase", { operation: "listWork", phase });
      return this.repo.findByPhase(phase);
    }
    this.logger.debug("Listing all work articles", { operation: "listWork" });
    return this.repo.findMany();
  }

  async advancePhase(
    id: string,
    targetPhase: WorkPhaseType,
    options?: AdvancePhaseOptions,
  ): Promise<Result<WorkArticle, ValidationError | StateTransitionError | GuardFailedError | NotFoundError | StorageError>> {
    // Tier 2.1 — cancellation requires an explicit reason at the service boundary
    // to guarantee an audit trail for every cancelled work article, regardless
    // of which tool/script initiated it.
    if (targetPhase === WorkPhase.CANCELLED) {
      const reason = options?.reason;
      if (typeof reason !== "string" || reason.trim().length === 0) {
        return err(new ValidationError(
          "A non-empty 'reason' is required when advancing a work article to 'cancelled'",
          { targetPhase },
        ));
      }
    }
    this.logger.info("Advancing work article phase", { operation: "advancePhase", id, targetPhase });
    // Resolve async-guard deps once per advance when a template opts in.
    const enrichedOptions = await this.enrichOptionsWithGuardDeps(id, targetPhase, options);
    const result = await this.repo.advancePhase(workId(id), targetPhase, enrichedOptions);
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
      await this.logEvent(result.value.id, "phase_advanced", {
        to: result.value.phase,
        phaseHistory: result.value.phaseHistory,
      });
      if (targetPhase === WorkPhase.CANCELLED) {
        await this.emitConvoyLeadCancelledWarnings(result.value.id, options?.reason ?? "");
      }
      await this.bookkeeper?.appendLog("advance", "work", `${result.value.title} → ${result.value.phase}`, result.value.id);
      await this.rebuildIndex();
    }
    return result;
  }

  /**
   * After a successful cancellation, emit one `convoy_lead_cancelled_warning`
   * per active convoy where the cancelled article is the lead (ADR-013).
   * This is the observable signal that members are now blocked on a dead
   * lead — the operator decides whether to cancel the convoy, reassign the
   * lead, or do nothing. We deliberately do NOT auto-cancel members; that
   * would invert the "decision is human" framing from ADR-009.
   *
   * Fail-open: any lookup or emit error is warn-logged and swallowed; the
   * cancellation itself already succeeded and must not be undone by an
   * observability hiccup.
   */
  private async emitConvoyLeadCancelledWarnings(
    cancelledWorkId: string,
    reason: string,
  ): Promise<void> {
    if (!this.convoyRepo || !this.orchestrationRepo) return;
    const convoysResult = await this.convoyRepo.findByMember(workId(cancelledWorkId));
    if (!convoysResult.ok) {
      this.logger.warn("Failed to look up convoys for lead-cancellation warning", {
        operation: "emitConvoyLeadCancelledWarnings",
        cancelledWorkId,
        error: convoysResult.error.message,
      });
      return;
    }
    for (const convoy of convoysResult.value) {
      if (convoy.status !== "active") continue;
      if (convoy.leadWorkId !== cancelledWorkId) continue;
      const details: ConvoyLeadCancelledWarningEventDetails = {
        convoyId: convoy.id,
        leadWorkId: convoy.leadWorkId,
        memberWorkIds: convoy.memberWorkIds,
        reason,
      };
      await this.logEvent(cancelledWorkId, "convoy_lead_cancelled_warning", details as unknown as Record<string, unknown>);
    }
  }

  // ─── Enrichment & Review ───────────────────────────────────────────────────

  async contributeEnrichment(
    id: string,
    role: string,
    status: "contributed" | "skipped",
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    this.logger.info("Recording enrichment contribution", { operation: "contributeEnrichment", id, role, status });
    const result = await this.repo.contributeEnrichment(workId(id), role, status);
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
    }
    return result;
  }

  async assignReviewer(
    id: string,
    reviewerAgentId: string,
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    this.logger.info("Assigning reviewer", { operation: "assignReviewer", id, reviewerAgentId });
    const result = await this.repo.assignReviewer(workId(id), agentId(reviewerAgentId));
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
    }
    return result;
  }

  async submitReview(
    id: string,
    reviewerAgentId: string,
    status: "approved" | "changes-requested",
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    this.logger.info("Submitting review", { operation: "submitReview", id, reviewerAgentId, status });
    const result = await this.repo.submitReview(workId(id), agentId(reviewerAgentId), status);
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
    }
    return result;
  }

  // ─── Dependencies ─────────────────────────────────────────────────────────

  async addDependency(
    id: string,
    blockedById: string,
  ): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>> {
    this.logger.info("Adding dependency", { operation: "addDependency", id, blockedById });
    const result = await this.repo.addDependency(workId(id), workId(blockedById));
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
      await this.logEvent(result.value.id, "dependency_blocked", { blockedById });
    }
    return result;
  }

  async removeDependency(
    id: string,
    blockedById: string,
  ): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>> {
    this.logger.info("Removing dependency", { operation: "removeDependency", id, blockedById });
    const result = await this.repo.removeDependency(workId(id), workId(blockedById));
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
      await this.logEvent(result.value.id, "dependency_resolved", { blockedById });
    }
    return result;
  }

  /**
   * Attach `guardDeps` (snapshot service + HEAD lockfile hashes) to the advance
   * options when the target transition is a template-gated one that requires
   * async guard evaluation. No-op for other transitions / templates so the
   * existing fast path stays unchanged.
   */
  private async enrichOptionsWithGuardDeps(
    id: string,
    targetPhase: WorkPhaseType,
    options?: AdvancePhaseOptions,
  ): Promise<AdvancePhaseOptions | undefined> {
    if (targetPhase !== WorkPhase.IMPLEMENTATION) return options;
    if (!this.snapshotService) return options;
    const existing = await this.repo.findById(id);
    if (!existing.ok) return options;
    const template = existing.value.template;
    if (!WORK_TEMPLATES[template].requiresSnapshotForImplementation) return options;

    const headLockfileHashes = this.repoPath
      ? await readHeadLockfileHashes(this.repoPath)
      : {};
    const guardDeps = { snapshotService: this.snapshotService, headLockfileHashes };
    return { ...(options ?? {}), guardDeps };
  }

  private async syncIndexedArticle(id: string): Promise<void> {
    if (!this.searchSync) return;
    const syncResult = await this.searchSync.indexWorkArticle(id);
    if (!syncResult.ok) {
      this.logger.warn("Work article indexed with warnings", {
        operation: "indexWorkArticle",
        id,
        error: syncResult.error.message,
      });
    }
  }

  private async removeIndexedArticle(id: string): Promise<void> {
    if (!this.searchSync) return;
    const syncResult = await this.searchSync.removeArticle(id);
    if (!syncResult.ok) {
      this.logger.warn("Work article removal not reflected in search index", {
        operation: "removeWorkArticleFromIndex",
        id,
        error: syncResult.error.message,
      });
    }
  }

  private async refreshCounts(): Promise<void> {
    if (!this.status) return;
    const countResult = await this.repo.findMany();
    if (countResult.ok) {
      this.status.recordStat("workArticleCount", countResult.value.length);
    }
  }

  private async rebuildIndex(): Promise<void> {
    if (!this.bookkeeper || !this._knowledgeRepoRef) return;
    const knowledge = await this._knowledgeRepoRef.findMany();
    if (!knowledge.ok) return;
    const work = await this.repo.findMany();
    if (!work.ok) return;
    await this.bookkeeper.rebuildIndex(knowledge.value, work.value);
  }

  private async logEvent(
    id: string,
    eventType: OrchestrationEventType,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.orchestrationRepo) return;
    const eventResult = await this.orchestrationRepo.logEvent({
      workId: workId(id),
      eventType,
      details,
    });
    if (!eventResult.ok) {
      this.logger.warn("Failed to log orchestration event", {
        operation: "logEvent",
        id,
        eventType,
        error: eventResult.error.message,
      });
    }
  }

  private _knowledgeRepoRef?: Pick<KnowledgeArticleRepository, "findMany">;
  setKnowledgeRepo(knowledgeRepo: typeof this._knowledgeRepoRef): void {
    this._knowledgeRepoRef = knowledgeRepo;
  }
}
