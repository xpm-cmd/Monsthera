import type { Pool } from "mysql2/promise";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import type {
  StorageError,
} from "../core/errors.js";
import {
  NotFoundError,
  ValidationError,
  StateTransitionError,
} from "../core/errors.js";
import { WorkPhase, generateWorkId, timestamp } from "../core/types.js";
import type { WorkId, AgentId, WorkPhase as WorkPhaseType, Priority } from "../core/types.js";
import { checkTransition } from "../work/lifecycle.js";
import { WORK_TEMPLATES } from "../work/templates.js";
import type {
  WorkArticle,
  WorkArticleRepository,
  CreateWorkArticleInput,
  UpdateWorkArticleInput,
} from "../work/repository.js";
import { executeQuery, executeMutation, executeTransaction } from "./connection.js";
import {
  assembleWorkArticle,
  type WorkArticleRow,
  type EnrichmentRow,
  type ReviewRow,
  type PhaseHistoryRow,
} from "./dolt-work-helpers.js";
import {
  queryAll,
  queryByPhase,
  queryByAssignee,
  queryByPriority,
  queryActive,
  queryBlocked,
} from "./dolt-work-queries.js";

const TERMINAL_PHASES = new Set<WorkPhaseType>([WorkPhase.DONE, WorkPhase.CANCELLED]);

export class DoltWorkRepository implements WorkArticleRepository {
  constructor(private readonly pool: Pool) {}

  private getMutable(id: string): Promise<Result<WorkArticle, NotFoundError | StateTransitionError>> {
    return this.findById(id).then((result) => {
      if (!result.ok) return result;
      const article = result.value;
      if (TERMINAL_PHASES.has(article.phase)) {
        return err(
          new StateTransitionError(
            article.phase,
            "mutation",
            `Cannot modify article in terminal phase "${article.phase}"`,
          ),
        );
      }
      return ok(article);
    });
  }

  async findById(id: string): Promise<Result<WorkArticle, NotFoundError | StorageError>> {
    const articleResult = await executeQuery(
      this.pool,
      "SELECT * FROM work_articles WHERE id = ?",
      [id],
    );

    if (!articleResult.ok) return articleResult;

    const rows = articleResult.value as WorkArticleRow[];
    if (rows.length === 0) {
      return err(new NotFoundError("WorkArticle", id));
    }

    const articleRow = rows[0]!;

    const enrichmentResult = await executeQuery(
      this.pool,
      "SELECT * FROM enrichment_assignments WHERE work_id = ?",
      [id],
    );
    if (!enrichmentResult.ok) return enrichmentResult;

    const reviewResult = await executeQuery(
      this.pool,
      "SELECT * FROM review_assignments WHERE work_id = ?",
      [id],
    );
    if (!reviewResult.ok) return reviewResult;

    const historyResult = await executeQuery(
      this.pool,
      "SELECT * FROM phase_history WHERE work_id = ? ORDER BY entered_at ASC",
      [id],
    );
    if (!historyResult.ok) return historyResult;

    const enrichments = enrichmentResult.value as EnrichmentRow[];
    const reviews = reviewResult.value as ReviewRow[];
    const history = historyResult.value as PhaseHistoryRow[];

    return ok(assembleWorkArticle(articleRow, enrichments, reviews, history));
  }

  async findMany(_filter?: Record<string, unknown>): Promise<Result<WorkArticle[], StorageError>> {
    return queryAll(this.pool);
  }

