import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { basename } from "node:path";
import { FTS5Backend } from "../search/fts5.js";
import { initDatabase } from "../db/init.js";
import { buildTicketDetailPayload, buildTicketListPayload, buildTicketSummaryPayload } from "../tickets/read-model.js";
import { updateTicketStatusRecord } from "../tickets/service.js";
import { getCommitMessage, getHead, getMainRepoRoot, getRepoRoot, getShortSha, isGitRepo } from "../git/operations.js";
import * as queries from "../db/queries.js";
import type * as schema from "../db/schema.js";
import type { InsightStream } from "../core/insight-stream.js";
import type { TicketQuorumConfig } from "../core/config.js";
import { TicketSeverity, TicketStatus, type TicketStatus as TicketStatusType } from "../../schemas/ticket.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface TicketCliConfig {
  repoPath: string;
  agoraDir: string;
  dbName: string;
  ticketQuorum?: TicketQuorumConfig;
}

interface TicketTransitionPayload {
  ticketId: string;
  previousStatus: string;
  status: string;
}

interface TicketCommitSkippedPayload {
  ticketId: string;
  reason: "not_found" | "not_ready_for_commit";
  status?: string;
}

export interface TicketCommitReconcilePayload {
  commitSha: string;
  commitShortSha: string;
  ticketIds: string[];
  resolved: TicketTransitionPayload[];
  skipped: TicketCommitSkippedPayload[];
}

interface TicketCliContext {
  repoRoot: string;
  repoId: number;
  db: DB;
  sqlite: DatabaseType;
}

interface TicketCliDeps {
  loadContext?: (config: TicketCliConfig, insight: InsightStream) => Promise<TicketCliContext>;
  getHead?: typeof getHead;
  getCommitMessage?: typeof getCommitMessage;
  getShortSha?: typeof getShortSha;
  getTicketByTicketId?: typeof queries.getTicketByTicketId;
  transitionTicket?: (
    ctx: TicketCliContext,
    config: TicketCliConfig,
    insight: InsightStream,
    input: { ticketId: string; comment: string; actorLabel: string },
  ) => ReturnType<typeof updateTicketStatusRecord>;
}

const TICKET_ID_PATTERN = /\bTKT-[A-Za-z0-9]+\b/gi;

export async function cmdTicket(
  config: TicketCliConfig,
  insight: InsightStream,
  args: string[],
  deps: TicketCliDeps = {},
): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || args.includes("--help") || args.includes("-h")) {
    printTicketHelp();
    return;
  }

  const loadContext = deps.loadContext ?? loadTicketCliContext;
  const ctx = await loadContext(config, insight);

  try {
    switch (subcommand) {
      case "summary":
        printTicketOutput(buildTicketSummaryPayload(ctx.db, ctx.repoId), args.includes("--json"), formatTicketSummary);
        return;
      case "list":
        printTicketOutput(buildTicketListPayload(ctx.db, ctx.repoId, parseTicketListFilters(args)), args.includes("--json"), formatTicketList);
        return;
      case "show": {
        const ticketId = args[1];
        if (!ticketId) {
          throw new Error("Usage: agora ticket show <ticket-id> [--json]");
        }
        const payload = buildTicketDetailPayload(ctx.db, ctx.repoId, ticketId);
        if (!payload) {
          throw new Error(`Ticket not found: ${ticketId}`);
        }
        printTicketOutput(payload, args.includes("--json"), formatTicketDetail);
        return;
      }
      case "transition": {
        const ticketId = args[1];
        const targetStatus = args[2];
        if (!ticketId || !targetStatus) {
          throw new Error("Usage: agora ticket transition <ticket-id> <status> [--comment <text>] [--skip-knowledge-capture] [--actor-label <label>] [--json]");
        }

        const parsedStatus = TicketStatus.safeParse(targetStatus);
        if (!parsedStatus.success) {
          throw new Error(`Invalid ticket status: ${targetStatus}`);
        }

        const result = updateTicketStatusRecord({
          db: ctx.db,
          repoId: ctx.repoId,
          repoPath: ctx.repoRoot,
          insight,
          ticketQuorum: config.ticketQuorum,
          system: true,
          actorLabel: getArg(args, "--actor-label") ?? "cli",
          refreshTicketSearch: buildTicketSearchRefresher(ctx.sqlite, ctx.db, ctx.repoId, insight),
          refreshKnowledgeSearch: buildKnowledgeSearchRefresher(ctx.sqlite, ctx.db, insight),
        }, {
          ticketId,
          status: parsedStatus.data as TicketStatusType,
          comment: getArg(args, "--comment"),
          skipKnowledgeCapture: args.includes("--skip-knowledge-capture"),
        });

        if (!result.ok) {
          throw new Error(result.message);
        }

        printTicketOutput(toTicketTransitionPayload(result.data), args.includes("--json"), formatTicketTransition);
        return;
      }
      case "reconcile-commit": {
        const commitSha = getArg(args, "--commit") ?? await (deps.getHead ?? getHead)({ cwd: ctx.repoRoot });
        const commitMessage = await (deps.getCommitMessage ?? getCommitMessage)(commitSha, { cwd: ctx.repoRoot });
        const payload = await reconcileCommitTickets(ctx, config, insight, {
          commitSha,
          commitMessage,
          actorLabel: getArg(args, "--actor-label") ?? "post-commit",
        }, deps);
        printTicketOutput(payload, args.includes("--json"), formatTicketCommitReconcile);
        return;
      }
      default:
        throw new Error(`Unknown ticket subcommand: ${subcommand}`);
    }
  } catch (error) {
    insight.error(error instanceof Error ? error.message : String(error));
    printTicketHelp();
    process.exitCode = 1;
  } finally {
    ctx.sqlite.close();
  }
}

