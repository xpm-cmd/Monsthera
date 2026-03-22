import { and, eq, notInArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { z } from "zod/v4";
import type * as schema from "../db/schema.js";
import * as tables from "../db/schema.js";
import * as queries from "../db/queries.js";
import { getIndexedCommit } from "../indexing/indexer.js";
import { VERSION } from "../core/constants.js";
import { parseJsonWithSchema, parseStringArrayJson } from "../core/input-hardening.js";
import type { CoordinationBus } from "../coordination/bus.js";
import type { GovernanceConfig, TicketQuorumConfig } from "../core/config.js";
import { getAgentPresenceSummary } from "../agents/registry.js";
import { HEARTBEAT_TIMEOUT_MS } from "../core/constants.js";
import { GovernanceConfigSchema } from "../../schemas/governance.js";
import { loadTicketTemplates, type TicketTemplate } from "../tickets/templates.js";
import type { CodeSearchDebugResult } from "../search/debug.js";
import type { KnowledgeScope, SearchKnowledgeOptions, KnowledgeSearchEntry } from "../knowledge/search.js";
import type { TicketStatus } from "../../schemas/ticket.js";
import { buildGovernanceOptions, buildTicketConsensusReport, inferConsensusTransitionForTicketStatus } from "../tickets/consensus.js";
import { buildDuplicateDetectionInsights } from "../tickets/duplicate-detection.js";
import { readResults } from "../simulation/metrics.js";
import type { SimulationResult } from "../simulation/types.js";

type DB = BetterSQLite3Database<typeof schema>;
const SecretLineHitsSchema = z.array(z.object({ pattern: z.string().min(1).optional() }));

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
  ticketQuorum?: TicketQuorumConfig;
  governance?: GovernanceConfig;
  refreshTicketSearch?: () => void;
  refreshKnowledgeSearch?: (knowledgeIds?: number[]) => void;
  searchDebug?: DashboardSearchDebugProvider;
  knowledgeSearch?: (params: SearchKnowledgeOptions) => Promise<KnowledgeSearchEntry[]>;
}

export const STRICT_MODEL_DIVERSITY_ENABLED_MAX_VOTERS_PER_MODEL = 3;
export const STRICT_MODEL_DIVERSITY_DISABLED_REQUIRED_DISTINCT_MODELS = 1;
export const STRICT_MODEL_DIVERSITY_ENABLED_REQUIRED_DISTINCT_MODELS = 2;

export function isStrictModelDiversityEnabled(governance?: GovernanceConfig): boolean {
  const resolved = GovernanceConfigSchema.parse(governance ?? {});
  return resolved.modelDiversity.strict
    && resolved.modelDiversity.maxVotersPerModel <= STRICT_MODEL_DIVERSITY_ENABLED_MAX_VOTERS_PER_MODEL
    && resolved.backlogPlanningGate.enforce
    && resolved.backlogPlanningGate.requiredDistinctModels >= STRICT_MODEL_DIVERSITY_ENABLED_REQUIRED_DISTINCT_MODELS;
}

export function getGovernanceSettings(deps: DashboardDeps) {
  const governance = GovernanceConfigSchema.parse(deps.governance ?? {});
  return {
    modelDiversity: {
      enabled: isStrictModelDiversityEnabled(governance),
      council: {
        strict: governance.modelDiversity.strict,
        maxVotersPerModel: governance.modelDiversity.maxVotersPerModel,
      },
      backlogPlanning: {
        enforce: governance.backlogPlanningGate.enforce,
        minIterations: governance.backlogPlanningGate.minIterations,
        requiredDistinctModels: governance.backlogPlanningGate.requiredDistinctModels,
      },
      reviewerIndependence: governance.reviewerIndependence,
    },
  };
}

const IN_REVIEW_STALE_HOURS = 72;
const HIGH_PRIORITY_THRESHOLD = 7;
const KNOWLEDGE_GRAPH_THRESHOLD = 0.65;
const KNOWLEDGE_GRAPH_EDGE_SCORES = {
  imports: 1.0,
  blocks: 1.0,
  relates_to: 0.65,
  addresses_file: 0.9,
  touches_file: 1.0,
  implements_ticket: 0.95,
  annotates_file: 0.75,
  documents_file: 0.7,
  supports_ticket: 0.7,
} as const;

type KnowledgeGraphNodeType = "file" | "ticket" | "patch" | "note" | "knowledge";
type KnowledgeGraphEdgeType = keyof typeof KNOWLEDGE_GRAPH_EDGE_SCORES;

interface KnowledgeGraphNode {
  id: string;
  nodeType: KnowledgeGraphNodeType;
  label: string;
  details: Record<string, unknown>;
}

interface KnowledgeGraphEdge {
  source: string;
  target: string;
  edgeType: KnowledgeGraphEdgeType;
  score: number;
  provenance: {
    kind: string;
    detail: string;
  };
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

  // Dependency density metric (edges per active ticket, with type breakdown)
  const totalDepsResult = deps.db
    .select({ count: sql<number>`count(*)` })
    .from(tables.ticketDependencies)
    .get();
  const totalDeps = totalDepsResult?.count ?? 0;
  const activeTicketCount = Math.max(openTickets, 1);
  const dependencyDensity = Math.round((totalDeps / activeTicketCount) * 100) / 100;

  const depsByType = deps.db
    .select({
      type: tables.ticketDependencies.relationType,
      count: sql<number>`count(*)`,
    })
    .from(tables.ticketDependencies)
    .groupBy(tables.ticketDependencies.relationType)
    .all();

