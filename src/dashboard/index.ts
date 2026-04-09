import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MonstheraContainer } from "../core/container.js";
import type { WorkPhase as WorkPhaseType } from "../core/types.js";
import { VALID_PHASES } from "../core/types.js";
import type { MonstheraError } from "../core/errors.js";
import { ErrorCode } from "../core/errors.js";

// ─── Static file serving ────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(
  publicDir: string,
  pathname: string,
  res: ServerResponse,
): Promise<boolean> {
  // Reject directory-traversal attempts
  const resolved = path.resolve(publicDir, pathname.replace(/^\//, ""));
  if (!resolved.startsWith(publicDir)) {
    errorResponse(res, 400, "BAD_REQUEST", "Invalid path");
    return true;
  }

  // Root → index.html
  const filePath = pathname === "/" ? path.join(publicDir, "index.html") : resolved;

  // Try to serve the file
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const data = await readFile(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
      return true;
    }
  } catch {
    // File does not exist — fall through
  }

  // Missing asset with a file extension → real 404 (fail fast, don't serve HTML)
  const ext = path.extname(pathname);
  if (ext) {
    errorResponse(res, 404, "NOT_FOUND", `Asset not found: ${pathname}`);
    return true;
  }

  // Extensionless path (SPA route) → serve index.html
  try {
    const indexPath = path.join(publicDir, "index.html");
    const data = await readFile(indexPath);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
    return true;
  } catch {
    // No index.html exists — let the 404 fallback handle it
    return false;
  }
}

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
  publicDir: string | null,
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

  // ── GET /api/health ──────────────────────────────────────────────────────
  if (pathname === "/api/health") {
    const status = container.status.getStatus();
    const allHealthy = status.subsystems.every((s) => s.healthy);
    jsonResponse(res, allHealthy ? 200 : 503, {
      healthy: allHealthy,
      version: status.version,
      uptime: status.uptime,
      subsystems: status.subsystems,
    });
    return;
  }

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

  // ── Static file serving (non-API routes) ─────────────────────────────────
  if (publicDir && !pathname.startsWith("/api/")) {
    const served = await serveStatic(publicDir, pathname, res);
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

  const server = createServer((req, res) => {
    handleRequest(container, publicDir, req, res).catch((error) => {
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
