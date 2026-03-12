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
    persistedStale: boolean;
    message: string;
    baseCommit: string;
    agentId: string;
    createdAt: string;
    linkedTicketId: string | null;
    touchedPathCount: number;
    validation: PatchValidationSummary;
  }>;
}

export interface PatchDetailPayload {
  proposalId: string;
  state: string;
  persistedStale: boolean;
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
  validation: PatchValidationDetail;
}

export interface PatchSummaryPayload {
  totalCount: number;
  stateCounts: Record<string, number>;
  validationCounts: {
    feasible: number;
    blocked: number;
    unknown: number;
    persistedStale: number;
    withPolicyViolations: number;
    withSecretWarnings: number;
  };
  recent: PatchListPayload["patches"];
}

export interface PatchValidationSummary {
  feasible: boolean | null;
  policyViolationCount: number;
  secretWarningCount: number;
  reindexScope: number | null;
}

export interface PatchValidationDetail extends PatchValidationSummary {
  policyViolations: string[];
  secretWarnings: string[];
}

export function buildPatchListPayload(db: DB, repoId: number, state?: string): PatchListPayload {
  const patches = queries.getPatchesByRepo(db, repoId, state);
  return {
    count: patches.length,
    patches: patches.map((patch) => {
      const touchedPaths = parseTouchedPaths(patch.touchedPathsJson);
      const dryRunResult = parseJsonRecord(patch.dryRunResultJson);
      return {
        proposalId: patch.proposalId,
        state: patch.state,
        persistedStale: patch.state === "stale",
        message: patch.message,
        baseCommit: patch.baseCommit,
        agentId: patch.agentId,
        createdAt: patch.createdAt,
        linkedTicketId: resolveLinkedTicketId(db, patch.ticketId),
        touchedPathCount: touchedPaths.length,
        validation: buildPatchValidationDetail(dryRunResult, touchedPaths),
      };
    }),
  };
}

export function buildPatchDetailPayload(db: DB, repoId: number, proposalId: string): PatchDetailPayload | null {
  const patch = queries.getPatchByProposalId(db, proposalId);
  if (!patch || patch.repoId !== repoId) return null;

  const touchedPaths = parseTouchedPaths(patch.touchedPathsJson);
  const dryRunResult = parseJsonRecord(patch.dryRunResultJson);

  return {
    proposalId: patch.proposalId,
    state: patch.state,
    persistedStale: patch.state === "stale",
    message: patch.message,
    baseCommit: patch.baseCommit,
    bundleId: patch.bundleId,
    agentId: patch.agentId,
    sessionId: patch.sessionId,
    createdAt: patch.createdAt,
    updatedAt: patch.updatedAt,
    committedSha: patch.committedSha,
    linkedTicketId: resolveLinkedTicketId(db, patch.ticketId),
    touchedPaths,
    dryRunResult,
    validation: buildPatchValidationDetail(dryRunResult, touchedPaths),
  };
}

export function buildPatchSummaryPayload(db: DB, repoId: number): PatchSummaryPayload {
  const all = queries.getPatchesByRepo(db, repoId);
  const stateCounts: Record<string, number> = {};
  const validationCounts = {
    feasible: 0,
    blocked: 0,
    unknown: 0,
    persistedStale: 0,
    withPolicyViolations: 0,
    withSecretWarnings: 0,
  };
  for (const patch of all) {
    stateCounts[patch.state] = (stateCounts[patch.state] ?? 0) + 1;
    if (patch.state === "stale") {
      validationCounts.persistedStale += 1;
    }
    const summary = buildPatchValidationDetail(
      parseJsonRecord(patch.dryRunResultJson),
      parseTouchedPaths(patch.touchedPathsJson),
    );
    if (summary.feasible === true) {
      validationCounts.feasible += 1;
    } else if (summary.feasible === false) {
      validationCounts.blocked += 1;
    } else {
      validationCounts.unknown += 1;
    }
    if (summary.policyViolationCount > 0) {
      validationCounts.withPolicyViolations += 1;
    }
    if (summary.secretWarningCount > 0) {
      validationCounts.withSecretWarnings += 1;
    }
  }

  return {
    totalCount: all.length,
    stateCounts,
    validationCounts,
    recent: buildPatchListPayload(db, repoId).patches.slice(0, 10),
  };
}

function resolveLinkedTicketId(db: DB, ticketInternalId: number | null): string | null {
  if (!ticketInternalId) return null;
  return queries.getTicketById(db, ticketInternalId)?.ticketId ?? `#${ticketInternalId}`;
}

function parseTouchedPaths(raw: string | null): string[] {
  return parseStringArrayJson(raw, {
    maxItems: 100,
    maxItemLength: 500,
  });
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

function buildPatchValidationDetail(
  dryRunResult: Record<string, unknown> | null,
  touchedPaths: string[],
): PatchValidationDetail {
  const policyViolations = getStringListField(dryRunResult, "policyViolations");
  const secretWarnings = getStringListField(dryRunResult, "secretWarnings");

  return {
    feasible: typeof dryRunResult?.feasible === "boolean" ? dryRunResult.feasible : null,
    policyViolationCount: policyViolations.length,
    secretWarningCount: secretWarnings.length,
    reindexScope: typeof dryRunResult?.reindexScope === "number" ? dryRunResult.reindexScope : touchedPaths.length || null,
    policyViolations,
    secretWarnings,
  };
}

function getStringListField(record: Record<string, unknown> | null, field: string): string[] {
  const value = record?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
