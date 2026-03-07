import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import { getIndexedCommit } from "../indexing/indexer.js";
import { VERSION } from "../core/constants.js";
import type { CoordinationBus } from "../coordination/bus.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface DashboardDeps {
  db: DB;
  repoId: number;
  repoPath: string;
  bus: CoordinationBus;
}

export function getOverview(deps: DashboardDeps) {
  const indexedCommit = getIndexedCommit(deps.db, deps.repoId);
  const fileCount = queries.getFileCount(deps.db, deps.repoId);
  const agents = queries.getAllAgents(deps.db);
  const activeSessions = queries.getActiveSessions(deps.db);
  const patches = queries.getPatchesByRepo(deps.db, deps.repoId);

  return {
    version: VERSION,
    repoPath: deps.repoPath,
    indexedCommit: indexedCommit ?? null,
    fileCount,
    totalAgents: agents.length,
    activeSessions: activeSessions.length,
    totalPatches: patches.length,
    coordinationTopology: deps.bus.getTopology(),
  };
}

export function getAgentsList(deps: DashboardDeps) {
  const agents = queries.getAllAgents(deps.db);
  const activeSessions = queries.getActiveSessions(deps.db);

  return agents.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    role: a.roleId,
    trustTier: a.trustTier,
    registeredAt: a.registeredAt,
    activeSessions: activeSessions.filter((s) => s.agentId === a.id).length,
  }));
}

export function getEventLogsList(deps: DashboardDeps, limit = 50) {
  return queries.getEventLogs(deps.db, limit).map((e) => ({
    eventId: e.eventId,
    agentId: e.agentId,
    tool: e.tool,
    status: e.status,
    timestamp: e.timestamp,
    durationMs: e.durationMs,
    payloadSizeIn: e.payloadSizeIn,
    payloadSizeOut: e.payloadSizeOut,
    redactedSummary: e.redactedSummary,
  }));
}

export function getPatchesList(deps: DashboardDeps) {
  return queries.getPatchesByRepo(deps.db, deps.repoId).map((p) => ({
    proposalId: p.proposalId,
    state: p.state,
    message: p.message,
    baseCommit: p.baseCommit,
    agentId: p.agentId,
    createdAt: p.createdAt,
  }));
}

export function getNotesList(deps: DashboardDeps) {
  return queries.getNotesByRepo(deps.db, deps.repoId).map((n) => ({
    key: n.key,
    type: n.type,
    contentPreview: n.content.slice(0, 200),
    agentId: n.agentId,
    commitSha: n.commitSha,
    updatedAt: n.updatedAt,
  }));
}