export function formatTicketSummary(summary: ReturnType<typeof buildTicketSummaryPayload>): string {
  const lines = [
    `Total tickets: ${summary.totalCount}`,
    `Open tickets: ${summary.openCount}`,
    "",
    "Status counts:",
    ...formatCountMap(summary.statusCounts),
    "",
    "Severity counts:",
    ...formatCountMap(summary.severityCounts),
  ];

  if (summary.inProgress.length > 0) {
    lines.push("", "In progress:");
    lines.push(...summary.inProgress.map(formatCompactTicket));
  }
  if (summary.inReview.length > 0) {
    lines.push("", "In review:");
    lines.push(...summary.inReview.map(formatCompactTicket));
  }
  if (summary.blocked.length > 0) {
    lines.push("", "Blocked:");
    lines.push(...summary.blocked.map(formatCompactTicket));
  }

  return lines.join("\n");
}

export function formatTicketList(payload: ReturnType<typeof buildTicketListPayload>): string {
  if (payload.tickets.length === 0) return "No matching tickets.";

  return [
    `Tickets: ${payload.count}`,
    ...payload.tickets.map(formatCompactTicket),
  ].join("\n");
}

export function formatTicketDetail(ticket: NonNullable<ReturnType<typeof buildTicketDetailPayload>>): string {
  const lines = [
    `${ticket.ticketId} [${ticket.status}]`,
    ticket.title,
    `Severity: ${ticket.severity} | Priority: ${ticket.priority}`,
    `Creator: ${ticket.creatorAgentId}`,
    `Assignee: ${ticket.assigneeAgentId ?? "unassigned"}`,
    `Resolved by: ${ticket.resolvedByAgentId ?? "-"}`,
    `Commit: ${ticket.commitSha}`,
    `Created: ${ticket.createdAt}`,
    `Updated: ${ticket.updatedAt}`,
  ];

  if (ticket.tags.length > 0) lines.push(`Tags: ${ticket.tags.join(", ")}`);
  if (ticket.affectedPaths.length > 0) lines.push(`Affected paths: ${ticket.affectedPaths.join(", ")}`);
  if (ticket.acceptanceCriteria) lines.push(`Acceptance criteria: ${ticket.acceptanceCriteria}`);

  lines.push("", "Description:", ticket.description);

  if (ticket.dependencies.blocking.length > 0 || ticket.dependencies.blockedBy.length > 0 || ticket.dependencies.relatedTo.length > 0) {
    lines.push("", "Dependencies:");
    if (ticket.dependencies.blocking.length > 0) lines.push(`Blocking: ${ticket.dependencies.blocking.join(", ")}`);
    if (ticket.dependencies.blockedBy.length > 0) lines.push(`Blocked by: ${ticket.dependencies.blockedBy.join(", ")}`);
    if (ticket.dependencies.relatedTo.length > 0) lines.push(`Related to: ${ticket.dependencies.relatedTo.join(", ")}`);
  }

  if (ticket.history.length > 0) {
    lines.push("", "History:");
    lines.push(...ticket.history.map((entry) => (
      `${entry.timestamp} ${entry.fromStatus ?? "null"} -> ${entry.toStatus} by ${entry.agentId}${entry.comment ? ` | ${entry.comment}` : ""}`
    )));
  }

  if (ticket.comments.length > 0) {
    lines.push("", "Comments:");
    lines.push(...ticket.comments.map((entry) => `${entry.createdAt} ${entry.agentId}: ${entry.content}`));
  }

  if (ticket.linkedPatches.length > 0) {
    lines.push("", "Linked patches:");
    lines.push(...ticket.linkedPatches.map((entry) => (
      `${entry.proposalId} [${entry.state}] ${entry.agentId} | ${entry.message}`
    )));
  }

  return lines.join("\n");
}