  const DENSITY_THRESHOLD = 3.0;

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
    dependencyHealth: {
      totalEdges: totalDeps,
      activeTickets: activeTicketCount,
      density: dependencyDensity,
      densityThreshold: DENSITY_THRESHOLD,
      aboveThreshold: dependencyDensity > DENSITY_THRESHOLD,
      byType: Object.fromEntries(depsByType.map((r) => [r.type, r.count])),
    },
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
    provider: a.provider,
    model: a.model,
    modelFamily: a.modelFamily,
    modelVersion: a.modelVersion,
    identitySource: a.identitySource,
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
        provider: agent.provider,
        model: agent.model,
        modelFamily: agent.modelFamily,
        modelVersion: agent.modelVersion,
        identitySource: agent.identitySource,
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

export function getEventLogsList(deps: DashboardDeps, limit = 500, since?: string) {
  const normalizedSince = since?.trim();
  const effectiveSince = normalizedSince || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return queries.getEventLogs(deps.db, limit, effectiveSince).map((e) => ({
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

// ─── Activity Timeline (enriched dashboard events) ──────────────────
export function getActivityTimeline(deps: DashboardDeps, limit = 100) {
  const events = queries.getDashboardEventsByRepo(deps.db, deps.repoId, { limit })
    .sort((a, b) => b.id - a.id); // newest first

  // Build agent name lookup
  const agents = queries.getAllAgents(deps.db);
  const agentMap = new Map<string, { name: string; role: string }>();
  for (const a of agents) {
    agentMap.set(a.id, { name: a.name, role: a.roleId });
  }

  // Build ticket title lookup from recent tickets
  const tickets = queries.getTicketsByRepo(deps.db, deps.repoId);
  const ticketMap = new Map<string, { title: string; status: string }>();
  for (const t of tickets) {
    ticketMap.set(t.ticketId, { title: t.title, status: t.status });
  }

  return events.map((event) => {
    const data = JSON.parse(event.dataJson) as Record<string, unknown>;
    const agentId = (data.agentId ?? data.creatorAgentId ?? data.releasedBy ?? null) as string | null;
    const agent = agentId ? agentMap.get(agentId) : null;
    const ticketId = (data.ticketId ?? data.fromTicketId ?? null) as string | null;
    const ticket = ticketId ? ticketMap.get(ticketId) : null;

    return {
      id: event.id,
      type: event.eventType as string,
      timestamp: event.timestamp,
      agentId,
      agentName: agent?.name ?? agentId ?? null,
      agentRole: agent?.role ?? null,
      ticketId,
      ticketTitle: ticket?.title ?? null,
      ticketStatus: ticket?.status ?? null,
      action: describeEvent(event.eventType as string, data),
      detail: buildEventDetail(event.eventType as string, data),
      category: categorizeEvent(event.eventType as string),
    };
  });
}

function describeEvent(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "ticket_created": return "created ticket";
    case "ticket_assigned": return data.autoAssigned ? "auto-assigned ticket" : "assigned ticket";
    case "ticket_unassigned": return "unassigned ticket";
    case "ticket_status_changed": return `moved ticket ${data.previousStatus} → ${data.status}`;
    case "ticket_verdict_submitted": return `voted ${String(data.verdict).toUpperCase()} as ${data.specialization}`;
    case "ticket_commented": return "commented on ticket";
    case "ticket_linked": return `linked tickets (${data.relationType})`;
    case "ticket_auto_transitioned": return `auto-advanced ticket → ${data.status}`;
    case "ticket_external_sync": return "synced ticket externally";
    case "ticket_orphaned_owner_repaired": return "repaired orphaned ticket";
    case "ticket_repair_spawned": return "spawned repair ticket";
    case "ticket_repair_resolved": return "resolved repair ticket";
    case "agent_registered": return "registered";
    case "session_changed": return "session changed";
    case "patch_proposed": return "proposed patch";
    case "note_added": return "added note";
    case "knowledge_stored": return "stored knowledge";
    case "index_updated": return "index updated";
    case "event_logged": return "event logged";
    case "job_loop_created": return `created loop "${data.loopId}" (${data.slotCount} slots)`;
    case "job_slot_claimed": return `claimed job slot ${data.label}`;
    case "job_slot_active": return `activated job slot`;
    case "job_slot_completed": return `completed job ${data.label}`;
    case "job_slot_released": return "released job slot";
    case "job_slot_abandoned": return "abandoned job slot";
    case "job_progress_update": return `progress: ${typeof data.progressNote === "string" ? data.progressNote.slice(0, 80) : "update"}`;
    default: return type.replace(/_/g, " ");
  }
}

function buildEventDetail(type: string, data: Record<string, unknown>): string | null {
  switch (type) {
    case "ticket_verdict_submitted": {
      const parts: string[] = [];
      if (data.specialization) parts.push(String(data.specialization));
      if (data.verdict) parts.push(String(data.verdict).toUpperCase());
      if (data.responded != null && data.required != null) {
        parts.push(`${data.responded}/${data.required} quorum`);
      }
      if (data.reasoning && typeof data.reasoning === "string") {
        parts.push(data.reasoning.slice(0, 120));
      }
      return parts.join(" · ") || null;
    }
    case "ticket_status_changed":
      return `${data.previousStatus} → ${data.status}`;
    case "patch_proposed": {
      const parts: string[] = [];
      if (data.message) parts.push(String(data.message).slice(0, 80));
      if (data.affectedFiles && Array.isArray(data.affectedFiles)) {
        parts.push(`${data.affectedFiles.length} files`);
      }
      return parts.join(" · ") || null;
    }
    case "ticket_assigned":
      return data.assigneeAgentId ? `→ ${data.assigneeAgentId}` : null;
    case "job_loop_created":
      return `template: ${data.template}, ${data.slotCount} slots`;
    case "job_slot_claimed":
      return data.specialization ? `role: ${data.role}, spec: ${data.specialization}` : `role: ${data.role}`;
    case "job_progress_update":
      return typeof data.progressNote === "string" ? data.progressNote.slice(0, 200) : null;
    default:
      return null;
  }
}

function categorizeEvent(type: string): "governance" | "development" | "planning" | "system" | "jobs" {
  if (type.startsWith("ticket_verdict") || type === "ticket_auto_transitioned") return "governance";
  if (type === "patch_proposed" || type === "ticket_status_changed") return "development";
  if (type === "ticket_created" || type === "ticket_commented" || type === "ticket_linked") return "planning";
  if (type.startsWith("job_")) return "jobs";
  return "system";
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
      const hits = parseJsonWithSchema(file.secretLineRanges, SecretLineHitsSchema, []);
      for (const hit of hits) {
        if (!hit.pattern) continue;
        secretPatternCounts.set(hit.pattern, (secretPatternCounts.get(hit.pattern) ?? 0) + 1);
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
        claimedFiles: parseStringArrayJson(s.claimedFilesJson, {
          maxItems: 50,
          maxItemLength: 500,
        }),
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
  const now = Date.now();
  const tickets = queries.getTicketsByRepo(deps.db, deps.repoId);
  const duplicateInsights = buildDashboardDuplicateInsights(tickets);

  return tickets.map((ticket) => {
    const visibility = getTicketVisibilitySignals(deps, ticket, now);
    const history = queries.getTicketHistory(deps.db, ticket.id);
    const quorum = buildDashboardTicketQuorum(deps, ticket);
    const assigneeHealth = getTicketAssigneeHealth(deps, ticket, now);
    const humanAction = getHumanActionRequired(ticket, quorum, history, assigneeHealth);
    const duplicateSignal = duplicateInsights.byTicketId.get(ticket.ticketId) ?? null;

    return {
      ticketId: ticket.ticketId,
      title: ticket.title,
      status: ticket.status,
      severity: ticket.severity,
      priority: ticket.priority,
      assignee: ticket.assigneeAgentId ?? null,
      creator: ticket.creatorAgentId,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      ageDays: ticketAgeDays(ticket.createdAt, now),
      statusAgeHours: visibility.statusAgeHours,
      statusAgeDays: visibility.statusAgeDays,
      lastStatusChangeAt: visibility.lastStatusChangeAt,
      isHighPriority: ticket.priority >= HIGH_PRIORITY_THRESHOLD,
      inReviewStale: visibility.inReviewStale,
      inReviewIdleHours: visibility.inReviewIdleHours,
      inReviewIdleDays: visibility.inReviewIdleDays,
      lastReviewActivityAt: visibility.lastReviewActivityAt,
      quorumBadge: quorum?.progress.label ?? null,
      quorumState: quorum?.progress.state ?? null,
      quorumTitle: quorum?.progress.title ?? null,
      blockedByVeto: quorum?.blockedByVeto ?? false,
      orphanedAssignee: assigneeHealth.orphaned,
      orphanedAssigneeReason: assigneeHealth.reason,
      humanActionRequired: humanAction.required,
      humanActionReason: humanAction.reason,
      suspiciousDuplicate: !!duplicateSignal,
      duplicateClusterCount: duplicateSignal?.clusterIds.length ?? 0,
      duplicatePeerCount: duplicateSignal?.peerTicketIds.length ?? 0,
      duplicateSignalScore: duplicateSignal?.score ?? 0,
      duplicateReasons: duplicateSignal?.reasons ?? [],
      duplicateTitle: duplicateSignal ? summarizeDuplicateReasons(duplicateSignal.reasons) : null,
      agents: getTicketAgentBadges(deps, ticket.ticketId, now),
    };
  });
}

function getTicketAgentBadges(deps: DashboardDeps, ticketId: string, now: number) {
  try {
    const slots = queries.getJobSlotsByTicketId(deps.db, deps.repoId, ticketId);
    if (slots.length === 0) return [];
    const TWO_MINUTES = 2 * 60 * 1000;
    const TEN_MINUTES = 10 * 60 * 1000;

    return slots.map((s) => {
      let presence: "online" | "idle" | "offline" | "open" = "open";
      if (s.agentId && s.lastHeartbeat) {
        const age = now - new Date(s.lastHeartbeat).getTime();
        presence = age < TWO_MINUTES ? "online" : age < TEN_MINUTES ? "idle" : "offline";
      }
      const agent = s.agentId ? queries.getAgent(deps.db, s.agentId) : null;
      return {
        slotId: s.slotId,
        role: s.role,
        specialization: s.specialization,
        label: s.label,
        status: s.status,
        agentName: agent?.name ?? null,
        agentModel: agent?.model ?? null,
        presence,
        progressNote: s.progressNote,
      };
    });
  } catch {
    return [];
  }
}

export function getTicketDetail(deps: DashboardDeps, ticketId: string) {
  const ticket = queries.getTicketByTicketId(deps.db, ticketId, deps.repoId);
  if (!ticket) return null;
  // Lazy duplicate detection: only load tickets when needed, cache-friendly
  const tickets = queries.getTicketsByRepo(deps.db, deps.repoId);
  const duplicateInsights = buildDashboardDuplicateInsights(tickets);
  const duplicateSignal = duplicateInsights.byTicketId.get(ticket.ticketId) ?? null;
  const duplicateClusters = duplicateInsights.clusters
    .filter((cluster) => cluster.ticketIds.includes(ticket.ticketId))
    .map((cluster) => ({
      id: cluster.id,
      score: cluster.score,
      reasons: cluster.reasons,
      createdSpanMinutes: cluster.createdSpanMinutes,
      tickets: cluster.tickets.filter((entry) => entry.ticketId !== ticket.ticketId),
    }));

  const comments = queries.getTicketComments(deps.db, ticket.id);
  const history = queries.getTicketHistory(deps.db, ticket.id);
  const linkedPatches = queries.getPatchesByTicketId(deps.db, ticket.id);
  const ticketDeps = queries.getTicketDependencies(deps.db, ticket.id);
  const resolutionCommitShas = queries.getTicketResolutionCommitShas(deps.db, ticket.id);
  const quorum = buildDashboardTicketQuorum(deps, ticket);
  const assigneeHealth = getTicketAssigneeHealth(deps, ticket);
  const humanAction = getHumanActionRequired(ticket, quorum, history, assigneeHealth);

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
  const nextActionHint = getNextActionHint(deps, ticket, history, comments);

  return {
    ticketId: ticket.ticketId,
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    severity: ticket.severity,
    priority: ticket.priority,
    tags: parseStringArrayJson(ticket.tagsJson, {
      maxItems: 25,
      maxItemLength: 64,
    }),
    affectedPaths: parseStringArrayJson(ticket.affectedPathsJson, {
      maxItems: 100,
      maxItemLength: 500,
    }),
    acceptanceCriteria: ticket.acceptanceCriteria,
    creatorAgentId: ticket.creatorAgentId,
    assigneeAgentId: ticket.assigneeAgentId,
    resolvedByAgentId: ticket.resolvedByAgentId,
    commitSha: ticket.commitSha,
    resolutionCommitShas,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    nextActionHint,
    orphanedAssignee: assigneeHealth.orphaned,
    orphanedAssigneeReason: assigneeHealth.reason,
    humanActionRequired: humanAction.required,
    humanActionReason: humanAction.reason,
    suspiciousDuplicate: !!duplicateSignal,
    duplicateSignal: duplicateSignal
      ? {
          clusterCount: duplicateSignal.clusterIds.length,
          peerCount: duplicateSignal.peerTicketIds.length,
          score: duplicateSignal.score,
          reasons: duplicateSignal.reasons,
          clusters: duplicateClusters,
        }
      : null,
    dependencies: { blocking, blockedBy, relatedTo },
    comments: (() => {
      const agentIds = new Set(comments.map((c) => c.agentId));
      const agentMap = new Map(
        [...agentIds].map((id) => [id, queries.getAgent(deps.db, id)]),
      );
      return comments.map((comment) => {
        const agent = agentMap.get(comment.agentId);
        return {
          agentId: comment.agentId,
          agentName: agent?.name ?? null,
          agentType: agent?.type ?? null,
          content: comment.content,
          createdAt: comment.createdAt,
        };
      });
    })(),
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
    quorum,
  };
}

export function getTicketMetrics(deps: DashboardDeps) {
  const now = Date.now();
  const statusCounts = queries.getTicketCountsByStatus(deps.db, deps.repoId);
  const severityCounts = queries.getTicketCountsBySeverity(deps.db, deps.repoId);
  const allTickets = queries.getTicketsByRepo(deps.db, deps.repoId);
  const duplicateInsights = buildDashboardDuplicateInsights(allTickets);
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

  const duplicateClusters = duplicateInsights.clusters.slice(0, 5).map((cluster) => ({
    id: cluster.id,
    score: cluster.score,
    reasons: cluster.reasons,
    createdSpanMinutes: cluster.createdSpanMinutes,
    ticketIds: cluster.ticketIds,
    tickets: cluster.tickets,
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
    duplicateClusterCount: duplicateInsights.clusters.length,
    duplicateClusters,
    assigneeLoad: assigneeLoad.slice(0, 6),
    oldestOpen,
    commitHealth: getCommitToTicketHealth(deps),
  };
}

function buildDashboardDuplicateInsights(
  tickets: Array<typeof schema.tickets.$inferSelect>,
) {
  return buildDuplicateDetectionInsights(tickets.map((ticket) => ({
    ticketId: ticket.ticketId,
    title: ticket.title,
    status: ticket.status,
    creatorAgentId: ticket.creatorAgentId,
    assigneeAgentId: ticket.assigneeAgentId,
    commitSha: ticket.commitSha,
    createdAt: ticket.createdAt,
    tags: parseStringArrayJson(ticket.tagsJson, {
      maxItems: 25,
      maxItemLength: 64,
    }),
    affectedPaths: parseStringArrayJson(ticket.affectedPathsJson, {
      maxItems: 100,
      maxItemLength: 500,
    }),
  })));
}

function summarizeDuplicateReasons(reasons: string[]): string {
  if (reasons.length === 0) return "Suspicious duplicate cluster";
  if (reasons.length === 1) return reasons[0]!;
  return `${reasons[0]} · ${reasons[1]}`;
}

function getCommitToTicketHealth(deps: DashboardDeps) {
  const resolvedTickets = deps.db.select({
    ticketId: tables.tickets.ticketId,
    commitSha: tables.tickets.commitSha,
  })
    .from(tables.tickets)
    .where(and(
      eq(tables.tickets.repoId, deps.repoId),
      eq(tables.tickets.status, "resolved"),
    ))
    .all()
    .filter((row) => row.commitSha);

  const shaToTickets = new Map<string, string[]>();
  for (const row of resolvedTickets) {
    if (!row.commitSha) continue;
    const list = shaToTickets.get(row.commitSha) ?? [];
    list.push(row.ticketId);
    shaToTickets.set(row.commitSha, list);
  }

  const multiTicketCommits = [...shaToTickets.entries()]
    .filter(([, tickets]) => tickets.length > 1)
    .map(([sha, tickets]) => ({ sha: sha.slice(0, 7), ticketCount: tickets.length, ticketIds: tickets }))
    .sort((a, b) => b.ticketCount - a.ticketCount);

  return {
    totalResolvedWithCommit: resolvedTickets.length,
    uniqueCommits: shaToTickets.size,
    multiTicketCommitCount: multiTicketCommits.length,
    multiTicketCommits: multiTicketCommits.slice(0, 5),
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

export async function getKnowledgeList(
  deps: DashboardDeps,
  opts?: { query?: string; scope?: KnowledgeScope; type?: string; limit?: number },
) {
  const scope = opts?.scope ?? "all";
  const type = opts?.type;
  const query = opts?.query?.trim() ?? "";

  if (query && deps.knowledgeSearch) {
    const results = await deps.knowledgeSearch({
      query,
      scope,
      type,
      limit: opts?.limit ?? 20,
    });
    return results.map((entry) => ({
      key: entry.key,
      type: entry.type,
      scope: entry.scope,
      title: entry.title,
      contentPreview: entry.content.slice(0, 200),
      tags: entry.tags,
      status: entry.status,
      agentId: entry.agentId,
      updatedAt: entry.updatedAt,
      score: Math.round(entry.score * 1000) / 1000,
    }));
  }

  const repoEntries = (scope === "repo" || scope === "all")
    ? queries.queryKnowledge(deps.db, { type }).map((entry) => ({ ...entry, scope: "repo" as const }))
    : [];

  const globalEntries = (scope === "global" || scope === "all") && deps.globalDb
    ? queries.queryKnowledge(deps.globalDb, { type }).map((entry) => ({ ...entry, scope: "global" as const }))
    : [];

  const combined = [...repoEntries, ...globalEntries]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((entry) => ({
      key: entry.key,
      type: entry.type,
      scope: entry.scope,
      title: entry.title,
      contentPreview: entry.content.slice(0, 200),
      tags: parseStringArrayJson(entry.tagsJson, {
        maxItems: 25,
        maxItemLength: 64,
      }),
      status: entry.status,
      agentId: entry.agentId,
      updatedAt: entry.updatedAt,
    }));

  if (opts?.limit) {
    return combined.slice(0, opts.limit);
  }
  return combined;
}

export function getDependencyGraph(deps: DashboardDeps, scope?: string) {
  const focusFilePath = scope ? queries.getFileByPath(deps.db, deps.repoId, scope)?.path : undefined;
  const { files, edges } = queries.getImportGraph(deps.db, deps.repoId, {
    scope: focusFilePath ? undefined : scope,
    focusFilePath,
  });

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

export function getKnowledgeGraph(deps: DashboardDeps) {
  const files = queries.getAllFiles(deps.db, deps.repoId);
  const tickets = queries.getTicketsByRepo(deps.db, deps.repoId);
  const patches = queries.getPatchesByRepo(deps.db, deps.repoId);
  const notes = queries.getNotesByRepo(deps.db, deps.repoId);
  const knowledgeEntries = queries.queryKnowledge(deps.db, { status: "active" });
  const importGraph = queries.getImportGraph(deps.db, deps.repoId);

  const fileById = new Map(files.map((file) => [file.id, file] as const));
  const fileByPath = new Map(files.map((file) => [file.path, file] as const));
  const knownFilePaths = new Set(fileByPath.keys());
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const ticketByPublicId = new Map(tickets.map((ticket) => [ticket.ticketId, ticket] as const));

  const nodes = new Map<string, KnowledgeGraphNode>();
  const edges = new Map<string, KnowledgeGraphEdge>();

  const fileNodeId = (path: string) => `file:${path}`;
  const ticketNodeId = (ticketId: string) => `ticket:${ticketId}`;
  const patchNodeId = (proposalId: string) => `patch:${proposalId}`;
  const noteNodeId = (key: string) => `note:${key}`;
  const knowledgeNodeId = (key: string) => `knowledge:${key}`;

  const ensureNode = (node: KnowledgeGraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };

  const ensureFileNode = (path: string) => {
    const file = fileByPath.get(path);
    if (!file) return null;
    const id = fileNodeId(file.path);
    ensureNode({
      id,
      nodeType: "file",
      label: file.path,
      details: {
        path: file.path,
        language: file.language ?? null,
        summary: file.summary ?? null,
      },
    });
    return id;
  };

  const ensureTicketNode = (ticket: typeof schema.tickets.$inferSelect) => {
    const id = ticketNodeId(ticket.ticketId);
    ensureNode({
      id,
      nodeType: "ticket",
      label: ticket.ticketId,
      details: {
        ticketId: ticket.ticketId,
        title: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
        severity: ticket.severity,
      },
    });
    return id;
  };

  const ensurePatchNode = (patch: typeof schema.patches.$inferSelect) => {
    const id = patchNodeId(patch.proposalId);
    ensureNode({
      id,
      nodeType: "patch",
      label: patch.proposalId,
      details: {
        proposalId: patch.proposalId,
        state: patch.state,
        message: patch.message,
        committedSha: patch.committedSha ?? null,
      },
    });
    return id;
  };

  const ensureNoteNode = (note: typeof schema.notes.$inferSelect) => {
    const id = noteNodeId(note.key);
    ensureNode({
      id,
      nodeType: "note",
      label: note.key,
      details: {
        key: note.key,
        type: note.type,
        preview: note.content.slice(0, 200),
        updatedAt: note.updatedAt,
      },
    });
    return id;
  };

  const ensureKnowledgeNode = (entry: typeof schema.knowledge.$inferSelect) => {
    const id = knowledgeNodeId(entry.key);
    ensureNode({
      id,
      nodeType: "knowledge",
      label: entry.title,
      details: {
        key: entry.key,
        title: entry.title,
        type: entry.type,
        scope: entry.scope,
        preview: entry.content.slice(0, 200),
        updatedAt: entry.updatedAt,
      },
    });
    return id;
  };

  const addEdge = (edge: KnowledgeGraphEdge) => {
    if (edge.score < KNOWLEDGE_GRAPH_THRESHOLD) return;
    const key = edge.edgeType === "relates_to"
      ? `${edge.edgeType}:${[edge.source, edge.target].sort().join("|")}`
      : `${edge.edgeType}:${edge.source}->${edge.target}`;
    const existing = edges.get(key);
    if (!existing || existing.score < edge.score) {
      edges.set(key, edge.edgeType === "relates_to" && edge.source > edge.target
        ? { ...edge, source: edge.target, target: edge.source }
        : edge);
    }
  };

  for (const ticket of tickets) {
    const ticketId = ensureTicketNode(ticket);
    const affectedPaths = parseStringArrayJson(ticket.affectedPathsJson, {
      maxItems: 100,
      maxItemLength: 500,
    });
    for (const path of affectedPaths) {
      const normalized = normalizeKnowledgeGraphPath(path);
      const fileId = ensureFileNode(normalized);
      if (!fileId) continue;
      addEdge({
        source: ticketId,
        target: fileId,
        edgeType: "addresses_file",
        score: KNOWLEDGE_GRAPH_EDGE_SCORES.addresses_file,
        provenance: {
          kind: "ticket.affected_paths",
          detail: ticket.ticketId,
        },
      });
    }

    const dependencies = queries.getTicketDependencies(deps.db, ticket.id);
    for (const relation of dependencies.outgoing) {
      const targetTicket = ticketById.get(relation.toTicketId);
      if (!targetTicket) continue;
      addEdge({
        source: ticketId,
        target: ensureTicketNode(targetTicket),
        edgeType: relation.relationType === "blocks" ? "blocks" : "relates_to",
        score: KNOWLEDGE_GRAPH_EDGE_SCORES[relation.relationType === "blocks" ? "blocks" : "relates_to"],
        provenance: {
          kind: "ticket_dependency",
          detail: `${ticket.ticketId} ${relation.relationType} ${targetTicket.ticketId}`,
        },
      });
    }
  }

  for (const patch of patches) {
    const patchId = ensurePatchNode(patch);
    const touchedPaths = parseStringArrayJson(patch.touchedPathsJson, {
      maxItems: 100,
      maxItemLength: 500,
    });
    for (const path of touchedPaths) {
      const normalized = normalizeKnowledgeGraphPath(path);
      const fileId = ensureFileNode(normalized);
      if (!fileId) continue;
      addEdge({
        source: patchId,
        target: fileId,
        edgeType: "touches_file",
        score: KNOWLEDGE_GRAPH_EDGE_SCORES.touches_file,
        provenance: {
          kind: "patch.touched_paths",
          detail: patch.proposalId,
        },
      });
    }

    if (patch.ticketId) {
      const ticket = ticketById.get(patch.ticketId);
      if (ticket) {
        addEdge({
          source: patchId,
          target: ensureTicketNode(ticket),
          edgeType: "implements_ticket",
          score: KNOWLEDGE_GRAPH_EDGE_SCORES.implements_ticket,
          provenance: {
            kind: "patch.ticket_id",
            detail: patch.proposalId,
          },
        });
      }
    }
  }

  for (const note of notes) {
    const noteId = ensureNoteNode(note);
    const linkedPaths = parseStringArrayJson(note.linkedPathsJson, {
      maxItems: 50,
      maxItemLength: 500,
    });
    for (const path of linkedPaths) {
      const normalized = normalizeKnowledgeGraphPath(path);
      const fileId = ensureFileNode(normalized);
      if (!fileId) continue;
      addEdge({
        source: noteId,
        target: fileId,
        edgeType: "annotates_file",
        score: KNOWLEDGE_GRAPH_EDGE_SCORES.annotates_file,
        provenance: {
          kind: "note.linked_paths",
          detail: note.key,
        },
      });
    }

    const ticketRefs = extractExplicitTicketRefs(note.content, ticketByPublicId);
    for (const ticketRef of ticketRefs) {
      addEdge({
        source: noteId,
        target: ensureTicketNode(ticketByPublicId.get(ticketRef)!),
        edgeType: "supports_ticket",
        score: KNOWLEDGE_GRAPH_EDGE_SCORES.supports_ticket,
        provenance: {
          kind: "note.ticket_ref",
          detail: note.key,
        },
      });
    }
  }

  for (const entry of knowledgeEntries) {
    const knowledgeId = ensureKnowledgeNode(entry);
    const text = `${entry.title}\n${entry.content}`;
    for (const filePath of extractExplicitFilePaths(text, knownFilePaths)) {
      const fileId = ensureFileNode(filePath);
      if (!fileId) continue;
      addEdge({
        source: knowledgeId,
        target: fileId,
        edgeType: "documents_file",
        score: KNOWLEDGE_GRAPH_EDGE_SCORES.documents_file,
        provenance: {
          kind: "knowledge.file_ref",
          detail: entry.key,
        },
      });
    }
    for (const ticketRef of extractExplicitTicketRefs(text, ticketByPublicId)) {
      addEdge({
        source: knowledgeId,
        target: ensureTicketNode(ticketByPublicId.get(ticketRef)!),
        edgeType: "supports_ticket",
        score: KNOWLEDGE_GRAPH_EDGE_SCORES.supports_ticket,
        provenance: {
          kind: "knowledge.ticket_ref",
          detail: entry.key,
        },
      });
    }
  }

  for (const edge of importGraph.edges) {
    const sourceFile = fileById.get(edge.source);
    const targetFile = fileById.get(edge.target);
    if (!sourceFile || !targetFile) continue;
    const source = fileNodeId(sourceFile.path);
    const target = fileNodeId(targetFile.path);
    if (!nodes.has(source) || !nodes.has(target)) continue;
    addEdge({
      source,
      target,
      edgeType: "imports",
      score: KNOWLEDGE_GRAPH_EDGE_SCORES.imports,
      provenance: {
        kind: "imports_index",
        detail: `${sourceFile.path} -> ${targetFile.path}`,
      },
    });
  }

  const connectionCounts = new Map<string, number>();
  for (const edge of edges.values()) {
    connectionCounts.set(edge.source, (connectionCounts.get(edge.source) ?? 0) + 1);
    connectionCounts.set(edge.target, (connectionCounts.get(edge.target) ?? 0) + 1);
  }

  const graphNodes = Array.from(nodes.values())
    .filter((node) => connectionCounts.has(node.id))
    .sort((a, b) => a.nodeType.localeCompare(b.nodeType) || a.label.localeCompare(b.label))
    .map((node) => ({
      ...node,
      connectionCount: connectionCounts.get(node.id) ?? 0,
    }));

  const activeNodeIds = new Set(graphNodes.map((node) => node.id));
  const graphEdges = Array.from(edges.values())
    .filter((edge) => activeNodeIds.has(edge.source) && activeNodeIds.has(edge.target))
    .sort((a, b) => a.edgeType.localeCompare(b.edgeType) || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  return {
    defaultThreshold: KNOWLEDGE_GRAPH_THRESHOLD,
    nodes: graphNodes,
    edges: graphEdges,
  };
}

function normalizeKnowledgeGraphPath(path: string): string {
  return path.trim().replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function normalizeGraphToken(token: string): string {
  return token
    .replace(/^[("'`[{<]+/, "")
    .replace(/[)"'`\]}>.,:;!?]+$/, "");
}

function extractExplicitFilePaths(text: string, knownPaths: Set<string>): string[] {
  const matches = new Set<string>();
  const tokens = text.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+/g) ?? [];
  for (const rawToken of tokens) {
    const normalized = normalizeKnowledgeGraphPath(normalizeGraphToken(rawToken));
    if (knownPaths.has(normalized)) {
      matches.add(normalized);
    }
  }
  return Array.from(matches);
}

function extractExplicitTicketRefs(
  text: string,
  ticketByPublicId: Map<string, typeof schema.tickets.$inferSelect>,
): string[] {
  const matches = new Set<string>();
  for (const match of text.match(/TKT-[A-Za-z0-9_-]+/g) ?? []) {
    if (ticketByPublicId.has(match)) {
      matches.add(match);
    }
  }
  return Array.from(matches);
}

function ticketAgeDays(createdAt: string, now = Date.now()): number {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) return 0;
  return Math.max(0, Math.floor((now - createdMs) / (24 * 60 * 60 * 1000)));
}

function getNextActionHint(
  deps: DashboardDeps,
  ticket: typeof schema.tickets.$inferSelect,
  history: Array<typeof schema.ticketHistory.$inferSelect>,
  comments: Array<typeof schema.ticketComments.$inferSelect>,
): {
  kind: "reviewer" | "assignee" | "operator";
  label: string;
  agentId: string | null;
  agentName: string | null;
  reason: string;
} {
  const lastHistory = history.at(-1);
  const lastComment = comments.at(-1);
  const lastHistoryMs = lastHistory ? new Date(lastHistory.timestamp).getTime() : Number.NEGATIVE_INFINITY;
  const lastCommentMs = lastComment ? new Date(lastComment.createdAt).getTime() : Number.NEGATIVE_INFINITY;
  const lastActorId = lastCommentMs >= lastHistoryMs
    ? (lastComment?.agentId ?? null)
    : (lastHistory?.agentId ?? null);
  const assigneeName = ticket.assigneeAgentId ? queries.getAgent(deps.db, ticket.assigneeAgentId)?.name ?? null : null;

  if (ticket.status === "in_review") {
    if (ticket.assigneeAgentId && lastActorId && lastActorId !== ticket.assigneeAgentId) {
      return {
        kind: "assignee",
        label: "Assignee likely next",
        agentId: ticket.assigneeAgentId,
        agentName: assigneeName,
        reason: "Recent review-side activity suggests the assignee should respond or update the ticket.",
      };
    }
    return {
      kind: "reviewer",
      label: "Reviewer likely next",
      agentId: null,
      agentName: null,
      reason: "This workflow state usually waits on review-side validation or approval.",
    };
  }

  if (ticket.status === "ready_for_commit") {
    if (ticket.assigneeAgentId) {
      return {
        kind: "assignee",
        label: "Assignee likely next",
        agentId: ticket.assigneeAgentId,
        agentName: assigneeName,
        reason: "Review is complete, so the assignee likely commits or resolves the ticket next.",
      };
    }
    return {
      kind: "operator",
      label: "Operator likely next",
      agentId: null,
      agentName: null,
      reason: "The ticket is ready to commit but unassigned, so an operator likely needs to route or land it.",
    };
  }

  if (ticket.status === "approved" || ticket.status === "in_progress" || ticket.status === "blocked") {
    if (ticket.assigneeAgentId) {
      return {
        kind: "assignee",
        label: "Assignee likely next",
        agentId: ticket.assigneeAgentId,
        agentName: assigneeName,
        reason: "The ticket is in an execution state and already has an assignee.",
      };
    }
    return {
      kind: "operator",
      label: "Operator likely next",
      agentId: null,
      agentName: null,
      reason: "The ticket is active but unassigned, so a human needs to route or assign it.",
    };
  }

  if (ticket.status === "technical_analysis" || ticket.status === "backlog") {
    return {
      kind: "reviewer",
      label: "Reviewer likely next",
      agentId: null,
      agentName: null,
      reason: "Planning and approval states usually need reviewer or operator attention next.",
    };
  }

  return {
    kind: "operator",
    label: "No immediate action expected",
    agentId: null,
    agentName: null,
    reason: "This ticket is not currently in an active workflow state.",
  };
}

function getTicketVisibilitySignals(
  deps: DashboardDeps,
  ticket: typeof schema.tickets.$inferSelect,
  now = Date.now(),
): {
  statusAgeHours: number;
  statusAgeDays: number;
  lastStatusChangeAt: string | null;
  inReviewStale: boolean;
  inReviewIdleHours: number | null;
  inReviewIdleDays: number | null;
  lastReviewActivityAt: string | null;
} {
  const history = queries.getTicketHistory(deps.db, ticket.id);
  const comments = queries.getTicketComments(deps.db, ticket.id);
  const lastStatusTransition = history
    .filter((entry) => entry.toStatus === ticket.status)
    .at(-1);
  const statusAnchor = lastStatusTransition?.timestamp ?? ticket.createdAt;
  const statusAnchorMs = new Date(statusAnchor).getTime();
  const statusAgeHours = Math.max(0, Math.floor((now - (Number.isNaN(statusAnchorMs) ? now : statusAnchorMs)) / (60 * 60 * 1000)));
  const statusAgeDays = Math.floor(statusAgeHours / 24);

  if (ticket.status !== "in_review") {
    return {
      statusAgeHours,
      statusAgeDays,
      lastStatusChangeAt: statusAnchor,
      inReviewStale: false,
      inReviewIdleHours: null,
      inReviewIdleDays: null,
      lastReviewActivityAt: null,
    };
  }

  const lastInReviewTransition = history
    .filter((entry) => entry.toStatus === "in_review")
    .at(-1);

  const anchor = lastInReviewTransition?.timestamp ?? ticket.updatedAt;
  const anchorMs = new Date(anchor).getTime();
  let latestMs = Number.isNaN(anchorMs) ? now : anchorMs;
  let latestAt = anchor;

  for (const comment of comments) {
    const commentMs = new Date(comment.createdAt).getTime();
    if (Number.isNaN(commentMs)) continue;
    if (!Number.isNaN(anchorMs) && commentMs < anchorMs) continue;
    if (commentMs > latestMs) {
      latestMs = commentMs;
      latestAt = comment.createdAt;
    }
  }

  const idleHours = Math.max(0, Math.floor((now - latestMs) / (60 * 60 * 1000)));
  const idleDays = Math.floor(idleHours / 24);

  return {
    statusAgeHours,
    statusAgeDays,
    lastStatusChangeAt: statusAnchor,
    inReviewStale: idleHours >= IN_REVIEW_STALE_HOURS,
    inReviewIdleHours: idleHours,
    inReviewIdleDays: idleDays,
    lastReviewActivityAt: latestAt,
  };
}

function getHumanActionRequired(
  ticket: typeof schema.tickets.$inferSelect,
  quorum: ReturnType<typeof buildDashboardTicketQuorum>,
  history: Array<typeof schema.ticketHistory.$inferSelect>,
  assigneeHealth: ReturnType<typeof getTicketAssigneeHealth>,
): { required: boolean; reason: string | null } {
  if (assigneeHealth.orphaned) {
    return { required: true, reason: "orphaned_assignee" };
  }

  if (ticket.status === "ready_for_commit" && !ticket.assigneeAgentId) {
    return { required: true, reason: "ready_for_commit_unassigned" };
  }

  if (["approved", "in_progress"].includes(ticket.status) && !ticket.assigneeAgentId) {
    return { required: true, reason: "active_unassigned" };
  }

  const latestBlockedEntry = history
    .filter((entry) => entry.toStatus === "blocked")
    .at(-1);
  if (
    ticket.status === "blocked"
    && latestBlockedEntry?.agentId
    && latestBlockedEntry.agentId.startsWith("system:lifecycle-")
  ) {
    return { required: true, reason: "lifecycle_guard_blocked" };
  }

  // Council veto blocks progress → human must resolve
  if (quorum?.blockedByVeto) {
    return { required: true, reason: "veto_blocked" };
  }

  // Waiting for council quorum with no reviews yet
  if (
    ["technical_analysis", "in_review"].includes(ticket.status) &&
    quorum &&
    (quorum.progress.responded === 0 || quorum.missingSpecializations.length > 0)
  ) {
    return { required: true, reason: "quorum_waiting_on_human" };
  }

  return { required: false, reason: null };
}

function getTicketAssigneeHealth(
  deps: DashboardDeps,
  ticket: typeof schema.tickets.$inferSelect,
  now = Date.now(),
): {
  orphaned: boolean;
  reason: string | null;
  liveSessionCount: number;
  lastActivityAt: string | null;
} {
  if (!ticket.assigneeAgentId || !["approved", "in_progress"].includes(ticket.status)) {
    return {
      orphaned: false,
      reason: null,
      liveSessionCount: 0,
      lastActivityAt: null,
    };
  }

  const presence = getAgentPresenceSummary(deps.db, ticket.assigneeAgentId, now);
  const orphaned = !presence.hasLiveOwnershipEvidence;
  return {
    orphaned,
    reason: orphaned ? "assignee_no_live_sessions" : null,
    liveSessionCount: presence.liveSessionCount,
    lastActivityAt: presence.lastActivityAt,
  };
}

function buildDashboardTicketQuorum(
  deps: DashboardDeps,
  ticket: typeof schema.tickets.$inferSelect,
): {
  transition: string;
  requiredPasses: number;
  progress: {
    label: string;
    state: "success" | "purple" | "orange" | "red";
    title: string;
    responded: number;
    total: number;
  };
  counts: {
    pass: number;
    fail: number;
    abstain: number;
    responded: number;
    missing: number;
  };
  quorumMet: boolean;
  blockedByVeto: boolean;
  advisoryReady: boolean;
  missingSpecializations: string[];
  verdicts: Array<{
    specialization: string;
    verdict: "pass" | "fail" | "abstain" | "missing";
    agentId: string | null;
    agentName: string | null;
    agentType: string | null;
    createdAt: string | null;
    reasoning: string | null;
    isVeto: boolean;
  }>;
  vetoes: Array<{
    specialization: string;
    verdict: "fail";
    agentId: string;
    agentName: string | null;
    agentType: string | null;
    createdAt: string;
    reasoning: string | null;
  }>;
} | null {
  const transition = inferConsensusTransitionForTicketStatus(ticket.status as TicketStatus);
  if (!transition) return null;

  const verdictRows = queries.getActiveReviewVerdicts(deps.db, ticket.id);
  const agentCache = new Map<string, ReturnType<typeof queries.getAgent> | null>();
  const resolveAgent = (agentId: string) => {
    if (!agentCache.has(agentId)) {
      agentCache.set(agentId, queries.getAgent(deps.db, agentId) ?? null);
    }
    return agentCache.get(agentId) ?? null;
  };

  const consensus = buildTicketConsensusReport({
    ticketId: ticket.ticketId,
    verdictRows,
    config: deps.ticketQuorum,
    transition,
    governance: buildGovernanceOptions(deps.governance, verdictRows, (agentId: string) => {
      const agent = resolveAgent(agentId);
      return agent ? { roleId: agent.roleId, provider: agent.provider, model: agent.model } : undefined;
    }, ticket.severity),
  });
  const vetoKeys = new Set(consensus.vetoes.map((entry) => `${entry.specialization}:${entry.agentId}`));
  const verdictBySpecialization = new Map(consensus.verdicts.map((entry) => [entry.specialization, entry] as const));
  const progress = summarizeDashboardQuorumProgress(consensus);

  return {
    transition,
    requiredPasses: consensus.requiredPasses,
    progress,
    counts: consensus.counts,
    quorumMet: consensus.quorumMet,
    blockedByVeto: consensus.blockedByVeto,
    advisoryReady: consensus.advisoryReady,
    missingSpecializations: [...consensus.missingSpecializations],
    verdicts: consensus.councilSpecializations.map((specialization) => {
      const verdict = verdictBySpecialization.get(specialization);
      const agent = verdict ? resolveAgent(verdict.agentId) : null;

      return {
        specialization,
        verdict: verdict?.verdict ?? "missing",
        agentId: verdict?.agentId ?? null,
        agentName: agent?.name ?? null,
        agentType: agent?.type ?? null,
        createdAt: verdict?.createdAt ?? null,
        reasoning: verdict?.reasoning ?? null,
        isVeto: verdict ? vetoKeys.has(`${verdict.specialization}:${verdict.agentId}`) : false,
      };
    }),
    vetoes: consensus.vetoes.map((entry) => {
      const agent = resolveAgent(entry.agentId);
      return {
        specialization: entry.specialization,
        verdict: "fail" as const,
        agentId: entry.agentId,
        agentName: agent?.name ?? null,
        agentType: agent?.type ?? null,
        createdAt: entry.createdAt,
        reasoning: entry.reasoning,
      };
    }),
  };
}

function summarizeDashboardQuorumProgress(consensus: ReturnType<typeof buildTicketConsensusReport>): {
  label: string;
  state: "success" | "purple" | "orange" | "red";
  title: string;
  responded: number;
  total: number;
} {
  const responded = consensus.counts.responded;
  const total = consensus.councilSpecializations.length;
  const progressLabel = `${responded}/${total}`;
  const baseTitle = `${progressLabel} responded · ${consensus.counts.pass}/${consensus.requiredPasses} passes required`;

  if (consensus.blockedByVeto) {
    const vetoRoles = consensus.vetoes.map((entry) => entry.specialization).join(", ");
    return {
      label: "VETO ✗",
      state: "red",
      title: vetoRoles ? `${baseTitle} · veto by ${vetoRoles}` : baseTitle,
      responded,
      total,
    };
  }

  if (consensus.governance?.strictReviewerIndependenceApplied && consensus.governance?.reviewerIndependence && !consensus.governance.reviewerIndependence.independenceMet) {
    const duplicateSummary = consensus.governance.reviewerIndependence.duplicateGroups
      .map((group) => group.specializations.join(", "))
      .join("; ");
    return {
      label: `${progressLabel} !`,
      state: "orange",
      title: `${baseTitle} · reviewer independence blocked (${duplicateSummary})`,
      responded,
      total,
    };
  }

  if (consensus.governance?.modelVoterCapApplied && consensus.governance?.modelDiversity && !consensus.governance.modelDiversity.voterCapMet) {
    const overSubscribedModels = consensus.governance.modelDiversity.overSubscribedGroups
      .map((group) => `${group.provider}/${group.model}:${group.totalVoters}/${group.maxVoters}`)
      .join(", ");
    return {
      label: `${progressLabel} !`,
      state: "orange",
      title: `${baseTitle} · model voter cap blocked (${overSubscribedModels})`,
      responded,
      total,
    };
  }

  if (consensus.governance?.strictDiversityApplied && consensus.governance?.modelDiversity && !consensus.governance.modelDiversity.diversityMet) {
    const duplicateModels = consensus.governance.modelDiversity.duplicateGroups
      .map((group) => `${group.provider}/${group.model}`)
      .join(", ");
    return {
      label: `${progressLabel} !`,
      state: "orange",
      title: `${baseTitle} · model diversity blocked (${duplicateModels})`,
      responded,
      total,
    };
  }

  if (consensus.advisoryReady) {
    return {
      label: `${progressLabel} ✓`,
      state: "success",
      title: `${baseTitle} · advisory ready`,
      responded,
      total,
    };
  }

  if (consensus.counts.missing > 0) {
    return {
      label: `${progressLabel} ⏳`,
      state: "purple",
      title: `${baseTitle} · ${consensus.counts.missing} specialization(s) missing`,
      responded,
      total,
    };
  }

  return {
    label: `${progressLabel} !`,
    state: "orange",
    title: `${baseTitle} · additional passes still needed`,
    responded,
    total,
  };
}

// ---------------------------------------------------------------------------
// Simulation / Improvement endpoints
// ---------------------------------------------------------------------------

const DEFAULT_SIMULATION_RESULTS_PATH = ".agora/simulation-results.jsonl";

function simulationResultsPath(deps: DashboardDeps): string {
  const repoRoot = deps.mainRepoPath ?? deps.repoPath;
  return `${repoRoot}/${DEFAULT_SIMULATION_RESULTS_PATH}`;
}

/**
 * GET /api/simulation/runs — all historical simulation runs.
 */
export async function getSimulationRuns(deps: DashboardDeps): Promise<{
  runs: SimulationResult[];
  count: number;
}> {
  const runs = await readResults(simulationResultsPath(deps));
  return { runs, count: runs.length };
}

/**
 * GET /api/simulation/trends — per-dimension trend data across runs.
 */
export async function getSimulationTrends(deps: DashboardDeps): Promise<{
  labels: string[];
  velocity: number[];
  autonomy: number[];
  quality: number[];
  cost: number[];
  composite: number[];
}> {
  const runs = await readResults(simulationResultsPath(deps));

  return {
    labels: runs.map((r) => r.runId),
    velocity: runs.map((r) => r.velocity.avgTimeToResolveMs),
    autonomy: runs.map((r) =>
      (r.autonomy.firstPassSuccessRate + r.autonomy.councilApprovalRate + r.autonomy.mergeSuccessRate) / 3,
    ),
    quality: runs.map((r) =>
      (r.quality.testPassRate + (1 - r.quality.regressionRate) + r.quality.ticketRetrievalPrecision5 + r.quality.codeRetrievalPrecision5) / 4,
    ),
    cost: runs.map((r) => r.cost.avgPayloadCharsPerTicket),
    composite: runs.map((r) => r.compositeScore),
  };
}

/**
 * GET /api/simulation/latest — most recent run result (or null).
 */
export async function getSimulationLatest(deps: DashboardDeps): Promise<SimulationResult | null> {
  const runs = await readResults(simulationResultsPath(deps));
  return runs.length > 0 ? runs[runs.length - 1]! : null;
}

/**
 * GET /api/jobboard — job slots with agent presence and ticket association.
 */
export function getJobBoard(deps: DashboardDeps, loopId?: string) {
  const now = Date.now();
  const TWO_MINUTES = 2 * 60 * 1000;
  const TEN_MINUTES = 10 * 60 * 1000;

  const loops = queries.getDistinctLoops(deps.db, deps.repoId);
  const allSlots = loopId
    ? queries.getJobSlotsByLoop(deps.db, deps.repoId, loopId)
    : queries.getAllJobSlots(deps.db, deps.repoId);

  const slots = allSlots.map((s) => {
    let presence: "online" | "idle" | "offline" | "open" = "open";
    if (s.agentId && s.lastHeartbeat) {
      const age = now - new Date(s.lastHeartbeat).getTime();
      presence = age < TWO_MINUTES ? "online" : age < TEN_MINUTES ? "idle" : "offline";
    }

    const agent = s.agentId ? queries.getAgent(deps.db, s.agentId) : null;

    // Look up ticket title if linked
    let ticket: { ticketId: string; title: string; status: string } | null = null;
    if (s.ticketId) {
      const t = queries.getTicketByTicketId(deps.db, s.ticketId, deps.repoId);
      if (t) ticket = { ticketId: t.ticketId, title: t.title, status: t.status };
    }

    const timeInState = s.updatedAt ? now - new Date(s.updatedAt).getTime() : 0;

    return {
      slotId: s.slotId,
      loopId: s.loopId,
      role: s.role,
      specialization: s.specialization,
      label: s.label,
      status: s.status,
      agent: agent ? { id: agent.id, name: agent.name, model: agent.model, provider: agent.provider } : null,
      presence,
      ticket,
      timeInState,
      lastHeartbeat: s.lastHeartbeat,
      progressNote: s.progressNote,
    };
  });

  return { loops, slots };
}
