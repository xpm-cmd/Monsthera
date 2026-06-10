import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MonstheraContainer } from "../core/container.js";
import {
  serveStatic,
  isAllowedDashboardOrigin,
  applyCorsHeaders,
  errorResponse,
  corsHeaders,
} from "./http.js";
import { requireAuth, generateToken } from "./auth.js";
import type { RouteContext } from "./routes/context.js";
import { handleSystemRoutes } from "./routes/system.js";
import { handleOrchestrationRoutes } from "./routes/orchestration.js";
import { handleCodeIntelRoutes } from "./routes/code-intel.js";
import { handleIngestRoutes } from "./routes/ingest.js";
import { handleAgentsRoutes } from "./routes/agents.js";
import { handleKnowledgeRoutes } from "./routes/knowledge.js";
import { handleWorkRoutes } from "./routes/work.js";
import { handleSearchRoutes } from "./routes/search.js";
import { handleConvoysRoutes } from "./routes/convoys.js";
import { handleSessionsRoutes } from "./routes/sessions.js";

// ─── Public interface ────────────────────────────────────────────────────────

export interface DashboardServer {
  readonly port: number;
  readonly authToken: string;
  close(): Promise<void>;
}

// HTTP plumbing (static serving, CORS, response/body helpers, error mapping)
// lives in ./http.ts. Re-export the one symbol that external callers/tests
// import from this module so the public surface is unchanged.
export { isAllowedDashboardOrigin } from "./http.js";

// ─── Router ──────────────────────────────────────────────────────────────────

// Ordered domain route chain. Route bodies live in ./routes/*; each handler
// returns true once it has matched and responded. The order preserves the
// original inline if-order of the monolithic router: system → orchestration →
// code-intel → ingest → agents → knowledge → work → search → convoys
// (convoys was checked last, after search).
const routeChain: ReadonlyArray<(ctx: RouteContext) => Promise<boolean>> = [
  handleSystemRoutes,
  handleOrchestrationRoutes,
  handleCodeIntelRoutes,
  handleIngestRoutes,
  handleAgentsRoutes,
  handleKnowledgeRoutes,
  handleWorkRoutes,
  handleSearchRoutes,
  handleSessionsRoutes,
  handleConvoysRoutes,
];

async function handleRequest(
  container: MonstheraContainer,
  publicDir: string | null,
  authToken: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;

  // Reject browser cross-origin requests early. Origin-less requests
  // (curl, fetch from Node, MCP-style direct clients) are unaffected.
  if (origin && !isAllowedDashboardOrigin(origin)) {
    errorResponse(res, 403, "FORBIDDEN_ORIGIN", "cross-origin requests outside localhost are not allowed");
    return;
  }

  // Echo the allowed origin back for browser CORS, on every response.
  applyCorsHeaders(res, origin);

  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res, origin);
    return;
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);

  // ── Auth gate: mutating API requests require a valid Bearer token ─────
  if (url.pathname.startsWith("/api/") && !requireAuth(req, authToken, url.pathname)) {
    errorResponse(res, 401, "UNAUTHORIZED", "Valid Bearer token required");
    return;
  }
  const { pathname } = url;

  if (
    req.method !== "GET" &&
    (pathname === "/api/health"
      || pathname === "/api/status"
      || pathname === "/api/search"
      || pathname === "/api/search/context-pack"
      || pathname === "/api/structure/graph"
      || pathname === "/api/agents"
      || pathname === "/api/system/runtime"
      || pathname === "/api/events"
      || pathname === "/api/orchestration/wave")
  ) {
    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
  }

  const ctx: RouteContext = { req, res, url, pathname, container };
  for (const handler of routeChain) {
    if (await handler(ctx)) return;
  }

  // ── Static file serving (non-API routes) ─────────────────────────────────
  if (publicDir && !pathname.startsWith("/api/")) {
    const served = await serveStatic(publicDir, pathname, authToken, res);
    if (served) return;
  }

  // ── 404 fallback ─────────────────────────────────────────────────────────
  errorResponse(res, 404, "NOT_FOUND", `Route not found: ${pathname}`);
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

export async function startDashboard(
  container: MonstheraContainer,
  port?: number,
  options?: { publicDir?: string },
): Promise<DashboardServer> {
  const resolvedPort = port ?? container.config.server.port;
  const resolvedHost = container.config.server.host === "localhost"
    ? "127.0.0.1"
    : container.config.server.host;

  // Resolve publicDir: explicit option > default <cwd>/public
  let publicDir: string | null = null;
  if (options?.publicDir) {
    publicDir = path.resolve(options.publicDir);
  } else {
    const defaultPublic = path.resolve(process.cwd(), "public");
    try {
      const s = await stat(defaultPublic);
      if (s.isDirectory()) publicDir = defaultPublic;
    } catch {
      // No public/ directory — skip static serving
    }
  }
  if (publicDir) {
    container.logger.info("Static file serving enabled", { publicDir });
  }

  // Resolve auth token: config > auto-generated
  const authToken = container.config.dashboard.authToken ?? generateToken();
  if (!container.config.dashboard.authToken) {
    container.logger.info("Dashboard auth token auto-generated (set MONSTHERA_DASHBOARD_TOKEN to configure)");
  }

  const server = createServer((req, res) => {
    handleRequest(container, publicDir, authToken, req, res).catch((error) => {
      container.logger.error("Unhandled request error", { error: String(error) });
      if (!res.headersSent) {
        errorResponse(res, 500, "INTERNAL_ERROR", "Internal server error");
      }
    });
  });

  return new Promise<DashboardServer>((resolve, reject) => {
    server.once("error", reject);

    server.listen(resolvedPort, resolvedHost, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : resolvedPort;
      container.logger.info("Dashboard server started", { port: actualPort, host: resolvedHost });

      resolve({
        port: actualPort,
        authToken,
        close() {
          return new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) rejectClose(err);
              else resolveClose();
            });
          });
        },
      });
    });
  });
}
