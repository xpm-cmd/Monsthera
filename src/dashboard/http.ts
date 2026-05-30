/**
 * Self-contained HTTP plumbing for the dashboard server: static-file
 * serving, the localhost-only CORS policy, response writers, request-body
 * parsing, and domain-error → HTTP-status mapping.
 *
 * Extracted verbatim from `index.ts` (which had grown past 1600 lines) so
 * the router module can focus on routing. Nothing here depends on the
 * MonstheraContainer or the route table — only Node's http/fs primitives
 * and the shared error taxonomy — which is exactly why these were the safe
 * functions to lift out first. Behavior is unchanged; `index.ts` imports
 * and (for the one public symbol) re-exports them.
 */
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
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

/**
 * Inject the auth token as a <meta> tag inside <head> so the SPA can read it
 * and attach it to every mutating fetch. The token is only meaningful on
 * localhost (the same trust boundary as reading it from stdout), so exposing
 * it inside the HTML we serve to the same origin is acceptable.
 */
export function injectAuthToken(html: string, authToken: string): string {
  const meta = `<meta name="monsthera-auth-token" content="${authToken}">`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `  ${meta}\n</head>`);
  }
  return html;
}

export async function serveStatic(
  publicDir: string,
  pathname: string,
  authToken: string,
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
      if (ext === ".html") {
        const html = injectAuthToken(data.toString("utf8"), authToken);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(html);
      } else {
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      }
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
    const html = injectAuthToken(data.toString("utf8"), authToken);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return true;
  } catch {
    // No index.html exists — let the 404 fallback handle it
    return false;
  }
}

// ─── CORS policy ─────────────────────────────────────────────────────────────

/**
 * Allow only same-origin and localhost-variant browser origins. The dashboard
 * binds to localhost by default; any cross-origin request from a non-localhost
 * page (a hostile rendered Markdown article, an external site exploiting a
 * leaked token, a malicious browser extension) is treated as hostile and gets
 * no `Access-Control-Allow-Origin` header back, so the browser blocks the
 * response.
 *
 * Direct callers without an `Origin` header (curl, fetch from Node tests,
 * native MCP clients) are unaffected because they don't rely on CORS.
 */
export function isAllowedDashboardOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin or non-browser caller
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  } catch {
    return false;
  }
}

export function applyCorsHeaders(res: ServerResponse, origin: string | undefined): void {
  if (origin && isAllowedDashboardOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}

// ─── Response helpers ────────────────────────────────────────────────────────

export function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(data, null, 2));
}

export function errorResponse(res: ServerResponse, status: number, code: string, message: string): void {
  jsonResponse(res, status, { error: code, message });
}

export function corsHeaders(res: ServerResponse, origin: string | undefined): void {
  if (origin && !isAllowedDashboardOrigin(origin)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "FORBIDDEN_ORIGIN", message: "cross-origin requests outside localhost are not allowed" }));
    return;
  }
  res.writeHead(204, {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

export async function parseJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      return { ok: false, message: "Request body too large" };
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return { ok: true, value: {} };
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown };
  } catch {
    return { ok: false, message: "Invalid JSON request body" };
  }
}

// ─── Error mapping ───────────────────────────────────────────────────────────

export function mapErrorToHttp(error: MonstheraError): { status: number; code: string } {
  switch (error.code) {
    case ErrorCode.NOT_FOUND:
      return { status: 404, code: error.code };
    case ErrorCode.VALIDATION_FAILED:
      return { status: 400, code: error.code };
    case ErrorCode.ALREADY_EXISTS:
      return { status: 409, code: error.code };
    case ErrorCode.STATE_TRANSITION_INVALID:
      return { status: 409, code: error.code };
    case ErrorCode.GUARD_FAILED:
      return { status: 422, code: error.code };
    case ErrorCode.PERMISSION_DENIED:
      return { status: 403, code: error.code };
    case ErrorCode.CONCURRENCY_CONFLICT:
      return { status: 409, code: error.code };
    case ErrorCode.STORAGE_ERROR:
      return { status: 500, code: error.code };
    default:
      return { status: 500, code: error.code };
  }
}
