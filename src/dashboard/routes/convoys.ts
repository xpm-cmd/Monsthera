import type { RouteContext } from "./context.js";
import { jsonResponse, errorResponse, mapErrorToHttp } from "../http.js";
import { buildConvoyDashboardSummary, buildConvoyDetail } from "../convoy-projection.js";
import type { ConvoyId } from "../../core/types.js";

// Convoy routes: dashboard summary and per-convoy detail.
// Route bodies are moved verbatim from the original src/dashboard/index.ts router.
export async function handleConvoysRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, pathname, container } = ctx;
  const convoysListPath = pathname === "/api/convoys";
  const convoyMatch = pathname.match(/^\/api\/convoys\/([^/]+)$/);

  // ── GET /api/convoys ─────────────────────────────────────────────────────
  if (convoysListPath) {
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const result = await buildConvoyDashboardSummary({
      convoyRepo: container.convoyRepo,
      orchestrationRepo: container.orchestrationRepo,
      workService: container.workService,
    });
    if (!result.ok) {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
      return true;
    }
    jsonResponse(res, 200, result.value);
    return true;
  }

  // ── GET /api/convoys/:id ─────────────────────────────────────────────────
  if (convoyMatch) {
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const id = decodeURIComponent(convoyMatch[1]!) as ConvoyId;
    const result = await buildConvoyDetail(id, {
      convoyRepo: container.convoyRepo,
      orchestrationRepo: container.orchestrationRepo,
      workService: container.workService,
    });
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
