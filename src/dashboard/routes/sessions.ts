import type { RouteContext } from "./context.js";
import { jsonResponse, errorResponse, mapErrorToHttp } from "../http.js";
import { sessionId } from "../../core/types.js";

// Session routes (Wave D2): the v3 flagship feature's first visual surface.
// Read-only — opening/closing sessions stays with the CLI/MCP lifecycle.
export async function handleSessionsRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, pathname, container } = ctx;
  const sessionsListPath = pathname === "/api/sessions";
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);

  // ── GET /api/sessions ────────────────────────────────────────────────────
  if (sessionsListPath) {
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const result = await container.sessionService.list();
    if (!result.ok) {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
      return true;
    }
    const sessions = [...result.value].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    jsonResponse(res, 200, { sessions });
    return true;
  }

  // ── GET /api/sessions/:id ────────────────────────────────────────────────
  if (sessionMatch) {
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const id = sessionId(decodeURIComponent(sessionMatch[1]!));
    const result = await container.sessionService.get(id);
    if (!result.ok) {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
      return true;
    }
    jsonResponse(res, 200, result.value);
    return true;
  }

  return false;
}
