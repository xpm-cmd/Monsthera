import { createServer, type Server } from "node:http";
import type { InsightStream } from "../core/insight-stream.js";
import { renderDashboard } from "./html.js";
import {
  getOverview, getAgentsList, getEventLogsList,
  getPatchesList, getNotesList, type DashboardDeps,
} from "./api.js";

export function startDashboard(
  deps: DashboardDeps,
  port: number,
  insight: InsightStream,
): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    try {
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderDashboard());
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

  server.listen(port, () => {
    insight.info(`Dashboard: http://localhost:${port}`);
  });

  return server;
}

function routeApi(route: string, deps: DashboardDeps): unknown {
  switch (route) {
    case "overview": return getOverview(deps);
    case "agents": return getAgentsList(deps);
    case "logs": return getEventLogsList(deps);
    case "patches": return getPatchesList(deps);
    case "notes": return getNotesList(deps);
    default: return null;
  }
}
