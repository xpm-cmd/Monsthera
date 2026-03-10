import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { InsightStream } from "../core/insight-stream.js";
import { renderDashboard } from "./html.js";
import { cleanupExpiredPayloads } from "../logging/event-logger.js";
import {
  getOverview, getAgentsList, getEventLogsList,
  getPatchesList, getNotesList, getKnowledgeList, getTicketsList, getTicketDetail, getPresence,
  getIndexedFilesMetrics, getTicketMetrics, getAgentTimeline, getTicketTemplates, getSearchDebug,
  type DashboardDeps,
} from "./api.js";
import { exportToObsidian } from "../export/obsidian.js";
import { getDashboardEventsAfter, getLatestDashboardEventId, type DashboardEvent } from "./events.js";
import {
  assignTicketRecord,
  commentTicketRecord,
  createTicketRecord,
  updateTicketStatusRecord,
  type TicketServiceError,
} from "../tickets/service.js";
import { reapStaleSessions } from "../agents/registry.js";
import { classifyResultForLogging, recordRuntimeEventWithContext } from "../tools/runtime-instrumentation.js";

export class DashboardSSE {
  private clients = new Set<ServerResponse>();

  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(":\n\n"); // SSE comment as keepalive
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  broadcast(event: DashboardEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  get connectionCount(): number {
    return this.clients.size;
  }
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Access-Control-Allow-Origin": "http://localhost",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function startDashboard(
  deps: DashboardDeps,
  port: number,
  insight: InsightStream,
): Server & { sse: DashboardSSE } {
  const sse = new DashboardSSE();
  let lastDashboardEventId = getLatestDashboardEventId(deps.db, deps.repoId);
  const poller = setInterval(() => {
    try {
      const events = getDashboardEventsAfter(deps.db, deps.repoId, lastDashboardEventId, 100);
      for (const event of events) {
        lastDashboardEventId = event.id;
        sse.broadcast({ type: event.type, data: event.data });
      }
    } catch (error) {
      insight.warn(`Dashboard event poll failed: ${error}`);
    }
  }, 1000);
  const reaper = setInterval(() => {
    try {
      reapStaleSessions(deps.db);
      cleanupExpiredPayloads(deps.db);
    } catch (error) {
      insight.warn(`Dashboard lifecycle maintenance failed: ${error}`);
    }
  }, 60_000);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return;
    }

    try {
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
        res.end(renderDashboard());
        return;
      }

      // SSE endpoint for real-time events
      if (path === "/api/events") {
        sse.addClient(res);
        return;
      }

