import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import { getIndexedCommit } from "../indexing/indexer.js";
import { VERSION } from "../core/constants.js";
import type { CoordinationBus } from "../coordination/bus.js";
import { HEARTBEAT_TIMEOUT_MS } from "../core/constants.js";
import { loadTicketTemplates, type TicketTemplate } from "../tickets/templates.js";
import type { CodeSearchDebugResult } from "../search/debug.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface DashboardSearchDebugProvider {
  searchCode: (params: { query: string; scope?: string; limit?: number }) => Promise<CodeSearchDebugResult>;
}

export interface DashboardDeps {
  db: DB;
  repoId: number;
  repoPath: string;
  mainRepoPath?: string;
  bus: CoordinationBus;
  globalDb: DB | null;
  refreshTicketSearch?: () => void;
  searchDebug?: DashboardSearchDebugProvider;
}

export function getOverview(deps: DashboardDeps) {
  const indexedCommit = getIndexedCommit(deps.db, deps.repoId);
  const fileCount = queries.getFileCount(deps.db, deps.repoId);
  const agents = queries.getAllAgents(deps.db);
  const activeSessions = queries.getLiveSessions(
    deps.db,
    new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString(),
  );
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
  const activeSessions = queries.getLiveSessions(
    deps.db,
    new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString(),
  );

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

export function getAgentTimeline(deps: DashboardDeps, limitPerAgent = 8) {
  const agents = queries.getAllAgents(deps.db);
  const liveCutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
  const liveSessions = queries.getLiveSessions(deps.db, liveCutoff);

  return agents
    .map((agent) => {
      const events = queries.getEventLogsByAgent(deps.db, agent.id, limitPerAgent).map((event) => ({
        eventId: event.eventId,
        sessionId: event.sessionId,
        tool: event.tool,
        status: event.status,
        timestamp: event.timestamp,
        durationMs: event.durationMs,
        redactedSummary: event.redactedSummary,
        errorCode: event.errorCode,
        errorDetail: event.errorDetail ?? event.denialReason ?? null,
      }));

      const activeSessionCount = liveSessions.filter((session) => session.agentId === agent.id).length;
      const lastEventAt = events[0]?.timestamp ?? null;

      return {
        agentId: agent.id,
        name: agent.name,
        type: agent.type,
        role: agent.roleId,
        trustTier: agent.trustTier,
        activeSessions: activeSessionCount,
        totalEvents: events.length,
        lastEventAt,
        events,
      };
    })
    .filter((agent) => agent.totalEvents > 0 || agent.activeSessions > 0)
    .sort((a, b) => {
      const aTime = a.lastEventAt ?? "";
      const bTime = b.lastEventAt ?? "";
      return bTime.localeCompare(aTime) || b.activeSessions - a.activeSessions || a.name.localeCompare(b.name);
    });
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
    errorCode: e.errorCode,
    errorDetail: e.errorDetail ?? e.denialReason ?? null,
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
  const secretPatternCounts = new Map<string, number>();
  const secretFiles = files.filter((file) => file.hasSecrets);

  for (const file of files) {
    const bucket = classifyIndexedFile(file.language, file.path);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);

    if (file.secretLineRanges) {
      try {
        const hits = JSON.parse(file.secretLineRanges) as Array<{ pattern?: string }>;
        for (const hit of hits) {
          if (!hit?.pattern) continue;
          secretPatternCounts.set(hit.pattern, (secretPatternCounts.get(hit.pattern) ?? 0) + 1);
        }
      } catch {
        // Ignore malformed legacy blobs in dashboard metrics.
      }
    }
  }

  const byLanguage = [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const topSecretPatterns = [...secretPatternCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 4);

  return {
    totalFiles: files.length,
    uniqueBuckets: byLanguage.length,
    unknownFiles: byLanguage.find((entry) => entry.label === "unknown")?.count ?? 0,
    secretFiles: secretFiles.length,
    topSecretPatterns,
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
  const THIRTY_MINUTES = 30 * 60 * 1000;

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

    const newestActivityMs = sessions.reduce((latest, session) => {
      const activityMs = new Date(session.lastActivity).getTime();
      return Number.isNaN(activityMs) ? latest : Math.max(latest, activityMs);
    }, 0);

    return {
      id: a.id,
      name: a.name,
      type: a.type,
      role: a.roleId,
      trustTier: a.trustTier,
      status: bestStatus,
      sessions,
      newestActivityMs,
    };
  }).filter((agent) => {
    if (agent.newestActivityMs === 0) return false;
    return now - agent.newestActivityMs <= THIRTY_MINUTES;
  }).map(({ newestActivityMs: _newestActivityMs, ...agent }) => agent);
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
  const ticketDeps = queries.getTicketDependencies(deps.db, ticket.id);

  const resolvePublicId = (internalId: number) => {
    const t = queries.getTicketById(deps.db, internalId);
    return t?.ticketId ?? `#${internalId}`;
  };

  const blocking = ticketDeps.outgoing
    .filter((d) => d.relationType === "blocks")
    .map((d) => resolvePublicId(d.toTicketId));
  const blockedBy = ticketDeps.incoming
    .filter((d) => d.relationType === "blocks")
    .map((d) => resolvePublicId(d.fromTicketId));
  const relatedTo = [
    ...ticketDeps.outgoing.filter((d) => d.relationType === "relates_to").map((d) => resolvePublicId(d.toTicketId)),
    ...ticketDeps.incoming.filter((d) => d.relationType === "relates_to").map((d) => resolvePublicId(d.fromTicketId)),
  ];

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
    dependencies: { blocking, blockedBy, relatedTo },
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

export function getTicketMetrics(deps: DashboardDeps) {
  const now = Date.now();
  const statusCounts = queries.getTicketCountsByStatus(deps.db, deps.repoId);
  const severityCounts = queries.getTicketCountsBySeverity(deps.db, deps.repoId);
  const openTickets = queries.getOpenTicketsByRepo(deps.db, deps.repoId);
  const blockedTickets = queries.getBlockedTicketsByRepo(deps.db, deps.repoId);
  const unassignedOpen = openTickets.filter((ticket) => !ticket.assigneeAgentId);

  const agingBuckets = {
    under1d: 0,
    oneTo3d: 0,
    threeTo7d: 0,
    sevenTo14d: 0,
    over14d: 0,
  };
  const assigneeCounts = new Map<string, number>();

  for (const ticket of openTickets) {
    const ageDays = ticketAgeDays(ticket.createdAt, now);
    if (ageDays < 1) agingBuckets.under1d += 1;
    else if (ageDays < 3) agingBuckets.oneTo3d += 1;
    else if (ageDays < 7) agingBuckets.threeTo7d += 1;
    else if (ageDays < 14) agingBuckets.sevenTo14d += 1;
    else agingBuckets.over14d += 1;

    const key = ticket.assigneeAgentId ?? "unassigned";
    assigneeCounts.set(key, (assigneeCounts.get(key) ?? 0) + 1);
  }

  const assigneeLoad = Array.from(assigneeCounts.entries())
    .map(([assigneeAgentId, count]) => ({
      assigneeAgentId,
      count,
      label: assigneeAgentId === "unassigned"
        ? "unassigned"
        : queries.getAgent(deps.db, assigneeAgentId)?.name ?? assigneeAgentId,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const oldestOpen = openTickets
    .slice(0, 5)
    .map((ticket) => ({
      ticketId: ticket.ticketId,
      title: ticket.title,
      status: ticket.status,
      severity: ticket.severity,
      assigneeAgentId: ticket.assigneeAgentId,
      ageDays: ticketAgeDays(ticket.createdAt, now),
    }));

  return {
    statusCounts,
    severityCounts,
    agingBuckets,
    blockedCount: blockedTickets.length,
    blockedTickets: blockedTickets.slice(0, 5).map((ticket) => ({
      ticketId: ticket.ticketId,
      title: ticket.title,
      assigneeAgentId: ticket.assigneeAgentId,
      ageDays: ticketAgeDays(ticket.createdAt, now),
    })),
    unassignedOpenCount: unassignedOpen.length,
    unassignedOpen: unassignedOpen.slice(0, 5).map((ticket) => ({
      ticketId: ticket.ticketId,
      title: ticket.title,
      status: ticket.status,
      severity: ticket.severity,
      ageDays: ticketAgeDays(ticket.createdAt, now),
    })),
    assigneeLoad: assigneeLoad.slice(0, 6),
    oldestOpen,
  };
}

export function getTicketTemplates(deps: DashboardDeps): {
  path: string;
  exists: boolean;
  error?: string;
  templates: TicketTemplate[];
} {
  return loadTicketTemplates(deps.mainRepoPath ?? deps.repoPath);
}

export async function getSearchDebug(
  deps: DashboardDeps,
  query: string,
  opts?: { scope?: string; limit?: number },
): Promise<CodeSearchDebugResult | { unavailable: true; reason: string }> {
  if (!deps.searchDebug) {
    return {
      unavailable: true,
      reason: "Search debugging is not configured for this dashboard runtime.",
    };
  }

  return deps.searchDebug.searchCode({
    query,
    scope: opts?.scope,
    limit: opts?.limit,
  });
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

export function getDependencyGraph(deps: DashboardDeps, scope?: string) {
  const { files, edges } = queries.getImportGraph(deps.db, deps.repoId, scope);

  // Detect cycles via DFS
  const adj = new Map<number, number[]>();
  for (const edge of edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    adj.get(edge.source)!.push(edge.target);
  }

  const cycleNodes = new Set<number>();
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<number, number>();
  const parent = new Map<number, number>();

  function dfs(u: number): void {
    color.set(u, GRAY);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        // Back edge — trace the cycle back through parent chain
        let cur = u;
        while (cur !== v && parent.has(cur)) {
          cycleNodes.add(cur);
          cur = parent.get(cur)!;
        }
        cycleNodes.add(v);
      } else if ((color.get(v) ?? WHITE) === WHITE) {
        parent.set(v, u);
        dfs(v);
      }
    }
    color.set(u, BLACK);
  }

  for (const file of files) {
    if ((color.get(file.id) ?? WHITE) === WHITE) {
      dfs(file.id);
    }
  }

  const nodes = files.map((f) => ({
    id: f.id,
    path: f.path,
    language: f.language ?? null,
    inCycle: cycleNodes.has(f.id),
  }));

  return { nodes, edges, cycleCount: cycleNodes.size };
}

function ticketAgeDays(createdAt: string, now = Date.now()): number {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) return 0;
  return Math.max(0, Math.floor((now - createdMs) / (24 * 60 * 60 * 1000)));
}