export function formatTicketTransition(payload: TicketTransitionPayload): string {
  return `${payload.ticketId}: ${payload.previousStatus} -> ${payload.status}`;
}

export function formatTicketCommitReconcile(payload: TicketCommitReconcilePayload): string {
  if (payload.ticketIds.length === 0) {
    return `Commit ${payload.commitShortSha}: no ticket references found.`;
  }

  const lines = [
    `Commit ${payload.commitShortSha}`,
    `Referenced tickets: ${payload.ticketIds.join(", ")}`,
    `Resolved: ${payload.resolved.length}`,
    `Skipped: ${payload.skipped.length}`,
  ];

  if (payload.resolved.length > 0) {
    lines.push("", "Resolved:");
    lines.push(...payload.resolved.map(formatTicketTransition));
  }

  if (payload.skipped.length > 0) {
    lines.push("", "Skipped:");
    lines.push(...payload.skipped.map((entry) => (
      `${entry.ticketId}: ${entry.reason}${entry.status ? ` (${entry.status})` : ""}`
    )));
  }

  return lines.join("\n");
}

function formatCompactTicket(ticket: { ticketId: string; title: string; status: string; severity: string; priority: number; assigneeAgentId: string | null; updatedAt: string }): string {
  return `${ticket.ticketId} [${ticket.status}] ${ticket.title} | ${ticket.severity} | P${ticket.priority} | ${ticket.assigneeAgentId ?? "unassigned"} | ${ticket.updatedAt}`;
}

function formatCountMap(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return ["  (none)"];
  return entries.map(([key, value]) => `  ${key}: ${value}`);
}

function printTicketOutput<T>(payload: T, asJson: boolean, formatter: (payload: T) => string): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(formatter(payload));
}

