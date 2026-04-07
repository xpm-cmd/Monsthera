import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { NotFoundError, ValidationError, StateTransitionError } from "../core/errors.js";
import type { StorageError, GuardFailedError } from "../core/errors.js";
import { generateWorkId, timestamp, WorkPhase } from "../core/types.js";
import type { WorkId, AgentId, WorkPhase as WorkPhaseType } from "../core/types.js";
import { WORK_TEMPLATES, generateInitialContent } from "./templates.js";
import { checkTransition } from "./lifecycle.js";
import type {
  WorkArticle,
  WorkArticleRepository,
  CreateWorkArticleInput,
  UpdateWorkArticleInput,
  EnrichmentAssignment,
  ReviewAssignment,
} from "./repository.js";

// ─── InMemoryWorkArticleRepository ───────────────────────────────────────────

const TERMINAL_PHASES = new Set<WorkPhaseType>([WorkPhase.DONE, WorkPhase.CANCELLED]);

export class InMemoryWorkArticleRepository implements WorkArticleRepository {
  private readonly store = new Map<string, WorkArticle>();

  /** Retrieve an article and reject if it's in a terminal phase. */
  private getMutable(id: string): Result<WorkArticle, NotFoundError | StateTransitionError> {
    const article = this.store.get(id);
    if (!article) return err(new NotFoundError("WorkArticle", id));
    if (TERMINAL_PHASES.has(article.phase)) {
      return err(new StateTransitionError(article.phase, "mutation", `Cannot modify article in terminal phase "${article.phase}"`));
    }
    return ok(article);
  }

  // ─── Base CRUD ──────────────────────────────────────────────────────────────

  async findById(id: string): Promise<Result<WorkArticle, NotFoundError | StorageError>> {
    const article = this.store.get(id);
    if (!article) return err(new NotFoundError("WorkArticle", id));
    return ok(article);
  }

  async findMany(_filter?: Record<string, unknown>): Promise<Result<WorkArticle[], StorageError>> {
    return ok([...this.store.values()]);
  }

  async create(input: CreateWorkArticleInput): Promise<Result<WorkArticle, ValidationError | StorageError>> {
    const id: WorkId = generateWorkId();
    const now = timestamp();
    const templateConfig = WORK_TEMPLATES[input.template];

    // Build initial enrichment assignments from template defaults
    const enrichmentRoles: EnrichmentAssignment[] = templateConfig.defaultEnrichmentRoles.map((role) => ({
      role,
      agentId: input.author,
      status: "pending" as const,
    }));

    const article: WorkArticle = {
      id,
      title: input.title,
      template: input.template,
      phase: WorkPhase.PLANNING,
      priority: input.priority,
      author: input.author,
      lead: input.lead,
      assignee: undefined,
      enrichmentRoles,
      reviewers: [],
      phaseHistory: [{ phase: WorkPhase.PLANNING, enteredAt: now }],
      tags: input.tags ?? [],
      references: [],
      codeRefs: [],
      dependencies: [],
      blockedBy: [],
      content: input.content ?? generateInitialContent(input.template),
      createdAt: now,
      updatedAt: now,
    };

    this.store.set(id, article);
    return ok(article);
  }

  async update(
    id: string,
    input: UpdateWorkArticleInput,
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const mutable = this.getMutable(id);
    if (!mutable.ok) return mutable;
    const existing = mutable.value;

    const updated: WorkArticle = {
      ...existing,
      title: input.title ?? existing.title,
      priority: input.priority ?? existing.priority,
      lead: input.lead !== undefined ? input.lead : existing.lead,
      assignee: input.assignee !== undefined ? input.assignee : existing.assignee,
      tags: input.tags ?? existing.tags,
      references: input.references ?? existing.references,
      codeRefs: input.codeRefs ?? existing.codeRefs,
      content: input.content ?? existing.content,
      updatedAt: timestamp(),
    };

    this.store.set(id, updated);
    return ok(updated);
  }

  async delete(id: string): Promise<Result<void, NotFoundError | StateTransitionError | StorageError>> {
    const mutable = this.getMutable(id);
    if (!mutable.ok) return mutable;
    this.store.delete(id);

    // Cascade: remove dangling blockedBy references in other articles
    for (const [otherId, article] of this.store) {
      if (article.blockedBy.some((dep) => dep === id)) {
        this.store.set(otherId, {
          ...article,
          blockedBy: article.blockedBy.filter((dep) => dep !== id),
        });
      }
    }

    return ok(undefined);
  }

  async exists(id: string): Promise<boolean> {
    return this.store.has(id);
  }

  // ─── Domain Queries ─────────────────────────────────────────────────────────

  async findByPhase(phase: WorkPhaseType): Promise<Result<WorkArticle[], StorageError>> {
    const results = [...this.store.values()].filter((a) => a.phase === phase);
    return ok(results);
  }

  async findByAssignee(agentId: AgentId): Promise<Result<WorkArticle[], StorageError>> {
    const results = [...this.store.values()].filter((a) => a.assignee === agentId);
    return ok(results);
  }

  async findByPriority(priority: string): Promise<Result<WorkArticle[], StorageError>> {
    const results = [...this.store.values()].filter((a) => a.priority === priority);
    return ok(results);
  }

  async findActive(): Promise<Result<WorkArticle[], StorageError>> {
    const results = [...this.store.values()].filter(
      (a) => a.phase !== WorkPhase.DONE && a.phase !== WorkPhase.CANCELLED,
    );
    return ok(results);
  }

