import type { Pool, RowDataPacket } from "mysql2/promise";
import { ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { StorageError } from "../core/errors.js";
import { WorkPhase } from "../core/types.js";
import type { AgentId, WorkPhase as WorkPhaseType, Priority } from "../core/types.js";
import type { WorkArticle, WorkArticleRepository } from "../work/repository.js";
import { executeQuery } from "./connection.js";
import {
  assembleWorkArticle,
  type WorkArticleRow,
  type EnrichmentRow,
  type ReviewRow,
  type PhaseHistoryRow,
} from "./dolt-work-helpers.js";

/**
 * Loads full WorkArticle objects for a set of IDs returned by a query.
 * Uses the parent repository's findById to assemble related data.
 */
async function loadArticlesByIds(
  rows: RowDataPacket[],
  findById: WorkArticleRepository["findById"],
): Promise<Result<WorkArticle[], StorageError>> {
  const articles: WorkArticle[] = [];
  for (const row of rows) {
    const articleResult = await findById((row as unknown as { id: string }).id);
    if (!articleResult.ok) return articleResult;
    articles.push(articleResult.value);
  }
  return ok(articles);
}

/**
 * Loads all work articles with their related data (enrichments, reviews, history).
 */
export async function queryAll(
  pool: Pool,
): Promise<Result<WorkArticle[], StorageError>> {
  const articleResult = await executeQuery(pool, "SELECT * FROM work_articles");
  if (!articleResult.ok) return articleResult;

  const articles = articleResult.value as WorkArticleRow[];
  const workArticles: WorkArticle[] = [];

  for (const row of articles) {
    const enrichmentResult = await executeQuery(
      pool,
      "SELECT * FROM enrichment_assignments WHERE work_id = ?",
      [row.id],
    );
    if (!enrichmentResult.ok) return enrichmentResult;

    const reviewResult = await executeQuery(
      pool,
      "SELECT * FROM review_assignments WHERE work_id = ?",
      [row.id],
    );
    if (!reviewResult.ok) return reviewResult;

    const historyResult = await executeQuery(
      pool,
      "SELECT * FROM phase_history WHERE work_id = ? ORDER BY entered_at ASC",
      [row.id],
    );
    if (!historyResult.ok) return historyResult;

    const enrichments = enrichmentResult.value as EnrichmentRow[];
    const reviews = reviewResult.value as ReviewRow[];
    const history = historyResult.value as PhaseHistoryRow[];

    workArticles.push(assembleWorkArticle(row, enrichments, reviews, history));
  }

  return ok(workArticles);
}

export async function queryByPhase(
  pool: Pool,
  phase: WorkPhaseType,
  findById: WorkArticleRepository["findById"],
): Promise<Result<WorkArticle[], StorageError>> {
  const result = await executeQuery(pool, "SELECT id FROM work_articles WHERE phase = ?", [phase]);
  if (!result.ok) return result;
  return loadArticlesByIds(result.value as RowDataPacket[], findById);
}

export async function queryByAssignee(
  pool: Pool,
  agentIdParam: AgentId,
  findById: WorkArticleRepository["findById"],
): Promise<Result<WorkArticle[], StorageError>> {
  const result = await executeQuery(pool, "SELECT id FROM work_articles WHERE assignee = ?", [agentIdParam]);
  if (!result.ok) return result;
  return loadArticlesByIds(result.value as RowDataPacket[], findById);
}

export async function queryByPriority(
  pool: Pool,
  priority: Priority,
  findById: WorkArticleRepository["findById"],
): Promise<Result<WorkArticle[], StorageError>> {
  const result = await executeQuery(pool, "SELECT id FROM work_articles WHERE priority = ?", [priority]);
  if (!result.ok) return result;
  return loadArticlesByIds(result.value as RowDataPacket[], findById);
}

export async function queryActive(
  pool: Pool,
  findById: WorkArticleRepository["findById"],
): Promise<Result<WorkArticle[], StorageError>> {
  const result = await executeQuery(
    pool,
    "SELECT id FROM work_articles WHERE phase != ? AND phase != ?",
    [WorkPhase.DONE, WorkPhase.CANCELLED],
  );
  if (!result.ok) return result;
  return loadArticlesByIds(result.value as RowDataPacket[], findById);
}

export async function queryBlocked(
  pool: Pool,
  findById: WorkArticleRepository["findById"],
): Promise<Result<WorkArticle[], StorageError>> {
  const result = await executeQuery(
    pool,
    "SELECT id FROM work_articles WHERE blocked_by != ?",
    [JSON.stringify([])],
  );
  if (!result.ok) return result;
  return loadArticlesByIds(result.value as RowDataPacket[], findById);
}
