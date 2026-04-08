import type { RowDataPacket } from "mysql2/promise";
import {
  workId,
  agentId,
  timestamp,
  type WorkPhase,
} from "../core/types.js";
import type {
  WorkArticle,
  EnrichmentAssignment,
  ReviewAssignment,
  PhaseHistoryEntry,
} from "../work/repository.js";

/** Row from work_articles table */
export interface WorkArticleRow extends RowDataPacket {
  id: string;
  title: string;
  template: string;
  phase: string;
  priority: string;
  author: string;
  lead?: string | null;
  assignee?: string | null;
  tags: string;
  references: string;
  code_refs: string;
  dependencies: string;
  blocked_by: string;
  content: string;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

/** Row from enrichment_assignments table */
export interface EnrichmentRow extends RowDataPacket {
  work_id: string;
  role: string;
  agent_id: string;
  status: "pending" | "contributed" | "skipped";
  contributed_at?: string | null;
}

/** Row from review_assignments table */
export interface ReviewRow extends RowDataPacket {
  work_id: string;
  agent_id: string;
  status: "pending" | "approved" | "changes-requested";
  reviewed_at?: string | null;
}

/** Row from phase_history table */
export interface PhaseHistoryRow extends RowDataPacket {
  work_id: string;
  phase: string;
  entered_at: string;
  exited_at?: string | null;
}

/**
 * Assemble a WorkArticle from database rows.
 * Combines data from work_articles, enrichment_assignments, review_assignments, and phase_history.
 */
export function assembleWorkArticle(
  row: WorkArticleRow,
  enrichments: EnrichmentRow[],
  reviews: ReviewRow[],
  history: PhaseHistoryRow[],
): WorkArticle {
  const enrichmentRoles: EnrichmentAssignment[] = enrichments.map((e) => ({
    role: e.role,
    agentId: agentId(e.agent_id),
    status: e.status,
    contributedAt: e.contributed_at ? timestamp(e.contributed_at) : undefined,
  }));

  const reviewers: ReviewAssignment[] = reviews.map((r) => ({
    agentId: agentId(r.agent_id),
    status: r.status,
    reviewedAt: r.reviewed_at ? timestamp(r.reviewed_at) : undefined,
  }));

  const phaseHistory: PhaseHistoryEntry[] = history.map((h) => ({
    phase: h.phase as WorkPhase,
    enteredAt: timestamp(h.entered_at),
    exitedAt: h.exited_at ? timestamp(h.exited_at) : undefined,
  }));

  const tags = JSON.parse(row.tags ?? "[]") as string[];
  const references = JSON.parse(row.references ?? "[]") as string[];
  const codeRefs = JSON.parse(row.code_refs ?? "[]") as string[];
  const blockedByRaw = JSON.parse(row.blocked_by ?? "[]") as unknown[];
  const blockedBy = blockedByRaw.map((id) => workId(String(id)));

  const article: WorkArticle = {
    id: workId(row.id),
    title: row.title,
    template: row.template as never,
    phase: row.phase as WorkPhase,
    priority: row.priority as never,
    author: agentId(row.author),
    lead: row.lead ? agentId(row.lead) : undefined,
    assignee: row.assignee ? agentId(row.assignee) : undefined,
    enrichmentRoles,
    reviewers,
    phaseHistory,
    tags,
    references,
    codeRefs,
    dependencies: [],
    blockedBy,
    content: row.content,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    completedAt: row.completed_at ? timestamp(row.completed_at) : undefined,
  };

  return article;
}
