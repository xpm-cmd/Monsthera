import type { Result } from "../core/result.js";
import type { NotFoundError, StorageError, ValidationError, StateTransitionError, GuardFailedError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { StatusReporter } from "../core/status.js";
import type { WorkPhase as WorkPhaseType } from "../core/types.js";
import { workId, agentId } from "../core/types.js";
import type { OrchestrationEventRepository, OrchestrationEventType } from "../orchestration/repository.js";
import type { WorkArticle, WorkArticleRepository, CreateWorkArticleInput, UpdateWorkArticleInput } from "./repository.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { SearchMutationSync } from "../search/sync.js";
import type { WikiBookkeeper } from "../knowledge/wiki-bookkeeper.js";
import { validateCreateWorkInput, validateUpdateWorkInput } from "./schemas.js";

// ─── WorkService ─────────────────────────────────────────────────────────────

export interface WorkServiceDeps {
  workRepo: WorkArticleRepository;
  logger: Logger;
  searchSync?: SearchMutationSync;
  status?: StatusReporter;
  orchestrationRepo?: OrchestrationEventRepository;
  bookkeeper?: WikiBookkeeper;
}

export class WorkService {
  private readonly repo: WorkArticleRepository;
  private readonly logger: Logger;
  private readonly searchSync?: SearchMutationSync;
  private readonly status?: StatusReporter;
  private readonly orchestrationRepo?: OrchestrationEventRepository;
  private readonly bookkeeper?: WikiBookkeeper;

  constructor(deps: WorkServiceDeps) {
    this.repo = deps.workRepo;
    this.logger = deps.logger.child({ domain: "work" });
    this.searchSync = deps.searchSync;
    this.status = deps.status;
    this.orchestrationRepo = deps.orchestrationRepo;
    this.bookkeeper = deps.bookkeeper;
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
  ): Promise<Result<WorkArticle, StateTransitionError | GuardFailedError | NotFoundError | StorageError>> {
    this.logger.info("Advancing work article phase", { operation: "advancePhase", id, targetPhase });
    const result = await this.repo.advancePhase(workId(id), targetPhase);
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
      await this.logEvent(result.value.id, "phase_advanced", {
        to: result.value.phase,
        phaseHistory: result.value.phaseHistory,
      });
      await this.bookkeeper?.appendLog("advance", "work", `${result.value.title} → ${result.value.phase}`, result.value.id);
      await this.rebuildIndex();
    }
    return result;
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
