import type { RouteContext } from "./context.js";
import { jsonResponse, errorResponse, parseJsonBody, mapErrorToHttp } from "../http.js";

// Code-intelligence routes: structure graph and ADR-015 code-ref endpoints.
// Route bodies are moved verbatim from the original src/dashboard/index.ts router.
export async function handleCodeIntelRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, pathname, container } = ctx;
  const { searchParams } = ctx.url;

  // ── GET /api/structure/graph ─────────────────────────────────────────────
  if (pathname === "/api/structure/graph" && req.method === "GET") {
    const result = await container.structureService.getGraph();
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  // ── GET /api/code/ref?path=<path> ────────────────────────────────────────
  // ADR-015 Layer 1 — code-ref intelligence over Monsthera's existing
  // operational corpus. The three GET endpoints stay auth-exempt (same as
  // every other dashboard read) so the SPA, agents, and shell scripts
  // converge on a single deserialiser. POST /api/code/changes carries the
  // diff payload and IS auth-gated by the standard mutating-method rule.
  if (pathname === "/api/code/ref") {
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const ref = searchParams.get("path");
    if (!ref) {
      errorResponse(res, 400, "VALIDATION_FAILED", `Query parameter "path" is required`);
      return true;
    }
    const result = await container.codeIntelligenceService.getCodeRef({ ref });
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  // ── GET /api/code/owners?path=<path> ─────────────────────────────────────
  if (pathname === "/api/code/owners") {
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const ref = searchParams.get("path");
    if (!ref) {
      errorResponse(res, 400, "VALIDATION_FAILED", `Query parameter "path" is required`);
      return true;
    }
    const result = await container.codeIntelligenceService.findCodeOwners({ ref });
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  // ── GET /api/code/impact?path=<path> ─────────────────────────────────────
  if (pathname === "/api/code/impact") {
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const ref = searchParams.get("path");
    if (!ref) {
      errorResponse(res, 400, "VALIDATION_FAILED", `Query parameter "path" is required`);
      return true;
    }
    const result = await container.codeIntelligenceService.analyzeCodeRefImpact({ ref });
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  // ── POST /api/code/changes ───────────────────────────────────────────────
  // Mirrors the `code_detect_changes` MCP tool: callers compute the diff
  // (typically `git diff --name-only`) and POST the resulting paths. The
  // service rejects empty arrays with VALIDATION_FAILED so a misconfigured
  // client cannot silently no-op.
  if (pathname === "/api/code/changes") {
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return true;
    }
    const changed = (body.value as { changed_paths?: unknown }).changed_paths;
    if (!Array.isArray(changed)) {
      errorResponse(res, 400, "VALIDATION_FAILED", `"changed_paths" must be an array of strings`);
      return true;
    }
    if (changed.length === 0) {
      errorResponse(res, 400, "VALIDATION_FAILED", `"changed_paths" must contain at least one path`);
      return true;
    }
    if (changed.some((value) => typeof value !== "string")) {
      errorResponse(res, 400, "VALIDATION_FAILED", `"changed_paths" must be an array of strings`);
      return true;
    }
    const result = await container.codeIntelligenceService.detectChangedCodeRefs({
      changedPaths: changed as string[],
    });
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  return false;
}
