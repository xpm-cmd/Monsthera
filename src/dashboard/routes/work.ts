import type { RouteContext } from "./context.js";
import { jsonResponse, errorResponse, parseJsonBody, mapErrorToHttp } from "../http.js";
import type { WorkPhase as WorkPhaseType } from "../../core/types.js";
import { VALID_PHASES } from "../../core/types.js";
import { inspectWorkArticle } from "../../context/insights.js";
import type { WorkArticle } from "../../work/repository.js";

function enrichWorkArticleForApi(
  article: WorkArticle,
): Record<string, unknown> {
  const diagnostics = inspectWorkArticle(article);
  return {
    ...article,
    diagnostics,
    recommendedFor: diagnostics.recommendedFor,
  };
}

// Work routes: phase advance, enrichment, reviewers, review, dependencies,
// snapshot diff, article CRUD, and listing.
// Route bodies are moved verbatim from the original src/dashboard/index.ts router.
export async function handleWorkRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, pathname, container } = ctx;
  const { searchParams } = ctx.url;
  const workMatch = pathname.match(/^\/api\/work\/([^/]+)$/);
  const workAdvanceMatch = pathname.match(/^\/api\/work\/([^/]+)\/advance$/);
  const workEnrichmentMatch = pathname.match(/^\/api\/work\/([^/]+)\/enrichment$/);
  const workReviewersMatch = pathname.match(/^\/api\/work\/([^/]+)\/reviewers$/);
  const workReviewMatch = pathname.match(/^\/api\/work\/([^/]+)\/review$/);
  const workDependenciesMatch = pathname.match(/^\/api\/work\/([^/]+)\/dependencies$/);
  const workSnapshotDiffMatch = pathname.match(/^\/api\/work\/([^/]+)\/snapshot-diff$/);

  // ── /api/work/:id/advance ────────────────────────────────────────────────
  if (workAdvanceMatch) {
    const id = decodeURIComponent(workAdvanceMatch[1]!);
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }

    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return true;
    }

    const payload = body.value as { phase?: unknown; reason?: unknown; skipGuard?: unknown };
    const phase = typeof payload.phase === "string" ? payload.phase : "";
    if (!VALID_PHASES.has(phase as WorkPhaseType)) {
      errorResponse(res, 400, "VALIDATION_FAILED", `Invalid phase "${phase}". Must be one of: ${[...VALID_PHASES].join(", ")}`);
      return true;
    }

    let reason: string | undefined;
    if (payload.reason !== undefined) {
      if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"reason" must be a non-empty string`);
        return true;
      }
      if (payload.reason.length > 1000) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"reason" exceeds maximum length of 1000`);
        return true;
      }
      reason = payload.reason;
    }

    let skipGuard: { reason: string } | undefined;
    if (payload.skipGuard !== undefined) {
      if (typeof payload.skipGuard !== "object" || payload.skipGuard === null || Array.isArray(payload.skipGuard)) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"skipGuard" must be an object with a "reason" field`);
        return true;
      }
      const sg = payload.skipGuard as Record<string, unknown>;
      const extraKeys = Object.keys(sg).filter((k) => k !== "reason");
      if (extraKeys.length > 0) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"skipGuard" contains unknown keys: ${extraKeys.join(", ")}. Only "reason" is allowed.`);
        return true;
      }
      if (typeof sg.reason !== "string" || sg.reason.trim().length === 0) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"skipGuard.reason" is required and must be a non-empty string`);
        return true;
      }
      if (sg.reason.length > 1000) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"skipGuard.reason" exceeds maximum length of 1000`);
        return true;
      }
      skipGuard = { reason: sg.reason };
    }

    const options = reason !== undefined || skipGuard !== undefined
      ? { ...(reason !== undefined ? { reason } : {}), ...(skipGuard ? { skipGuard } : {}) }
      : undefined;
    const result = await container.workService.advancePhase(id, phase as WorkPhaseType, options);
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  // ── /api/work/:id/enrichment ─────────────────────────────────────────────
  if (workEnrichmentMatch) {
    const id = decodeURIComponent(workEnrichmentMatch[1]!);
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }

    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return true;
    }

    const role = typeof (body.value as { role?: unknown }).role === "string"
      ? (body.value as { role: string }).role
      : "";
    const statusValue = typeof (body.value as { status?: unknown }).status === "string"
      ? (body.value as { status: string }).status
      : "";

    if (statusValue !== "contributed" && statusValue !== "skipped") {
      errorResponse(res, 400, "VALIDATION_FAILED", 'Status must be "contributed" or "skipped"');
      return true;
    }

    const result = await container.workService.contributeEnrichment(id, role, statusValue);
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  // ── /api/work/:id/reviewers ──────────────────────────────────────────────
  if (workReviewersMatch) {
    const id = decodeURIComponent(workReviewersMatch[1]!);
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }

    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return true;
    }

    const reviewerAgentId = typeof (body.value as { reviewerAgentId?: unknown }).reviewerAgentId === "string"
      ? (body.value as { reviewerAgentId: string }).reviewerAgentId
      : "";
    if (!reviewerAgentId) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing reviewerAgentId");
      return true;
    }

    const result = await container.workService.assignReviewer(id, reviewerAgentId);
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  // ── /api/work/:id/review ─────────────────────────────────────────────────
  if (workReviewMatch) {
    const id = decodeURIComponent(workReviewMatch[1]!);
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }

    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return true;
    }

    const reviewerAgentId = typeof (body.value as { reviewerAgentId?: unknown }).reviewerAgentId === "string"
      ? (body.value as { reviewerAgentId: string }).reviewerAgentId
      : "";
    const reviewStatus = typeof (body.value as { status?: unknown }).status === "string"
      ? (body.value as { status: string }).status
      : "";
    if (reviewStatus !== "approved" && reviewStatus !== "changes-requested") {
      errorResponse(res, 400, "VALIDATION_FAILED", 'Status must be "approved" or "changes-requested"');
      return true;
    }

    const result = await container.workService.submitReview(id, reviewerAgentId, reviewStatus);
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  // ── /api/work/:id/dependencies ───────────────────────────────────────────
  if (workDependenciesMatch) {
    const id = decodeURIComponent(workDependenciesMatch[1]!);
    if (req.method !== "POST" && req.method !== "DELETE") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }

    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return true;
    }

    const blockedByIdFromBody = typeof (body.value as { blockedById?: unknown }).blockedById === "string"
      ? (body.value as { blockedById: string }).blockedById
      : "";
    const blockedById = blockedByIdFromBody || searchParams.get("blockedById") || "";
    if (!blockedById) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing blockedById");
      return true;
    }

    const result = req.method === "POST"
      ? await container.workService.addDependency(id, blockedById)
      : await container.workService.removeDependency(id, blockedById);

    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  // ── /api/work/:id/snapshot-diff ─────────────────────────────────────────
  if (workSnapshotDiffMatch) {
    const id = decodeURIComponent(workSnapshotDiffMatch[1]!);
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const againstParam = searchParams.get("against") ?? undefined;
    const baselineId = againstParam && againstParam.trim().length > 0 ? againstParam : undefined;
    const diffResult = await container.snapshotService.getDiffForWork(id, baselineId);
    if (!diffResult.ok) {
      const { status, code } = mapErrorToHttp(diffResult.error);
      errorResponse(res, status, code, diffResult.error.message);
      return true;
    }
    if (!diffResult.value) {
      errorResponse(res, 404, "NOT_FOUND", `No snapshot recorded for work id "${id}"`);
      return true;
    }
    jsonResponse(res, 200, diffResult.value);
    return true;
  }

  // ── /api/work/:id ────────────────────────────────────────────────────────
  if (workMatch) {
    const id = decodeURIComponent(workMatch[1]!);
    if (!id) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing work article ID");
      return true;
    }

    if (req.method === "GET") {
      const result = await container.workService.getWork(id);
      if (result.ok) {
        jsonResponse(res, 200, enrichWorkArticleForApi(result.value));
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return true;
    }

    if (req.method === "PATCH") {
      const body = await parseJsonBody(req);
      if (!body.ok) {
        errorResponse(res, 400, "VALIDATION_FAILED", body.message);
        return true;
      }
      const result = await container.workService.updateWork(id, body.value);
      if (result.ok) {
        jsonResponse(res, 200, result.value);
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return true;
    }

    if (req.method === "DELETE") {
      const result = await container.workService.deleteWork(id);
      if (result.ok) {
        jsonResponse(res, 200, { ok: true, id });
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return true;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return true;
  }

  // ── /api/work ────────────────────────────────────────────────────────────
  if (pathname === "/api/work") {
    if (req.method === "GET") {
      const phaseParam = searchParams.get("phase") ?? undefined;
      if (phaseParam && !VALID_PHASES.has(phaseParam as WorkPhaseType)) {
        errorResponse(res, 400, "VALIDATION_FAILED", `Invalid phase "${phaseParam}". Must be one of: ${[...VALID_PHASES].join(", ")}`);
        return true;
      }
      const phase = phaseParam as WorkPhaseType | undefined;
      const result = await container.workService.listWork(phase);
      if (result.ok) {
        jsonResponse(res, 200, result.value.map((article) => enrichWorkArticleForApi(article)));
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return true;
    }

    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!body.ok) {
        errorResponse(res, 400, "VALIDATION_FAILED", body.message);
        return true;
      }
      const result = await container.workService.createWork(body.value);
      if (result.ok) {
        jsonResponse(res, 201, result.value);
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
