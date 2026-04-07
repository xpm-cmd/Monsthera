import type { Repository } from "../core/repository.js";
import type { Result } from "../core/result.js";
import type { WorkId, AgentId, WorkPhase, Priority, WorkTemplate, Timestamp } from "../core/types.js";
import type { NotFoundError, StorageError, StateTransitionError, ValidationError } from "../core/errors.js";

/** Enrichment role assignment */
export interface EnrichmentAssignment {
  readonly role: string;
  readonly agentId: AgentId;
  readonly status: "pending" | "contributed" | "skipped";
  readonly contributedAt?: Timestamp;
}

/** Review assignment */
export interface ReviewAssignment {
  readonly agentId: AgentId;
  readonly status: "pending" | "approved" | "changes-requested";
  readonly reviewedAt?: Timestamp;
}

/** Phase history entry */
export interface PhaseHistoryEntry {
  readonly phase: WorkPhase;
  readonly enteredAt: Timestamp;
  readonly exitedAt?: Timestamp;
}

/** Work article entity */
export interface WorkArticle {
  readonly id: WorkId;
  readonly title: string;
  readonly template: WorkTemplate;
  readonly phase: WorkPhase;
  readonly priority: Priority;
  readonly author: AgentId;
  readonly lead?: AgentId;
  readonly assignee?: AgentId;
  readonly enrichmentRoles: readonly EnrichmentAssignment[];
  readonly reviewers: readonly ReviewAssignment[];
  readonly phaseHistory: readonly PhaseHistoryEntry[];
  readonly tags: readonly string[];
  readonly references: readonly string[];
  readonly codeRefs: readonly string[];
  readonly dependencies: readonly WorkId[];
  readonly blockedBy: readonly WorkId[];
  readonly content: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly completedAt?: Timestamp;
}

/** Input for creating a work article */
export interface CreateWorkArticleInput {
  title: string;
  template: WorkTemplate;
  priority: Priority;
  author: AgentId;
  lead?: AgentId;
  tags?: string[];
  content?: string;
}

/** Input for updating a work article */
export interface UpdateWorkArticleInput {
  title?: string;
  priority?: Priority;
  lead?: AgentId;
  assignee?: AgentId;
  tags?: string[];
  references?: string[];
  codeRefs?: string[];
  content?: string;
}

/** Work article repository with domain-specific queries */
export interface WorkArticleRepository
  extends Repository<WorkArticle, CreateWorkArticleInput, UpdateWorkArticleInput> {
  /** Override: terminal-phase articles cannot be deleted */
  delete(id: string): Promise<Result<void, NotFoundError | StateTransitionError | StorageError>>;
  /** Override: terminal-phase articles cannot be updated */
  update(id: string, input: UpdateWorkArticleInput): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>>;
  findByPhase(phase: WorkPhase): Promise<Result<WorkArticle[], StorageError>>;
  findByAssignee(agentId: AgentId): Promise<Result<WorkArticle[], StorageError>>;
  findByPriority(priority: Priority): Promise<Result<WorkArticle[], StorageError>>;
  findActive(): Promise<Result<WorkArticle[], StorageError>>;
  findBlocked(): Promise<Result<WorkArticle[], StorageError>>;
  advancePhase(id: WorkId, targetPhase: WorkPhase): Promise<Result<WorkArticle, StateTransitionError | NotFoundError | StorageError>>;

  /** Record an enrichment contribution or skip for a role */
  contributeEnrichment(id: WorkId, role: string, status: "contributed" | "skipped"): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>>;
  /** Add a reviewer to the article */
  assignReviewer(id: WorkId, agentId: AgentId): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>>;
  /** Record a review outcome */
  submitReview(id: WorkId, agentId: AgentId, status: "approved" | "changes-requested"): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>>;
  /** Add a dependency (blockedBy relationship) */
  addDependency(id: WorkId, blockedById: WorkId): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>>;
  /** Remove a dependency */
  removeDependency(id: WorkId, blockedById: WorkId): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>>;
}