export function extractTicketIdsFromText(text: string): string[] {
  const seen = new Set<string>();
  const matches = text.match(TICKET_ID_PATTERN) ?? [];
  const ids: string[] = [];

  for (const match of matches) {
    const normalized = `TKT-${match.slice(4).toLowerCase()}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ids.push(normalized);
  }

  return ids;
}

export async function reconcileCommitTickets(
  ctx: TicketCliContext,
  config: TicketCliConfig,
  insight: InsightStream,
  input: { commitSha: string; commitMessage: string; actorLabel: string },
  deps: TicketCliDeps = {},
): Promise<TicketCommitReconcilePayload> {
  const commitShortSha = await (deps.getShortSha ?? getShortSha)(input.commitSha, { cwd: ctx.repoRoot });
  const ticketIds = extractTicketIdsFromText(input.commitMessage);
  const payload: TicketCommitReconcilePayload = {
    commitSha: input.commitSha,
    commitShortSha,
    ticketIds,
    resolved: [],
    skipped: [],
  };

  const getTicketByTicketId = deps.getTicketByTicketId ?? queries.getTicketByTicketId;
  const transitionTicket = deps.transitionTicket ?? defaultTransitionTicket;

  for (const ticketId of ticketIds) {
    const ticket = getTicketByTicketId(ctx.db, ticketId, ctx.repoId);
    if (!ticket) {
      payload.skipped.push({ ticketId, reason: "not_found" });
      continue;
    }
    if (ticket.status !== "ready_for_commit") {
      payload.skipped.push({ ticketId, reason: "not_ready_for_commit", status: ticket.status });
      continue;
    }

    const result = transitionTicket(ctx, config, insight, {
      ticketId,
      comment: `Auto-resolved after commit ${commitShortSha}.`,
      actorLabel: input.actorLabel,
    });

    if (!result.ok) {
      throw new Error(result.message);
    }

    payload.resolved.push(toTicketTransitionPayload(result.data));
  }

  return payload;
}

function parseTicketListFilters(args: string[]) {
  const status = getArg(args, "--status");
  if (status && !TicketStatus.safeParse(status).success) {
    throw new Error(`Invalid ticket status: ${status}`);
  }

  const severity = getArg(args, "--severity");
  if (severity && !TicketSeverity.safeParse(severity).success) {
    throw new Error(`Invalid ticket severity: ${severity}`);
  }

  const limitRaw = getArg(args, "--limit");
  const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : null;
  if (limitRaw && (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100)) {
    throw new Error(`Invalid ticket limit: ${limitRaw}`);
  }

  return {
    status,
    assigneeAgentId: getArg(args, "--assignee"),
    severity,
    creatorAgentId: getArg(args, "--creator"),
    tags: parseTagsArg(getArg(args, "--tags")),
    limit: parsedLimit ?? undefined,
  };
}

async function loadTicketCliContext(config: TicketCliConfig, _insight: InsightStream): Promise<TicketCliContext> {
  if (!(await isGitRepo({ cwd: config.repoPath }))) {
    throw new Error("Not a git repository");
  }

  const repoRoot = await getRepoRoot({ cwd: config.repoPath });
  const mainRepoRoot = await getMainRepoRoot({ cwd: config.repoPath });
  const repoName = basename(repoRoot);
  const { db, sqlite } = initDatabase({ repoPath: mainRepoRoot, agoraDir: config.agoraDir, dbName: config.dbName });
  const { id: repoId } = queries.upsertRepo(db, repoRoot, repoName);
  return { repoRoot, repoId, db, sqlite };
}

function buildTicketSearchRefresher(
  sqlite: DatabaseType,
  db: DB,
  repoId: number,
  insight: InsightStream,
): () => void {
  const fts5 = new FTS5Backend(sqlite, db, (message) => insight.warn(message));
  fts5.initTicketFts();
  return () => fts5.rebuildTicketFts(repoId);
}

function buildKnowledgeSearchRefresher(
  sqlite: DatabaseType,
  db: DB,
  insight: InsightStream,
): (knowledgeIds?: number[]) => void {
  const fts5 = new FTS5Backend(sqlite, db, (message) => insight.warn(message));
  fts5.initKnowledgeFts(sqlite);
  return (knowledgeIds) => {
    if (knowledgeIds && knowledgeIds.length > 0) {
      for (const knowledgeId of knowledgeIds) {
        fts5.upsertKnowledgeFts(sqlite, knowledgeId);
      }
      return;
    }
    fts5.rebuildKnowledgeFts(sqlite);
  };
}

function printTicketHelp(): void {
  console.error("Ticket commands:");
  console.error("  agora ticket summary [--json]");
  console.error("  agora ticket list [--status <status>] [--severity <severity>] [--assignee <agent-id>] [--creator <agent-id>] [--tags a,b] [--limit <n>] [--json]");
  console.error("  agora ticket show <ticket-id> [--json]");
  console.error("  agora ticket transition <ticket-id> <status> [--comment <text>] [--skip-knowledge-capture] [--actor-label <label>] [--json]");
  console.error("  agora ticket reconcile-commit [--commit <sha>] [--actor-label <label>] [--json]");
}

function parseTagsArg(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const tags = raw.split(",").map((tag) => tag.trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

function toTicketTransitionPayload(data: Record<string, unknown>): TicketTransitionPayload {
  if (
    typeof data.ticketId === "string"
    && typeof data.previousStatus === "string"
    && typeof data.status === "string"
  ) {
    return {
      ticketId: data.ticketId,
      previousStatus: data.previousStatus,
      status: data.status,
    };
  }
  throw new Error("Unexpected transition payload shape");
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function defaultTransitionTicket(
  ctx: TicketCliContext,
  config: TicketCliConfig,
  insight: InsightStream,
  input: { ticketId: string; comment: string; actorLabel: string },
): ReturnType<typeof updateTicketStatusRecord> {
  return updateTicketStatusRecord({
    db: ctx.db,
    repoId: ctx.repoId,
    repoPath: ctx.repoRoot,
    insight,
    ticketQuorum: config.ticketQuorum,
    system: true,
    actorLabel: input.actorLabel,
    refreshTicketSearch: buildTicketSearchRefresher(ctx.sqlite, ctx.db, ctx.repoId, insight),
    refreshKnowledgeSearch: buildKnowledgeSearchRefresher(ctx.sqlite, ctx.db, insight),
  }, {
    ticketId: input.ticketId,
    status: "resolved",
    comment: input.comment,
  });
}