      // POST /api/export/obsidian — write knowledge to Obsidian vault
      if (path === "/api/export/obsidian" && req.method === "POST") {
        try {
          const vaultParam = url.searchParams.get("vault") ?? deps.repoPath;
          const result = exportToObsidian({
            vaultPath: vaultParam,
            repoDb: deps.db,
            globalDb: deps.globalDb,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      if (path === "/api/tickets/create" && req.method === "POST") {
        const body = await readJsonBody(req);
        const startedAt = Date.now();
        const result = await createTicketRecord({
          db: deps.db,
          repoId: deps.repoId,
          repoPath: deps.repoPath,
          insight,
          bus: deps.bus,
          refreshTicketSearch: deps.refreshTicketSearch,
        }, {
          title: String(body.title ?? ""),
          description: String(body.description ?? ""),
          severity: String(body.severity ?? "medium"),
          priority: Number(body.priority ?? 5),
          tags: toStringArray(body.tags),
          affectedPaths: toStringArray(body.affectedPaths),
          acceptanceCriteria: body.acceptanceCriteria ? String(body.acceptanceCriteria) : null,
          agentId: String(body.agentId ?? ""),
          sessionId: String(body.sessionId ?? ""),
        });
        await logDashboardMutation(deps, {
          tool: "dashboard.create_ticket",
          input: body,
          result,
          startedAt,
        });
        return writeTicketMutationResult(res, result);
      }

      if (path.startsWith("/api/tickets/") && req.method === "POST") {
        const parts = path.slice("/api/tickets/".length).split("/");
        const [ticketId, action] = parts;
        if (!ticketId || !action) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }

        const body = await readJsonBody(req);

        if (action === "comment") {
          const startedAt = Date.now();
          const result = commentTicketRecord({
            db: deps.db,
            repoId: deps.repoId,
            repoPath: deps.repoPath,
            insight,
            bus: deps.bus,
            refreshTicketSearch: deps.refreshTicketSearch,
          }, {
            ticketId: decodeURIComponent(ticketId),
            content: String(body.content ?? ""),
            agentId: String(body.agentId ?? ""),
            sessionId: String(body.sessionId ?? ""),
          });
          await logDashboardMutation(deps, {
            tool: "dashboard.comment_ticket",
            input: body,
            result,
            startedAt,
          });
          return writeTicketMutationResult(res, result);
        }

        if (action === "assign") {
          const startedAt = Date.now();
          const result = assignTicketRecord({
            db: deps.db,
            repoId: deps.repoId,
            repoPath: deps.repoPath,
            insight,
            bus: deps.bus,
            refreshTicketSearch: deps.refreshTicketSearch,
          }, {
            ticketId: decodeURIComponent(ticketId),
            assigneeAgentId: String(body.assigneeAgentId ?? ""),
            agentId: String(body.agentId ?? ""),
            sessionId: String(body.sessionId ?? ""),
          });
          await logDashboardMutation(deps, {
            tool: "dashboard.assign_ticket",
            input: body,
            result,
            startedAt,
          });
          return writeTicketMutationResult(res, result);
        }

        if (action === "status") {
          const startedAt = Date.now();
          const result = updateTicketStatusRecord({
            db: deps.db,
            repoId: deps.repoId,
            repoPath: deps.repoPath,
            insight,
            bus: deps.bus,
            refreshTicketSearch: deps.refreshTicketSearch,
          }, {
            ticketId: decodeURIComponent(ticketId),
            status: String(body.status ?? "") as Parameters<typeof updateTicketStatusRecord>[1]["status"],
            comment: body.comment ? String(body.comment) : null,
            agentId: String(body.agentId ?? ""),
            sessionId: String(body.sessionId ?? ""),
          });
          await logDashboardMutation(deps, {
            tool: "dashboard.update_ticket_status",
            input: body,
            result,
            startedAt,
          });
          return writeTicketMutationResult(res, result);
        }
      }

      if (path.startsWith("/api/")) {
        const route = path.slice(5);
        const data = await routeApi(route, deps, url);

        if (data === null) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          ...SECURITY_HEADERS,
        });
        res.end(JSON.stringify(data));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      insight.error(`Dashboard error: ${err}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      insight.warn(`Dashboard port ${port} already in use — dashboard disabled`);
    } else {
      insight.error(`Dashboard error: ${err.message}`);
    }
  });

  server.listen(port, () => {
    insight.info(`Dashboard: http://localhost:${port}`);
  });

  server.on("close", () => {
    clearInterval(poller);
    clearInterval(reaper);
  });

  // Attach SSE broadcaster to the server for external access
  const enhanced = server as Server & { sse: DashboardSSE };
  enhanced.sse = sse;
  return enhanced;
}

async function logDashboardMutation(
  deps: DashboardDeps,
  args: {
    tool: string;
    input: Record<string, unknown>;
    result: Awaited<ReturnType<typeof createTicketRecord>> | ReturnType<typeof assignTicketRecord> | ReturnType<typeof commentTicketRecord> | ReturnType<typeof updateTicketStatusRecord>;
    startedAt: number;
  },
): Promise<void> {
  const output = JSON.stringify(args.result.ok ? args.result.data : { error: args.result.message, ...args.result.data });
  await recordRuntimeEventWithContext({
    config: { debugLogging: false, secretPatterns: [] },
    db: deps.db,
    repoId: deps.repoId,
    repoPath: deps.repoPath,
  }, {
    tool: args.tool,
    input: args.input,
    output,
    ...classifyResultForLogging({
      isError: !args.result.ok,
      content: [{ type: "text", text: output }],
    }),
    durationMs: Date.now() - args.startedAt,
    agentId: typeof args.input.agentId === "string" ? args.input.agentId : undefined,
    sessionId: typeof args.input.sessionId === "string" ? args.input.sessionId : undefined,
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((size, item) => size + item.length, 0) > 1024 * 1024) {
      throw new Error("Request body too large");
    }
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function writeTicketMutationResult(
  res: ServerResponse,
  result: Awaited<ReturnType<typeof createTicketRecord>> | ReturnType<typeof assignTicketRecord> | ReturnType<typeof commentTicketRecord> | ReturnType<typeof updateTicketStatusRecord>,
): void {
  if (result.ok) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.data));
    return;
  }

  const statusCode = ticketErrorStatus(result);
  const payload = result.data ? { error: result.message, ...result.data } : { error: result.message };
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function ticketErrorStatus(error: TicketServiceError): number {
  switch (error.code) {
    case "denied":
      return 403;
    case "not_found":
      return 404;
    case "invalid_actor":
    case "invalid_request":
    default:
      return 400;
  }
}

async function routeApi(route: string, deps: DashboardDeps, url: URL): Promise<unknown> {
  if (route.startsWith("tickets/")) {
    if (route === "tickets/metrics") {
      return getTicketMetrics(deps);
    }
    return getTicketDetail(deps, decodeURIComponent(route.slice("tickets/".length)));
  }

  switch (route) {
    case "overview": return getOverview(deps);
    case "agents": return getAgentsList(deps);
    case "agent-timeline": return getAgentTimeline(deps);
    case "logs": return getEventLogsList(deps);
    case "patches": return getPatchesList(deps);
    case "notes": return getNotesList(deps);
    case "knowledge": return getKnowledgeList(deps);
    case "tickets": return getTicketsList(deps);
    case "ticket-templates": return getTicketTemplates(deps);
    case "files": return getIndexedFilesMetrics(deps);
    case "presence": return getPresence(deps);
    case "search/debug": {
      const query = url.searchParams.get("query")?.trim() ?? "";
      const scope = url.searchParams.get("scope")?.trim() ?? undefined;
      const limitRaw = Number(url.searchParams.get("limit") ?? "10");
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.trunc(limitRaw))) : 10;
      if (!query) {
        return { unavailable: true, reason: "Provide a search query." };
      }
      return getSearchDebug(deps, query, { scope, limit });
    }
    case "export/audit": {
      const { exportAuditTrail } = await import("../export/audit.js");
      const format = (url.searchParams.get("format") ?? "json") as "json" | "csv";
      const agentId = url.searchParams.get("agentId") ?? undefined;
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const since = url.searchParams.get("since") ?? undefined;
      const until = url.searchParams.get("until") ?? undefined;
      const limitRaw = Number(url.searchParams.get("limit") ?? "10000");
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10000, Math.trunc(limitRaw))) : 10000;
      return exportAuditTrail({ db: deps.db, format, agentId, sessionId, since, until, limit });
    }
    default: return null;
  }
}
