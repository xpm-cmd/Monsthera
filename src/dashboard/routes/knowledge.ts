import type { RouteContext } from "./context.js";
import { jsonResponse, errorResponse, parseJsonBody, mapErrorToHttp } from "../http.js";
import { inspectKnowledgeArticle } from "../../context/insights.js";
import type { KnowledgeArticle } from "../../knowledge/repository.js";
import { MAX_BATCH_ARTICLES } from "../../tools/knowledge-tools.js";

async function enrichKnowledgeArticleForApi(
  article: KnowledgeArticle,
  repoPath: string,
): Promise<Record<string, unknown>> {
  const diagnostics = await inspectKnowledgeArticle(article, { repoPath });
  return {
    ...article,
    diagnostics,
    recommendedFor: diagnostics.recommendedFor,
  };
}

// Knowledge routes: batch operations, slug preview, article CRUD, and listing.
// Route bodies are moved verbatim from the original src/dashboard/index.ts router.
export async function handleKnowledgeRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, pathname, container } = ctx;
  const { searchParams } = ctx.url;
  const knowledgeMatch = pathname.match(/^\/api\/knowledge\/([^/]+)$/);

  // ── /api/knowledge/batch ─────────────────────────────────────────────────
  // Must match BEFORE the /api/knowledge/:id regex, which would otherwise
  // capture "batch" as an article ID.
  if (pathname === "/api/knowledge/batch") {
    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return true;
    }

    if (req.method === "POST") {
      const arr = (body.value as { articles?: unknown }).articles;
      if (!Array.isArray(arr)) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"articles" is required and must be an array`);
        return true;
      }
      if (arr.length === 0) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"articles" must not be empty`);
        return true;
      }
      if (arr.length > MAX_BATCH_ARTICLES) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"articles" accepts at most ${MAX_BATCH_ARTICLES} entries per call (received ${arr.length})`);
        return true;
      }
      const result = await container.knowledgeService.batchCreateArticles(arr);
      jsonResponse(res, 200, result);
      return true;
    }

    if (req.method === "PATCH") {
      const arr = (body.value as { updates?: unknown }).updates;
      if (!Array.isArray(arr)) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"updates" is required and must be an array`);
        return true;
      }
      if (arr.length === 0) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"updates" must not be empty`);
        return true;
      }
      if (arr.length > MAX_BATCH_ARTICLES) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"updates" accepts at most ${MAX_BATCH_ARTICLES} entries per call (received ${arr.length})`);
        return true;
      }
      const result = await container.knowledgeService.batchUpdateArticles(arr);
      jsonResponse(res, 200, result);
      return true;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return true;
  }

  // ── POST /api/knowledge/preview-slug ─────────────────────────────────────
  // Must match BEFORE the /api/knowledge/:id regex, which would otherwise
  // capture "preview-slug" as an article ID.
  if (pathname === "/api/knowledge/preview-slug") {
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return true;
    }
    const raw = (body.value as { title?: unknown }).title;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      errorResponse(res, 400, "VALIDATION_FAILED", `"title" is required and must be a non-empty string`);
      return true;
    }
    const result = await container.knowledgeService.previewSlug(raw);
    if (result.ok) {
      jsonResponse(res, 200, {
        slug: result.value.slug,
        alreadyExists: result.value.alreadyExists,
        conflicts: result.value.conflicts,
      });
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return true;
  }

  // ── /api/knowledge/:id ───────────────────────────────────────────────────
  if (knowledgeMatch) {
    const id = decodeURIComponent(knowledgeMatch[1]!);
    if (!id) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing article ID");
      return true;
    }

    if (req.method === "GET") {
      const result = await container.knowledgeService.getArticle(id);
      if (result.ok) {
        jsonResponse(res, 200, await enrichKnowledgeArticleForApi(result.value, container.config.repoPath));
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
      const result = await container.knowledgeService.updateArticle(id, body.value);
      if (result.ok) {
        jsonResponse(res, 200, result.value);
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return true;
    }

    if (req.method === "DELETE") {
      const result = await container.knowledgeService.deleteArticle(id);
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

  // ── /api/knowledge ───────────────────────────────────────────────────────
  if (pathname === "/api/knowledge") {
    if (req.method === "GET") {
      const category = searchParams.get("category") ?? undefined;
      const result = await container.knowledgeService.listArticles(category);
      if (result.ok) {
        jsonResponse(
          res,
          200,
          await Promise.all(result.value.map((article) => enrichKnowledgeArticleForApi(article, container.config.repoPath))),
        );
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
      const result = await container.knowledgeService.createArticle(body.value);
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
