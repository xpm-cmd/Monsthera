import type { RouteContext } from "./context.js";
import { jsonResponse, errorResponse, mapErrorToHttp } from "../http.js";
import type { MonstheraContainer } from "../../core/container.js";
import { inspectKnowledgeArticle, inspectWorkArticle } from "../../context/insights.js";

async function enrichSearchResultsForApi(
  results: Array<{ id: string; title: string; type: "knowledge" | "work"; score: number; snippet: string }>,
  container: MonstheraContainer,
): Promise<Array<Record<string, unknown>>> {
  const enriched: Array<Record<string, unknown>> = [];
  for (const item of results) {
    if (item.type === "knowledge") {
      const articleResult = await container.knowledgeService.getArticle(item.id);
      if (!articleResult.ok) continue;
      const diagnostics = await inspectKnowledgeArticle(articleResult.value, { repoPath: container.config.repoPath });
      enriched.push({
        ...item,
        category: articleResult.value.category,
        updatedAt: articleResult.value.updatedAt,
        sourcePath: articleResult.value.sourcePath,
        codeRefs: articleResult.value.codeRefs,
        diagnostics,
      });
      continue;
    }

    const articleResult = await container.workService.getWork(item.id);
    if (!articleResult.ok) continue;
    const diagnostics = inspectWorkArticle(articleResult.value);
    enriched.push({
      ...item,
      template: articleResult.value.template,
      phase: articleResult.value.phase,
      updatedAt: articleResult.value.updatedAt,
      codeRefs: articleResult.value.codeRefs,
      references: articleResult.value.references,
      diagnostics,
    });
  }
  return enriched;
}

// Search routes: full reindex, context-pack, and hybrid search.
// Route bodies are moved verbatim from the original src/dashboard/index.ts router.
export async function handleSearchRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, pathname, container } = ctx;
  const { searchParams } = ctx.url;
  const searchContextPackPath = pathname === "/api/search/context-pack";

  // ── POST /api/search/reindex ─────────────────────────────────────────────
  if (pathname === "/api/search/reindex") {
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }

    const result = await container.searchService.fullReindex();
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  // ── GET /api/search ──────────────────────────────────────────────────────
  if (searchContextPackPath) {
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const query = searchParams.get("q");
    if (!query) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing required query parameter: q");
      return true;
    }
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const typeParam = searchParams.get("type");
    const modeParam = searchParams.get("mode");
    const result = await container.searchService.buildContextPack({
      query,
      limit,
      type: typeParam ?? undefined,
      mode: modeParam ?? undefined,
    });
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  if (pathname === "/api/search") {
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const query = searchParams.get("q");
    if (!query) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing required query parameter: q");
      return true;
    }
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const result = await container.searchService.search({ query, limit });
    if (result.ok) {
      jsonResponse(res, 200, await enrichSearchResultsForApi(result.value, container));
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  return false;
}
