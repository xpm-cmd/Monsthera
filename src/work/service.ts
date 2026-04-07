import type { Result } from "../core/result.js";
import type { NotFoundError, StorageError, ValidationError, StateTransitionError, GuardFailedError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { WorkPhase as WorkPhaseType } from "../core/types.js";
import { workId, agentId } from "../core/types.js";
import type { WorkArticle, WorkArticleRepository, CreateWorkArticleInput, UpdateWorkArticleInput } from "./repository.js";
import { validateCreateWorkInput, validateUpdateWorkInput } from "./schemas.js";

// ─── WorkService ─────────────────────────────────────────────────────────────

export interface WorkServiceDeps {
  workRepo: WorkArticleRepository;
  logger: Logger;
}

export class WorkService {
  private readonly repo: WorkArticleRepository;
  private readonly logger: Logger;

  constructor(deps: WorkServiceDeps) {
    this.repo = deps.workRepo;
    this.logger = deps.logger;
  }

  async createWork(
    input: unknown,
  ): Promise<Result<WorkArticle, ValidationError | StorageError>> {
    const validated = validateCreateWorkInput(input);
    if (!validated.ok) return validated;
    this.logger.info("Creating work article", { title: validated.value.title });
    return this.repo.create(validated.value as unknown as CreateWorkArticleInput);
  }

  async getWork(
    id: string,
  ): Promise<Result<WorkArticle, NotFoundError | StorageError>> {
    this.logger.debug("Getting work article", { id });
    return this.repo.findById(id);
  }

  async updateWork(
    id: string,
    input: unknown,
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const validated = validateUpdateWorkInput(input);
    if (!validated.ok) return validated;
    this.logger.info("Updating work article", { id });
    return this.repo.update(id, validated.value as unknown as UpdateWorkArticleInput);
  }

  async deleteWork(
    id: string,
  ): Promise<Result<void, NotFoundError | StateTransitionError | StorageError>> {
    this.logger.info("Deleting work article", { id });
    return this.repo.delete(id);
  }

  async listWork(
    phase?: WorkPhaseType,
  ): Promise<Result<WorkArticle[], StorageError>> {
    if (phase) {
      this.logger.debug("Listing work articles by phase", { phase });
      return this.repo.findByPhase(phase);
    }
    this.logger.debug("Listing all work articles");
    return this.repo.findMany();
  }

  async advancePhase(
    id: string,
    targetPhase: WorkPhaseType,
  ): Promise<Result<WorkArticle, StateTransitionError | GuardFailedError | NotFoundError | StorageError>> {
    this.logger.info("Advancing work article phase", { id, targetPhase });
    return this.repo.advancePhase(workId(id), targetPhase);
  }

  // ─── Enrichment & Review ───────────────────────────────────────────────────

  async contributeEnrichment(
    id: string,
    role: string,
    status: "contributed" | "skipped",
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    this.logger.info("Recording enrichment contribution", { id, role, status });
    return this.repo.contributeEnrichment(workId(id), role, status);
  }

  async assignReviewer(
    id: string,
    reviewerAgentId: string,
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    this.logger.info("Assigning reviewer", { id, reviewerAgentId });
    return this.repo.assignReviewer(workId(id), agentId(reviewerAgentId));
  }

  async submitReview(
    id: string,
    reviewerAgentId: string,
    status: "approved" | "changes-requested",
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    this.logger.info("Submitting review", { id, reviewerAgentId, status });
    return this.repo.submitReview(workId(id), agentId(reviewerAgentId), status);
  }

  // ─── Dependencies ─────────────────────────────────────────────────────────

  async addDependency(
    id: string,
    blockedById: string,
  ): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>> {
    this.logger.info("Adding dependency", { id, blockedById });
    return this.repo.addDependency(workId(id), workId(blockedById));
  }

  async removeDependency(
    id: string,
    blockedById: string,
  ): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>> {
    this.logger.info("Removing dependency", { id, blockedById });
    return this.repo.removeDependency(workId(id), workId(blockedById));
  }
}
