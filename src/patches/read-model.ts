import { parseStringArrayJson } from "../core/input-hardening.js";
import * as queries from "../db/queries.js";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface PatchListPayload {
  count: number;
  patches: Array<{
    proposalId: string;
    state: string;
    message: string;
    baseCommit: string;
    agentId: string;
    createdAt: string;
    linkedTicketId: string | null;
  }>;
}

export interface PatchDetailPayload {
  proposalId: string;
  state: string;
  message: string;
  baseCommit: string;
  bundleId: string | null;
  agentId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  committedSha: string | null;
  linkedTicketId: string | null;
  touchedPaths: string[];
  dryRunResult: Record<string, unknown> | null;
}

export interface PatchSummaryPayload {
  totalCount: number;
  stateCounts: Record<string, number>;
  recent: PatchListPayload["patches"];
}

export function buildPatchListPayload(db: DB, repoId: number, state?: string): PatchListPayload {
  const patches = queries.getPatchesByRepo(db, repoId, state);
  return {
    count: patches.length,
    patches: patches.map((patch) => ({
      proposalId: patch.proposalId,
      state: patch.state,
      message: patch.message,
      baseCommit: patch.baseCommit,
      agentId: patch.agentId,
      createdAt: patch.createdAt,
      linkedTicketId: resolveLinkedTicketId(db, patch.ticketId),
    })),
  };
}

export function buildPatchDetailPayload(db: DB, repoId: number, proposalId: string): PatchDetailPayload | null {
  const patch = queries.getPatchByProposalId(db, proposalId);
  if (!patch || patch.repoId !== repoId) return null;

  return {
    proposalId: patch.proposalId,
    state: patch.state,
    message: patch.message,
    baseCommit: patch.baseCommit,
    bundleId: patch.bundleId,
    agentId: patch.agentId,
    sessionId: patch.sessionId,
    createdAt: patch.createdAt,
    updatedAt: patch.updatedAt,
    committedSha: patch.committedSha,
    linkedTicketId: resolveLinkedTicketId(db, patch.ticketId),
    touchedPaths: parseStringArrayJson(patch.touchedPathsJson, {
      maxItems: 100,
      maxItemLength: 500,
    }),
    dryRunResult: parseJsonRecord(patch.dryRunResultJson),
  };
}

export function buildPatchSummaryPayload(db: DB, repoId: number): PatchSummaryPayload {
  const all = queries.getPatchesByRepo(db, repoId);
  const stateCounts: Record<string, number> = {};
  for (const patch of all) {
    stateCounts[patch.state] = (stateCounts[patch.state] ?? 0) + 1;
  }

  return {
    totalCount: all.length,
    stateCounts,
    recent: buildPatchListPayload(db, repoId).patches.slice(0, 10),
  };
}

function resolveLinkedTicketId(db: DB, ticketInternalId: number | null): string | null {
  if (!ticketInternalId) return null;
  return queries.getTicketById(db, ticketInternalId)?.ticketId ?? `#${ticketInternalId}`;
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
