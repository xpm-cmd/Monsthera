import type { RouteContext } from "./context.js";
import { jsonResponse, errorResponse, parseJsonBody, mapErrorToHttp } from "../http.js";

// Ingest routes: local source import.
// Route bodies are moved verbatim from the original src/dashboard/index.ts router.
export async function handleIngestRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, pathname, container } = ctx;

  // ── POST /api/ingest/local ───────────────────────────────────────────────
  if (pathname === "/api/ingest/local") {
    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!body.ok) {
        errorResponse(res, 400, "VALIDATION_FAILED", body.message);
        return true;
      }
      const result = await container.ingestService.importLocal(body.value);
      if (result.ok) {
        jsonResponse(res, 200, result.value);
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return true;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return true;
  }

  return false;
}
