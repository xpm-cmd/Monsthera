import type { RouteContext } from "./context.js";
import { jsonResponse, errorResponse, mapErrorToHttp } from "../http.js";

// Agent directory routes.
// Route bodies are moved verbatim from the original src/dashboard/index.ts router.
export async function handleAgentsRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, pathname, container } = ctx;
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);

  // ── /api/agents/:id ──────────────────────────────────────────────────────
  if (agentMatch) {
    const id = decodeURIComponent(agentMatch[1]!);
    if (!id) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing agent ID");
      return true;
    }

    if (req.method === "GET") {
      const result = await container.agentsService.getAgent(id);
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

  // ── /api/agents ──────────────────────────────────────────────────────────
  if (pathname === "/api/agents") {
    if (req.method === "GET") {
      const result = await container.agentsService.listAgents();
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
