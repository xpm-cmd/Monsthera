import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MonstheraContainer } from "../core/container.js";
import type { WorkPhase as WorkPhaseType } from "../core/types.js";
import { WorkPhase } from "../core/types.js";
import type { MonstheraError } from "../core/errors.js";
import { ErrorCode } from "../core/errors.js";

const VALID_PHASES = new Set(Object.values(WorkPhase));

// ─── Public interface ────────────────────────────────────────────────────────

export interface DashboardServer {
  readonly port: number;
  close(): Promise<void>;
}

// ─── Response helpers ────────────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data, null, 2));
}

function errorResponse(res: ServerResponse, status: number, code: string, message: string): void {
  jsonResponse(res, status, { error: code, message });
}

function corsHeaders(res: ServerResponse): void {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

// ─── Error mapping ───────────────────────────────────────────────────────────

function mapErrorToHttp(error: MonstheraError): { status: number; code: string } {
  switch (error.code) {
    case ErrorCode.NOT_FOUND:
      return { status: 404, code: error.code };
    case ErrorCode.VALIDATION_FAILED:
      return { status: 400, code: error.code };
    case ErrorCode.STORAGE_ERROR:
      return { status: 500, code: error.code };
    default:
      return { status: 500, code: error.code };
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

async function handleRequest(
  container: MonstheraContainer,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    return;
  }

  // Only GET allowed
  if (req.method !== "GET") {
    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;

  // ── GET /api/status ──────────────────────────────────────────────────────
  if (pathname === "/api/status") {
    const status = container.status.getStatus();
    jsonResponse(res, 200, status);
    return;
  }

  // ── GET /api/knowledge/:id ───────────────────────────────────────────────
  if (pathname.startsWith("/api/knowledge/")) {
    const id = pathname.slice("/api/knowledge/".length);
    if (!id) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing article ID");
      return;
    }
    const result = await container.knowledgeService.getArticle(id);
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return;
  }

  // ── GET /api/knowledge ───────────────────────────────────────────────────
  if (pathname === "/api/knowledge") {
    const category = searchParams.get("category") ?? undefined;
    const result = await container.knowledgeService.listArticles(category);
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return;
  }

  // ── GET /api/work/:id ────────────────────────────────────────────────────
  if (pathname.startsWith("/api/work/")) {
    const id = pathname.slice("/api/work/".length);
    if (!id) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing work article ID");
      return;
    }
    const result = await container.workService.getWork(id);
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return;
  }

  // ── GET /api/work ────────────────────────────────────────────────────────
  if (pathname === "/api/work") {
    const phaseParam = searchParams.get("phase") ?? undefined;
    if (phaseParam && !VALID_PHASES.has(phaseParam as WorkPhaseType)) {
      errorResponse(res, 400, "VALIDATION_FAILED", `Invalid phase "${phaseParam}". Must be one of: ${[...VALID_PHASES].join(", ")}`);
      return;
    }
    const phase = phaseParam as WorkPhaseType | undefined;
    const result = await container.workService.listWork(phase);
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return;
  }

  // ── GET /api/search ──────────────────────────────────────────────────────
  if (pathname === "/api/search") {
    const query = searchParams.get("q");
    if (!query) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing required query parameter: q");
      return;
    }
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const result = await container.searchService.search({ query, limit });
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return;
  }

  // ── 404 fallback ─────────────────────────────────────────────────────────
  errorResponse(res, 404, "NOT_FOUND", `Route not found: ${pathname}`);
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

export async function startDashboard(
  container: MonstheraContainer,
  port?: number,
): Promise<DashboardServer> {
  const resolvedPort = port ?? container.config.server.port;

  const server = createServer((req, res) => {
    handleRequest(container, req, res).catch((error) => {
      container.logger.error("Unhandled request error", { error: String(error) });
      if (!res.headersSent) {
        errorResponse(res, 500, "INTERNAL_ERROR", "Internal server error");
      }
    });
  });

  return new Promise<DashboardServer>((resolve, reject) => {
    server.once("error", reject);

    server.listen(resolvedPort, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : resolvedPort;
      container.logger.info("Dashboard server started", { port: actualPort });

      resolve({
        port: actualPort,
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
