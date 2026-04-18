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
  /** Tier 2.1 — set on cancellation + skip_guard transitions */
  readonly reason?: string;
  /** Tier 2.1 — names of guards bypassed via skip_guard */
  readonly skippedGuards?: readonly string[];
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
  phase?: WorkPhase;
  priority: Priority;
  author: AgentId;
  lead?: AgentId;
  assignee?: AgentId;
  tags?: string[];
  references?: string[];
  codeRefs?: string[];
  dependencies?: WorkId[];
  blockedBy?: WorkId[];
  content?: string;
  enrichmentRoles?: EnrichmentAssignment[];
  reviewers?: ReviewAssignment[];
  phaseHistory?: PhaseHistoryEntry[];
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  completedAt?: Timestamp;
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

/** Options for `advancePhase` (Tier 2.1) */
export interface SkipGuardOption {
  /** Required human-readable justification for bypassing the guard(s). */
  readonly reason: string;
}

/** Options for `advancePhase` (Tier 2.1) */
export interface AdvancePhaseOptions {
  /** Required when `targetPhase === "cancelled"`; recorded on the cancellation phase-history entry. */
  readonly reason?: string;
  /** Auditable escape hatch that bypasses guard failures (but NOT structural transition validity). */
  readonly skipGuard?: SkipGuardOption;
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
  advancePhase(
    id: WorkId,
    targetPhase: WorkPhase,
    options?: AdvancePhaseOptions,
  ): Promise<Result<WorkArticle, StateTransitionError | NotFoundError | StorageError>>;

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