  async create(
    input: CreateWorkArticleInput,
  ): Promise<Result<WorkArticle, ValidationError | StorageError>> {
    const id = generateWorkId();
    const now = timestamp();
    const templateConfig = WORK_TEMPLATES[input.template];

    const transactionResult = await executeTransaction(this.pool, async (connection) => {
      // INSERT into work_articles
      const insertArticleSql = `
        INSERT INTO work_articles
        (id, title, template, phase, priority, author, lead, assignee, tags, references, code_refs, dependencies, blocked_by, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const [articleResult] = await connection.execute(insertArticleSql, [
        id,
        input.title,
        input.template,
        WorkPhase.PLANNING,
        input.priority,
        input.author,
        input.lead ?? null,
        null,
        JSON.stringify(input.tags ?? []),
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([]),
        input.content ?? "",
        now,
        now,
      ]);

      // INSERT enrichment_assignments from template defaults
      const insertEnrichmentSql = `
        INSERT INTO enrichment_assignments
        (work_id, role, agent_id, status, contributed_at)
        VALUES (?, ?, ?, ?, ?)
      `;

      for (const role of templateConfig.defaultEnrichmentRoles) {
        await connection.execute(insertEnrichmentSql, [id, role, input.author, "pending", null]);
      }

      // INSERT initial phase_history entry
      const insertHistorySql = `
        INSERT INTO phase_history
        (work_id, phase, entered_at, exited_at)
        VALUES (?, ?, ?, ?)
      `;

      await connection.execute(insertHistorySql, [id, WorkPhase.PLANNING, now, null]);

      return { articleResult };
    });

    if (!transactionResult.ok) return transactionResult;

    // Fetch and return the created article
    return this.findById(id);
  }

  async update(
    id: string,
    input: UpdateWorkArticleInput,
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const mutable = await this.getMutable(id);
    if (!mutable.ok) return mutable;

    const existing = mutable.value;
    const now = timestamp();

    const updateSql = `
      UPDATE work_articles
      SET
        title = ?,
        priority = ?,
        lead = ?,
        assignee = ?,
        tags = ?,
        references = ?,
        code_refs = ?,
        content = ?,
        updated_at = ?
      WHERE id = ?
    `;

    const updateResult = await executeMutation(this.pool, updateSql, [
      input.title ?? existing.title,
      input.priority ?? existing.priority,
      input.lead !== undefined ? input.lead : existing.lead,
      input.assignee !== undefined ? input.assignee : existing.assignee,
      JSON.stringify(input.tags ?? existing.tags),
      JSON.stringify(input.references ?? existing.references),
      JSON.stringify(input.codeRefs ?? existing.codeRefs),
      input.content ?? existing.content,
      now,
      id,
    ]);

    if (!updateResult.ok) return updateResult;

    return this.findById(id);
  }

  async delete(
    id: string,
  ): Promise<Result<void, NotFoundError | StateTransitionError | StorageError>> {
    const mutable = await this.getMutable(id);
    if (!mutable.ok) return mutable;

    const transactionResult = await executeTransaction(this.pool, async (connection) => {
      // Delete enrichment_assignments
      await connection.execute("DELETE FROM enrichment_assignments WHERE work_id = ?", [id]);

      // Delete review_assignments
      await connection.execute("DELETE FROM review_assignments WHERE work_id = ?", [id]);

      // Delete phase_history
      await connection.execute("DELETE FROM phase_history WHERE work_id = ?", [id]);

      // Delete work_articles
      await connection.execute("DELETE FROM work_articles WHERE id = ?", [id]);

      // Cascade: remove dangling blockedBy references in other articles
      const articlesResult = await connection.execute(
        "SELECT id, blocked_by FROM work_articles WHERE blocked_by LIKE ?",
        [`%"${id}"%`],
      );
      const [articles] = articlesResult;

      for (const row of articles as unknown[]) {
        const dbRow = row as { id: string; blocked_by: string };
        const blockedBy = JSON.parse(dbRow.blocked_by) as string[];
        const filtered = blockedBy.filter((dep) => dep !== id);

        await connection.execute("UPDATE work_articles SET blocked_by = ? WHERE id = ?", [
          JSON.stringify(filtered),
          dbRow.id,
        ]);
      }

      return undefined;
    });

    if (!transactionResult.ok) return transactionResult;
    return ok(undefined);
  }

  async exists(id: string): Promise<boolean> {
    const result = await executeQuery(this.pool, "SELECT 1 FROM work_articles WHERE id = ?", [id]);

    if (!result.ok) return false;
    return result.value.length > 0;
  }

  async findByPhase(phase: WorkPhaseType): Promise<Result<WorkArticle[], StorageError>> {
    return queryByPhase(this.pool, phase, this.findById.bind(this));
  }

  async findByAssignee(agentIdParam: AgentId): Promise<Result<WorkArticle[], StorageError>> {
    return queryByAssignee(this.pool, agentIdParam, this.findById.bind(this));
  }

  async findByPriority(priority: Priority): Promise<Result<WorkArticle[], StorageError>> {
    return queryByPriority(this.pool, priority, this.findById.bind(this));
  }

  async findActive(): Promise<Result<WorkArticle[], StorageError>> {
    return queryActive(this.pool, this.findById.bind(this));
  }

  async findBlocked(): Promise<Result<WorkArticle[], StorageError>> {
    return queryBlocked(this.pool, this.findById.bind(this));
  }

  async advancePhase(
    id: WorkId,
    targetPhase: WorkPhaseType,
  ): Promise<Result<WorkArticle, StateTransitionError | NotFoundError | StorageError>> {
    const existing = await this.findById(id);
    if (!existing.ok) return existing;

    const article = existing.value;
    const transitionResult = checkTransition(article, targetPhase);
    if (!transitionResult.ok) return transitionResult;

    const now = timestamp();

    const transactionResult = await executeTransaction(this.pool, async (connection) => {
      // Close current phase history entry
      await connection.execute(
        "UPDATE phase_history SET exited_at = ? WHERE work_id = ? AND exited_at IS NULL",
        [now, id],
      );

      // Insert new phase history entry
      await connection.execute(
        "INSERT INTO phase_history (work_id, phase, entered_at, exited_at) VALUES (?, ?, ?, ?)",
        [id, targetPhase, now, null],
      );

      // Update article phase and completedAt
      const completedAt = targetPhase === WorkPhase.DONE ? now : null;
      await connection.execute(
        "UPDATE work_articles SET phase = ?, updated_at = ?, completed_at = ? WHERE id = ?",
        [targetPhase, now, completedAt, id],
      );
    });

    if (!transactionResult.ok) return transactionResult;

    return this.findById(id);
  }

  async contributeEnrichment(
    id: WorkId,
    role: string,
    status: "contributed" | "skipped",
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const mutable = await this.getMutable(id);
    if (!mutable.ok) return mutable;

    const existing = mutable.value;

    if (existing.phase !== WorkPhase.ENRICHMENT) {
      return err(
        new StateTransitionError(
          existing.phase,
          "contributeEnrichment",
          "Enrichment contributions are only accepted during the enrichment phase",
        ),
      );
    }

    const roleExists = existing.enrichmentRoles.some((r) => r.role === role);
    if (!roleExists) {
      return err(new ValidationError(`Enrichment role "${role}" not found on this article`));
    }

    const now = timestamp();
    const updateSql = `
      UPDATE enrichment_assignments
      SET status = ?, contributed_at = ?
      WHERE work_id = ? AND role = ?
    `;

    const updateResult = await executeMutation(this.pool, updateSql, [status, now, id, role]);

    if (!updateResult.ok) return updateResult;

    return this.findById(id);
  }

  async assignReviewer(
    id: WorkId,
    agentId: AgentId,
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const mutable = await this.getMutable(id);
    if (!mutable.ok) return mutable;

    const existing = mutable.value;

    const alreadyAssigned = existing.reviewers.some((r) => r.agentId === agentId);
    if (alreadyAssigned) {
      return err(new ValidationError(`Reviewer "${agentId}" is already assigned`));
    }

    const insertSql = `
      INSERT INTO review_assignments (work_id, agent_id, status, reviewed_at)
      VALUES (?, ?, ?, ?)
    `;

    const insertResult = await executeMutation(this.pool, insertSql, [id, agentId, "pending", null]);

    if (!insertResult.ok) return insertResult;

    return this.findById(id);
  }

  async submitReview(
    id: WorkId,
    agentId: AgentId,
    status: "approved" | "changes-requested",
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const mutable = await this.getMutable(id);
    if (!mutable.ok) return mutable;

    const existing = mutable.value;

    if (existing.phase !== WorkPhase.REVIEW) {
      return err(
        new StateTransitionError(
          existing.phase,
          "submitReview",
          "Reviews are only accepted during the review phase",
        ),
      );
    }

    const reviewerExists = existing.reviewers.some((r) => r.agentId === agentId);
    if (!reviewerExists) {
      return err(new ValidationError(`Reviewer "${agentId}" is not assigned to this article`));
    }

    const now = timestamp();
    const updateSql = `
      UPDATE review_assignments
      SET status = ?, reviewed_at = ?
      WHERE work_id = ? AND agent_id = ?
    `;

    const updateResult = await executeMutation(this.pool, updateSql, [status, now, id, agentId]);

    if (!updateResult.ok) return updateResult;

    return this.findById(id);
  }

  async addDependency(
    id: WorkId,
    blockedById: WorkId,
  ): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>> {
    const mutable = await this.getMutable(id);
    if (!mutable.ok) return mutable;

    const existing = mutable.value;

    const blockerExists = await this.exists(blockedById);
    if (!blockerExists) {
      return err(new NotFoundError("WorkArticle", blockedById));
    }

    if (existing.blockedBy.includes(blockedById)) {
      return ok(existing);
    }

    const updatedBlockedBy = [...existing.blockedBy, blockedById];
    const updateSql = `
      UPDATE work_articles
      SET blocked_by = ?, updated_at = ?
      WHERE id = ?
    `;

    const updateResult = await executeMutation(
      this.pool,
      updateSql,
      [JSON.stringify(updatedBlockedBy), timestamp(), id],
    );

    if (!updateResult.ok) return updateResult;

    return this.findById(id);
  }

  async removeDependency(
    id: WorkId,
    blockedById: WorkId,
  ): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>> {
    const mutable = await this.getMutable(id);
    if (!mutable.ok) return mutable;

    const existing = mutable.value;

    const updatedBlockedBy = existing.blockedBy.filter((dep) => dep !== blockedById);
    const updateSql = `
      UPDATE work_articles
      SET blocked_by = ?, updated_at = ?
      WHERE id = ?
    `;

    const updateResult = await executeMutation(
      this.pool,
      updateSql,
      [JSON.stringify(updatedBlockedBy), timestamp(), id],
    );

    if (!updateResult.ok) return updateResult;

    return this.findById(id);
  }
}
