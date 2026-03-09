import { createServer, type Server, type ServerResponse } from "node:http";
import type { InsightStream } from "../core/insight-stream.js";
import { renderDashboard } from "./html.js";
import {
  getOverview, getAgentsList, getEventLogsList,
  getPatchesList, getNotesList, getKnowledgeList, getPresence, type DashboardDeps,
} from "./api.js";
import { exportToObsidian } from "../export/obsidian.js";

export interface DashboardEvent {
  type: "agent_registered" | "session_changed" | "patch_proposed" | "note_added" | "event_logged" | "index_updated" | "knowledge_stored";
  data: Record<string, unknown>;
}

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

  const server = createServer((req, res) => {
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

      if (path.startsWith("/api/")) {
        const route = path.slice(5);
        const data = routeApi(route, deps);

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

  // Attach SSE broadcaster to the server for external access
  const enhanced = server as Server & { sse: DashboardSSE };
  enhanced.sse = sse;
  return enhanced;
}

function routeApi(route: string, deps: DashboardDeps): unknown {
  switch (route) {
    case "overview": return getOverview(deps);
    case "agents": return getAgentsList(deps);
    case "logs": return getEventLogsList(deps);
    case "patches": return getPatchesList(deps);
    case "notes": return getNotesList(deps);
    case "knowledge": return getKnowledgeList(deps);
    case "presence": return getPresence(deps);
    default: return null;
  }
}