  async findBlocked(): Promise<Result<WorkArticle[], StorageError>> {
    const results = [...this.store.values()].filter((a) => a.blockedBy.length > 0);
    return ok(results);
  }

  // ─── Phase Lifecycle ────────────────────────────────────────────────────────

  async advancePhase(
    id: WorkId,
    targetPhase: WorkPhaseType,
  ): Promise<Result<WorkArticle, StateTransitionError | GuardFailedError | NotFoundError | StorageError>> {
    const existing = this.store.get(id);
    if (!existing) return err(new NotFoundError("WorkArticle", id));

    // Delegate guard/transition validation to lifecycle
    const transitionResult = checkTransition(existing, targetPhase);
    if (!transitionResult.ok) return transitionResult;

    const now = timestamp();

    // Close current phase history entry
    const updatedHistory = existing.phaseHistory.map((entry, idx) =>
      idx === existing.phaseHistory.length - 1 && !entry.exitedAt
        ? { ...entry, exitedAt: now }
        : entry,
    );

    const updated: WorkArticle = {
      ...existing,
      phase: targetPhase,
      phaseHistory: [...updatedHistory, { phase: targetPhase, enteredAt: now }],
      updatedAt: now,
      completedAt: targetPhase === WorkPhase.DONE ? now : existing.completedAt,
    };

    this.store.set(id, updated);
    return ok(updated);
  }

  // ─── Enrichment & Review ───────────────────────────────────────────────────

  async contributeEnrichment(
    id: WorkId,
    role: string,
    status: "contributed" | "skipped",
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const mutable = this.getMutable(id);
    if (!mutable.ok) return mutable;
    const existing = mutable.value;

    if (existing.phase !== WorkPhase.ENRICHMENT) {
      return err(new StateTransitionError(existing.phase, "contributeEnrichment", `Enrichment contributions are only accepted during the enrichment phase`));
    }

    const idx = existing.enrichmentRoles.findIndex((r) => r.role === role);
    if (idx === -1) {
      return err(new ValidationError(`Enrichment role "${role}" not found on this article`));
    }

    const now = timestamp();
    const current = existing.enrichmentRoles[idx]!;
    const updatedRoles: EnrichmentAssignment[] = [...existing.enrichmentRoles];
    updatedRoles[idx] = { role: current.role, agentId: current.agentId, status, contributedAt: now };

    const updated: WorkArticle = { ...existing, enrichmentRoles: updatedRoles, updatedAt: now };
    this.store.set(id, updated);
    return ok(updated);
  }

  async assignReviewer(
    id: WorkId,
    reviewerAgentId: AgentId,
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const mutable = this.getMutable(id);
    if (!mutable.ok) return mutable;
    const existing = mutable.value;

    const alreadyAssigned = existing.reviewers.some((r) => r.agentId === reviewerAgentId);
    if (alreadyAssigned) {
      return err(new ValidationError(`Reviewer "${reviewerAgentId}" is already assigned`));
    }

    const reviewer: ReviewAssignment = { agentId: reviewerAgentId, status: "pending" };
    const updated: WorkArticle = {
      ...existing,
      reviewers: [...existing.reviewers, reviewer],
      updatedAt: timestamp(),
    };
    this.store.set(id, updated);
    return ok(updated);
  }

  async submitReview(
    id: WorkId,
    reviewerAgentId: AgentId,
    status: "approved" | "changes-requested",
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const mutable = this.getMutable(id);
    if (!mutable.ok) return mutable;
    const existing = mutable.value;

    if (existing.phase !== WorkPhase.REVIEW) {
      return err(new StateTransitionError(existing.phase, "submitReview", `Reviews are only accepted during the review phase`));
    }

    const idx = existing.reviewers.findIndex((r) => r.agentId === reviewerAgentId);
    if (idx === -1) {
      return err(new ValidationError(`Reviewer "${reviewerAgentId}" is not assigned to this article`));
    }

    const now = timestamp();
    const current = existing.reviewers[idx]!;
    const updatedReviewers: ReviewAssignment[] = [...existing.reviewers];
    updatedReviewers[idx] = { agentId: current.agentId, status, reviewedAt: now };

    const updated: WorkArticle = { ...existing, reviewers: updatedReviewers, updatedAt: now };
    this.store.set(id, updated);
    return ok(updated);
  }

  // ─── Dependencies ──────────────────────────────────────────────────────────

  async addDependency(
    id: WorkId,
    blockedById: WorkId,
  ): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>> {
    const mutable = this.getMutable(id);
    if (!mutable.ok) return mutable;
    const existing = mutable.value;

    // Verify the blocker article exists
    if (!this.store.has(blockedById)) {
      return err(new NotFoundError("WorkArticle", blockedById));
    }

    if (existing.blockedBy.includes(blockedById)) return ok(existing);

    const updated: WorkArticle = {
      ...existing,
      blockedBy: [...existing.blockedBy, blockedById],
      updatedAt: timestamp(),
    };
    this.store.set(id, updated);
    return ok(updated);
  }

  async removeDependency(
    id: WorkId,
    blockedById: WorkId,
  ): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>> {
    const mutable = this.getMutable(id);
    if (!mutable.ok) return mutable;
    const existing = mutable.value;

    const updated: WorkArticle = {
      ...existing,
      blockedBy: existing.blockedBy.filter((dep) => dep !== blockedById),
      updatedAt: timestamp(),
    };
    this.store.set(id, updated);
    return ok(updated);
  }
}
