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
  globalDb: DB | null;
}

export function getOverview(deps: DashboardDeps) {
  const indexedCommit = getIndexedCommit(deps.db, deps.repoId);
  const fileCount = queries.getFileCount(deps.db, deps.repoId);
  const agents = queries.getAllAgents(deps.db);
  const activeSessions = queries.getActiveSessions(deps.db);
  const patches = queries.getPatchesByRepo(deps.db, deps.repoId);

  const totalTickets = queries.getTotalTicketCount(deps.db, deps.repoId);
  const openTickets = queries.getOpenTicketCount(deps.db, deps.repoId);

  return {
    version: VERSION,
    repoPath: deps.repoPath,
    indexedCommit: indexedCommit ?? null,
    fileCount,
    totalAgents: agents.length,
    activeSessions: activeSessions.length,
    totalPatches: patches.length,
    totalTickets,
    openTickets,
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

function classifyIndexedFile(language: string | null, path: string): string {
  if (language?.trim()) return language.trim();

  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!match) return "unknown";
  return `.${match[1]}`;
}

export function getIndexedFilesMetrics(deps: DashboardDeps) {
  const files = queries.getAllFiles(deps.db, deps.repoId);
  const counts = new Map<string, number>();

  for (const file of files) {
    const bucket = classifyIndexedFile(file.language, file.path);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  const byLanguage = [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    totalFiles: files.length,
    uniqueBuckets: byLanguage.length,
    unknownFiles: byLanguage.find((entry) => entry.label === "unknown")?.count ?? 0,
    topLanguages: byLanguage.slice(0, 6),
  };
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

export function getPresence(deps: DashboardDeps) {
  const agents = queries.getAllAgents(deps.db);
  const allSessions = queries.getAllSessions(deps.db);
  const now = Date.now();

  const TWO_MINUTES = 2 * 60 * 1000;
  const TEN_MINUTES = 10 * 60 * 1000;

  function computeStatus(lastActivity: string, state: string): "online" | "idle" | "offline" {
    if (state !== "active") return "offline";
    const age = now - new Date(lastActivity).getTime();
    if (age < TWO_MINUTES) return "online";
    if (age < TEN_MINUTES) return "idle";
    return "offline";
  }

  return agents.map((a) => {
    const sessions = allSessions
      .filter((s) => s.agentId === a.id)
      .map((s) => ({
        id: s.id,
        state: s.state,
        connectedAt: s.connectedAt,
        lastActivity: s.lastActivity,
        status: computeStatus(s.lastActivity, s.state),
        claimedFiles: s.claimedFilesJson ? JSON.parse(s.claimedFilesJson) as string[] : [],
      }));

    const bestStatus = sessions.some((s) => s.status === "online")
      ? "online"
      : sessions.some((s) => s.status === "idle")
        ? "idle"
        : "offline";

    return {
      id: a.id,
      name: a.name,
      type: a.type,
      role: a.roleId,
      trustTier: a.trustTier,
      status: bestStatus,
      sessions,
    };
  });
}

export function getTicketsList(deps: DashboardDeps) {
  return queries.getTicketsByRepo(deps.db, deps.repoId).map((t) => ({
    ticketId: t.ticketId,
    title: t.title,
    status: t.status,
    severity: t.severity,
    priority: t.priority,
    assignee: t.assigneeAgentId ?? null,
    creator: t.creatorAgentId,
    updatedAt: t.updatedAt,
  }));
}

export function getTicketDetail(deps: DashboardDeps, ticketId: string) {
  const ticket = queries.getTicketByTicketId(deps.db, ticketId);
  if (!ticket || ticket.repoId !== deps.repoId) return null;

  const comments = queries.getTicketComments(deps.db, ticket.id);
  const history = queries.getTicketHistory(deps.db, ticket.id);
  const linkedPatches = queries.getPatchesByTicketId(deps.db, ticket.id);

  return {
    ticketId: ticket.ticketId,
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    severity: ticket.severity,
    priority: ticket.priority,
    tags: ticket.tagsJson ? JSON.parse(ticket.tagsJson) : [],
    affectedPaths: ticket.affectedPathsJson ? JSON.parse(ticket.affectedPathsJson) : [],
    acceptanceCriteria: ticket.acceptanceCriteria,
    creatorAgentId: ticket.creatorAgentId,
    assigneeAgentId: ticket.assigneeAgentId,
    resolvedByAgentId: ticket.resolvedByAgentId,
    commitSha: ticket.commitSha,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    comments: comments.map((comment) => ({
      agentId: comment.agentId,
      agentName: queries.getAgent(deps.db, comment.agentId)?.name ?? null,
      agentType: queries.getAgent(deps.db, comment.agentId)?.type ?? null,
      content: comment.content,
      createdAt: comment.createdAt,
    })),
    history: history.map((entry) => ({
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      agentId: entry.agentId,
      comment: entry.comment,
      timestamp: entry.timestamp,
    })),
    linkedPatches: linkedPatches.map((patch) => ({
      proposalId: patch.proposalId,
      state: patch.state,
      message: patch.message,
      agentId: patch.agentId,
      createdAt: patch.createdAt,
    })),
  };
}

export function getKnowledgeList(deps: DashboardDeps) {
  const repoEntries = queries.queryKnowledge(deps.db, {}).map((e) => ({
    ...e, scope: "repo" as string,
  }));

  let globalEntries: typeof repoEntries = [];
  if (deps.globalDb) {
    globalEntries = queries.queryKnowledge(deps.globalDb, {}).map((e) => ({
      ...e, scope: "global" as string,
    }));
  }

  return [...repoEntries, ...globalEntries]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((k) => ({
      key: k.key,
      type: k.type,
      scope: k.scope,
      title: k.title,
      contentPreview: k.content.slice(0, 200),
      tags: k.tagsJson ? JSON.parse(k.tagsJson) : [],
      status: k.status,
      agentId: k.agentId,
      updatedAt: k.updatedAt,
    }));
}
