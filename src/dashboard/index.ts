import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MonstheraContainer } from "../core/container.js";
import type { WorkPhase as WorkPhaseType } from "../core/types.js";
import { VALID_PHASES } from "../core/types.js";
import type { MonstheraError } from "../core/errors.js";
import { ErrorCode } from "../core/errors.js";
import { deriveAgentExperience } from "./agent-experience.js";
import { inspectKnowledgeArticle, inspectWorkArticle } from "../context/insights.js";
import { requireAuth, generateToken } from "./auth.js";
import type { KnowledgeArticle } from "../knowledge/repository.js";
import type { WorkArticle } from "../work/repository.js";
import { MAX_BATCH_ARTICLES } from "../tools/knowledge-tools.js";

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
  readonly authToken: string;
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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

async function parseJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
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

// ─── Error mapping ───────────────────────────────────────────────────────────

function mapErrorToHttp(error: MonstheraError): { status: number; code: string } {
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

// ─── Router ──────────────────────────────────────────────────────────────────

async function handleRequest(
  container: MonstheraContainer,
  publicDir: string | null,
  authToken: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    return;
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);

  // ── Auth gate: mutating API requests require a valid Bearer token ─────
  if (url.pathname.startsWith("/api/") && !requireAuth(req, authToken, url.pathname)) {
    errorResponse(res, 401, "UNAUTHORIZED", "Valid Bearer token required");
    return;
  }
  const { pathname, searchParams } = url;
  const knowledgeMatch = pathname.match(/^\/api\/knowledge\/([^/]+)$/);
  const workMatch = pathname.match(/^\/api\/work\/([^/]+)$/);
  const workAdvanceMatch = pathname.match(/^\/api\/work\/([^/]+)\/advance$/);
  const workEnrichmentMatch = pathname.match(/^\/api\/work\/([^/]+)\/enrichment$/);
  const workReviewersMatch = pathname.match(/^\/api\/work\/([^/]+)\/reviewers$/);
  const workReviewMatch = pathname.match(/^\/api\/work\/([^/]+)\/review$/);
  const workDependenciesMatch = pathname.match(/^\/api\/work\/([^/]+)\/dependencies$/);
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  const orchestrationWavePath = pathname === "/api/orchestration/wave";
  const orchestrationWaveExecutePath = pathname === "/api/orchestration/wave/execute";
  const searchContextPackPath = pathname === "/api/search/context-pack";
  const autoAdvanceOnly = searchParams.get("autoAdvanceOnly") === "1" || searchParams.get("autoAdvanceOnly") === "true";

  if (
    req.method !== "GET" &&
    (pathname === "/api/health"
      || pathname === "/api/status"
      || pathname === "/api/search"
      || searchContextPackPath
      || pathname === "/api/structure/graph"
      || pathname === "/api/agents"
      || pathname === "/api/system/runtime"
      || orchestrationWavePath)
  ) {
    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
  }

  // ── GET /api/health ──────────────────────────────────────────────────────
  if (pathname === "/api/health" && req.method === "GET") {
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
  if (pathname === "/api/status" && req.method === "GET") {
    const status = container.status.getStatus();
    jsonResponse(res, 200, status);
    return;
  }

  // ── GET /api/system/runtime ──────────────────────────────────────────────
  if (pathname === "/api/system/runtime" && req.method === "GET") {
    const status = container.status.getStatus();
    const [
      recentEventsResult,
      workResult,
      knowledgeResult,
      directoryResult,
      waveResult,
    ] = await Promise.all([
      container.orchestrationRepo.findRecent(20),
      container.workService.listWork(),
      container.knowledgeService.listArticles(),
      container.agentsService.listAgents(),
      container.orchestrationService.planWave(),
    ]);
    const recentEvents = recentEventsResult.ok ? recentEventsResult.value : [];
    const storageSubsystem = status.subsystems.find((subsystem) => subsystem.name === "storage");
    const doltHealthSubsystem = status.subsystems.find((subsystem) => subsystem.name === "dolt-health");
    const agentExperience =
      workResult.ok && knowledgeResult.ok && directoryResult.ok && waveResult.ok
        ? deriveAgentExperience({
          workArticles: workResult.value,
          knowledgeCount: knowledgeResult.value.length,
          agentSummary: directoryResult.value.summary,
          status,
          autoAdvanceEnabled: container.config.orchestration.autoAdvance,
          waveSummary: {
            readyCount: waveResult.value.items.length,
            blockedCount: waveResult.value.blockedItems.length,
          },
        })
        : null;

    jsonResponse(res, 200, {
      storage: {
        mode: container.config.storage.doltEnabled ? "markdown+dolt" : "markdown-only",
        markdownRoot: container.config.storage.markdownRoot,
        doltEnabled: container.config.storage.doltEnabled,
        doltHost: container.config.storage.doltHost,
        doltPort: container.config.storage.doltPort,
        doltDatabase: container.config.storage.doltDatabase,
        detail: storageSubsystem?.detail,
        healthy: storageSubsystem?.healthy ?? true,
      },
      search: {
        semanticEnabled: container.config.search.semanticEnabled,
        embeddingProvider: container.config.search.embeddingProvider,
        embeddingModel: container.config.search.embeddingModel,
        alpha: container.config.search.alpha,
        ollamaUrl: container.config.search.ollamaUrl,
      },
      orchestration: {
        autoAdvance: container.config.orchestration.autoAdvance,
        pollIntervalMs: container.config.orchestration.pollIntervalMs,
        maxConcurrentAgents: container.config.orchestration.maxConcurrentAgents,
        running: container.orchestrationService.isRunning,
      },
      server: {
        host: container.config.server.host,
        port: container.config.server.port,
      },
      capabilities: {
        knowledgeCrud: true,
        workCrud: true,
        phaseAdvance: true,
        reviewWorkflow: true,
        agentDirectory: true,
        knowledgeIngest: true,
        searchReindex: true,
        searchAutoSync: true,
        contextPacks: true,
        wavePlanning: true,
        waveExecution: true,
        dashboardApi: true,
        mcpServer: true,
        migrationAvailable: Boolean(container.migrationService),
      },
      integrations: [
        {
          id: "markdown",
          name: "Markdown repository",
          configured: true,
          healthy: true,
          detail: `Source of truth at ${container.config.storage.markdownRoot}`,
        },
        {
          id: "dolt",
          name: "Dolt",
          configured: container.config.storage.doltEnabled,
          healthy: doltHealthSubsystem?.healthy ?? storageSubsystem?.healthy ?? !container.config.storage.doltEnabled,
          detail: container.config.storage.doltEnabled
            ? (doltHealthSubsystem?.detail ?? `Configured at ${container.config.storage.doltHost}:${container.config.storage.doltPort}`)
            : "Disabled",
        },
        {
          id: "ollama",
          name: "Ollama",
          configured: container.config.search.embeddingProvider === "ollama",
          healthy: container.config.search.embeddingProvider === "ollama" ? true : false,
          detail: container.config.search.embeddingProvider === "ollama"
            ? `${container.config.search.embeddingModel} via ${container.config.search.ollamaUrl}`
            : "Not in use",
        },
        {
          id: "local-ingest",
          name: "Local source ingest",
          configured: true,
          healthy: true,
          detail: "Import .md/.txt sources from the local workspace into knowledge articles",
        },
        {
          id: "search-auto-sync",
          name: "Search auto-sync",
          configured: true,
          healthy: true,
          detail: "Normal knowledge/work create, update, delete flows sync search automatically; full reindex is only needed for backfills or recovery.",
        },
        {
          id: "mcp",
          name: "MCP stdio server",
          configured: true,
          healthy: true,
          detail: "Available through `monsthera serve`",
        },
      ],
      security: {
        localFirst: true,
        markdownSourceOfTruth: true,
        reviewGateEnforced: true,
        semanticSearchEnabled: container.config.search.semanticEnabled,
        autoAdvanceEnabled: container.config.orchestration.autoAdvance,
        externalEndpoints: [
          container.config.storage.doltEnabled ? `${container.config.storage.doltHost}:${container.config.storage.doltPort}` : null,
          container.config.search.embeddingProvider === "ollama" ? container.config.search.ollamaUrl : null,
        ].filter(Boolean),
      },
      stats: status.stats ?? {},
      agentExperience,
      recentEvents,
    });
    return;
  }

  // ── GET /api/orchestration/wave ─────────────────────────────────────────
  if (orchestrationWavePath && req.method === "GET") {
    const planResult = await container.orchestrationService.planWave(
      autoAdvanceOnly ? { autoAdvanceOnly: true } : undefined,
    );
    if (!planResult.ok) {
      const { status, code } = mapErrorToHttp(planResult.error);
      errorResponse(res, status, code, planResult.error.message);
      return;
    }

    const workResult = await container.workService.listWork();
    if (!workResult.ok) {
      const { status, code } = mapErrorToHttp(workResult.error);
      errorResponse(res, status, code, workResult.error.message);
      return;
    }

    const workById = new Map(workResult.value.map((article) => [String(article.id), article]));
    const ready = planResult.value.items.map((item) => {
      const article = workById.get(item.workId);
      return {
        workId: item.workId,
        title: article?.title ?? item.workId,
        from: item.from,
        to: item.to,
        template: article?.template,
        priority: article?.priority,
        assignee: article?.assignee,
        updatedAt: article?.updatedAt,
      };
    });
    const blocked = planResult.value.blockedItems.map((item) => {
      const article = workById.get(item.workId);
      return {
        workId: item.workId,
        title: article?.title ?? item.workId,
        phase: article?.phase,
        template: article?.template,
        priority: article?.priority,
        assignee: article?.assignee,
        updatedAt: article?.updatedAt,
        reason: item.reason,
      };
    });

    jsonResponse(res, 200, {
      generatedAt: new Date().toISOString(),
      autoAdvanceOnly,
      autoAdvanceEnabled: container.config.orchestration.autoAdvance,
      running: container.orchestrationService.isRunning,
      ready,
      blocked,
      summary: {
        readyCount: ready.length,
        blockedCount: blocked.length,
      },
    });
    return;
  }

  // ── POST /api/orchestration/wave/execute ────────────────────────────────
  if (orchestrationWaveExecutePath) {
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return;
    }

    const planResult = await container.orchestrationService.planWave(
      autoAdvanceOnly ? { autoAdvanceOnly: true } : undefined,
    );
    if (!planResult.ok) {
      const { status, code } = mapErrorToHttp(planResult.error);
      errorResponse(res, status, code, planResult.error.message);
      return;
    }

    const executionResult = await container.orchestrationService.executeWave(planResult.value);
    if (!executionResult.ok) {
      const { status, code } = mapErrorToHttp(executionResult.error);
      errorResponse(res, status, code, executionResult.error.message);
      return;
    }

    const workResult = await container.workService.listWork();
    if (!workResult.ok) {
      const { status, code } = mapErrorToHttp(workResult.error);
      errorResponse(res, status, code, workResult.error.message);
      return;
    }

    const workById = new Map(workResult.value.map((article) => [String(article.id), article]));
    jsonResponse(res, 200, {
      executedAt: new Date().toISOString(),
      autoAdvanceOnly,
      autoAdvanceEnabled: container.config.orchestration.autoAdvance,
      summary: {
        plannedCount: planResult.value.items.length,
        blockedCount: planResult.value.blockedItems.length,
        advancedCount: executionResult.value.advanced.length,
        failedCount: executionResult.value.failed.length,
      },
      advanced: executionResult.value.advanced.map((item) => ({
        workId: item.workId,
        title: item.article.title,
        from: item.from,
        to: item.to,
        phase: item.article.phase,
      })),
      failed: executionResult.value.failed.map((item) => ({
        ...item,
        title: workById.get(item.workId)?.title ?? item.workId,
      })),
      blocked: planResult.value.blockedItems.map((item) => ({
        ...item,
        title: workById.get(item.workId)?.title ?? item.workId,
      })),
    });
    return;
  }

  // ── GET /api/structure/graph ─────────────────────────────────────────────
  if (pathname === "/api/structure/graph" && req.method === "GET") {
    const result = await container.structureService.getGraph();
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return;
  }

  // ── POST /api/ingest/local ───────────────────────────────────────────────
  if (pathname === "/api/ingest/local") {
    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!body.ok) {
        errorResponse(res, 400, "VALIDATION_FAILED", body.message);
        return;
      }
      const result = await container.ingestService.importLocal(body.value);
      if (result.ok) {
        jsonResponse(res, 200, result.value);
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
  }

  // ── /api/agents/:id ──────────────────────────────────────────────────────
  if (agentMatch) {
    const id = decodeURIComponent(agentMatch[1]!);
    if (!id) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing agent ID");
      return;
    }

    if (req.method === "GET") {
      const result = await container.agentsService.getAgent(id);
      if (result.ok) {
        jsonResponse(res, 200, result.value);
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
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
      return;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
  }

  // ── /api/knowledge/batch ─────────────────────────────────────────────────
  // Must match BEFORE the /api/knowledge/:id regex, which would otherwise
  // capture "batch" as an article ID.
  if (pathname === "/api/knowledge/batch") {
    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return;
    }

    if (req.method === "POST") {
      const arr = (body.value as { articles?: unknown }).articles;
      if (!Array.isArray(arr)) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"articles" is required and must be an array`);
        return;
      }
      if (arr.length === 0) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"articles" must not be empty`);
        return;
      }
      if (arr.length > MAX_BATCH_ARTICLES) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"articles" accepts at most ${MAX_BATCH_ARTICLES} entries per call (received ${arr.length})`);
        return;
      }
      const result = await container.knowledgeService.batchCreateArticles(arr);
      jsonResponse(res, 200, result);
      return;
    }

    if (req.method === "PATCH") {
      const arr = (body.value as { updates?: unknown }).updates;
      if (!Array.isArray(arr)) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"updates" is required and must be an array`);
        return;
      }
      if (arr.length === 0) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"updates" must not be empty`);
        return;
      }
      if (arr.length > MAX_BATCH_ARTICLES) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"updates" accepts at most ${MAX_BATCH_ARTICLES} entries per call (received ${arr.length})`);
        return;
      }
      const result = await container.knowledgeService.batchUpdateArticles(arr);
      jsonResponse(res, 200, result);
      return;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
  }

  // ── POST /api/knowledge/preview-slug ─────────────────────────────────────
  // Must match BEFORE the /api/knowledge/:id regex, which would otherwise
  // capture "preview-slug" as an article ID.
  if (pathname === "/api/knowledge/preview-slug") {
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return;
    }
    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return;
    }
    const raw = (body.value as { title?: unknown }).title;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      errorResponse(res, 400, "VALIDATION_FAILED", `"title" is required and must be a non-empty string`);
      return;
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
    return;
  }

  // ── /api/knowledge/:id ───────────────────────────────────────────────────
  if (knowledgeMatch) {
    const id = decodeURIComponent(knowledgeMatch[1]!);
    if (!id) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing article ID");
      return;
    }

    if (req.method === "GET") {
      const result = await container.knowledgeService.getArticle(id);
      if (result.ok) {
        jsonResponse(res, 200, await enrichKnowledgeArticleForApi(result.value, container.config.repoPath));
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return;
    }

    if (req.method === "PATCH") {
      const body = await parseJsonBody(req);
      if (!body.ok) {
        errorResponse(res, 400, "VALIDATION_FAILED", body.message);
        return;
      }
      const result = await container.knowledgeService.updateArticle(id, body.value);
      if (result.ok) {
        jsonResponse(res, 200, result.value);
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return;
    }

    if (req.method === "DELETE") {
      const result = await container.knowledgeService.deleteArticle(id);
      if (result.ok) {
        jsonResponse(res, 200, { ok: true, id });
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
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
      return;
    }

    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!body.ok) {
        errorResponse(res, 400, "VALIDATION_FAILED", body.message);
        return;
      }
      const result = await container.knowledgeService.createArticle(body.value);
      if (result.ok) {
        jsonResponse(res, 201, result.value);
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
  }

  // ── /api/work/:id/advance ────────────────────────────────────────────────
  if (workAdvanceMatch) {
    const id = decodeURIComponent(workAdvanceMatch[1]!);
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return;
    }

    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return;
    }

    const payload = body.value as { phase?: unknown; reason?: unknown; skipGuard?: unknown };
    const phase = typeof payload.phase === "string" ? payload.phase : "";
    if (!VALID_PHASES.has(phase as WorkPhaseType)) {
      errorResponse(res, 400, "VALIDATION_FAILED", `Invalid phase "${phase}". Must be one of: ${[...VALID_PHASES].join(", ")}`);
      return;
    }

    let reason: string | undefined;
    if (payload.reason !== undefined) {
      if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"reason" must be a non-empty string`);
        return;
      }
      if (payload.reason.length > 1000) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"reason" exceeds maximum length of 1000`);
        return;
      }
      reason = payload.reason;
    }

    let skipGuard: { reason: string } | undefined;
    if (payload.skipGuard !== undefined) {
      if (typeof payload.skipGuard !== "object" || payload.skipGuard === null || Array.isArray(payload.skipGuard)) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"skipGuard" must be an object with a "reason" field`);
        return;
      }
      const sg = payload.skipGuard as Record<string, unknown>;
      const extraKeys = Object.keys(sg).filter((k) => k !== "reason");
      if (extraKeys.length > 0) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"skipGuard" contains unknown keys: ${extraKeys.join(", ")}. Only "reason" is allowed.`);
        return;
      }
      if (typeof sg.reason !== "string" || sg.reason.trim().length === 0) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"skipGuard.reason" is required and must be a non-empty string`);
        return;
      }
      if (sg.reason.length > 1000) {
        errorResponse(res, 400, "VALIDATION_FAILED", `"skipGuard.reason" exceeds maximum length of 1000`);
        return;
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
    return;
  }

  // ── /api/work/:id/enrichment ─────────────────────────────────────────────
  if (workEnrichmentMatch) {
    const id = decodeURIComponent(workEnrichmentMatch[1]!);
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return;
    }

    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return;
    }

    const role = typeof (body.value as { role?: unknown }).role === "string"
      ? (body.value as { role: string }).role
      : "";
    const statusValue = typeof (body.value as { status?: unknown }).status === "string"
      ? (body.value as { status: string }).status
      : "";

    if (statusValue !== "contributed" && statusValue !== "skipped") {
      errorResponse(res, 400, "VALIDATION_FAILED", 'Status must be "contributed" or "skipped"');
      return;
    }

    const result = await container.workService.contributeEnrichment(id, role, statusValue);
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return;
  }

  // ── /api/work/:id/reviewers ──────────────────────────────────────────────
  if (workReviewersMatch) {
    const id = decodeURIComponent(workReviewersMatch[1]!);
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return;
    }

    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return;
    }

    const reviewerAgentId = typeof (body.value as { reviewerAgentId?: unknown }).reviewerAgentId === "string"
      ? (body.value as { reviewerAgentId: string }).reviewerAgentId
      : "";
    if (!reviewerAgentId) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing reviewerAgentId");
      return;
    }

    const result = await container.workService.assignReviewer(id, reviewerAgentId);
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return;
  }

  // ── /api/work/:id/review ─────────────────────────────────────────────────
  if (workReviewMatch) {
    const id = decodeURIComponent(workReviewMatch[1]!);
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return;
    }

    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return;
    }

    const reviewerAgentId = typeof (body.value as { reviewerAgentId?: unknown }).reviewerAgentId === "string"
      ? (body.value as { reviewerAgentId: string }).reviewerAgentId
      : "";
    const reviewStatus = typeof (body.value as { status?: unknown }).status === "string"
      ? (body.value as { status: string }).status
      : "";
    if (reviewStatus !== "approved" && reviewStatus !== "changes-requested") {
      errorResponse(res, 400, "VALIDATION_FAILED", 'Status must be "approved" or "changes-requested"');
      return;
    }

    const result = await container.workService.submitReview(id, reviewerAgentId, reviewStatus);
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return;
  }

  // ── /api/work/:id/dependencies ───────────────────────────────────────────
  if (workDependenciesMatch) {
    const id = decodeURIComponent(workDependenciesMatch[1]!);
    if (req.method !== "POST" && req.method !== "DELETE") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return;
    }

    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return;
    }

    const blockedByIdFromBody = typeof (body.value as { blockedById?: unknown }).blockedById === "string"
      ? (body.value as { blockedById: string }).blockedById
      : "";
    const blockedById = blockedByIdFromBody || searchParams.get("blockedById") || "";
    if (!blockedById) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing blockedById");
      return;
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
    return;
  }

  // ── /api/work/:id ────────────────────────────────────────────────────────
  if (workMatch) {
    const id = decodeURIComponent(workMatch[1]!);
    if (!id) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing work article ID");
      return;
    }

    if (req.method === "GET") {
      const result = await container.workService.getWork(id);
      if (result.ok) {
        jsonResponse(res, 200, enrichWorkArticleForApi(result.value));
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return;
    }

    if (req.method === "PATCH") {
      const body = await parseJsonBody(req);
      if (!body.ok) {
        errorResponse(res, 400, "VALIDATION_FAILED", body.message);
        return;
      }
      const result = await container.workService.updateWork(id, body.value);
      if (result.ok) {
        jsonResponse(res, 200, result.value);
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return;
    }

    if (req.method === "DELETE") {
      const result = await container.workService.deleteWork(id);
      if (result.ok) {
        jsonResponse(res, 200, { ok: true, id });
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
  }

  // ── /api/work ────────────────────────────────────────────────────────────
  if (pathname === "/api/work") {
    if (req.method === "GET") {
      const phaseParam = searchParams.get("phase") ?? undefined;
      if (phaseParam && !VALID_PHASES.has(phaseParam as WorkPhaseType)) {
        errorResponse(res, 400, "VALIDATION_FAILED", `Invalid phase "${phaseParam}". Must be one of: ${[...VALID_PHASES].join(", ")}`);
        return;
      }
      const phase = phaseParam as WorkPhaseType | undefined;
      const result = await container.workService.listWork(phase);
      if (result.ok) {
        jsonResponse(res, 200, result.value.map((article) => enrichWorkArticleForApi(article)));
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return;
    }

    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!body.ok) {
        errorResponse(res, 400, "VALIDATION_FAILED", body.message);
        return;
      }
      const result = await container.workService.createWork(body.value);
      if (result.ok) {
        jsonResponse(res, 201, result.value);
      } else {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
      }
      return;
    }

    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
  }

  // ── POST /api/search/reindex ─────────────────────────────────────────────
  if (pathname === "/api/search/reindex") {
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return;
    }

    const result = await container.searchService.fullReindex();
    if (result.ok) {
      jsonResponse(res, 200, result.value);
    } else {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
    }
    return;
  }

  // ── GET /api/search ──────────────────────────────────────────────────────
  if (searchContextPackPath) {
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return;
    }
    const query = searchParams.get("q");
    if (!query) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing required query parameter: q");
      return;
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
    return;
  }

  if (pathname === "/api/search") {
    if (req.method !== "GET") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return;
    }
    const query = searchParams.get("q");
    if (!query) {
      errorResponse(res, 400, "VALIDATION_FAILED", "Missing required query parameter: q");
      return;
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

  // Resolve auth token: config > auto-generated
  const authToken = container.config.dashboard.authToken ?? generateToken();
  if (!container.config.dashboard.authToken) {
    container.logger.info("Dashboard auth token auto-generated (set MONSTHERA_DASHBOARD_TOKEN to configure)");
  }

  const server = createServer((req, res) => {
    handleRequest(container, publicDir, authToken, req, res).catch((error) => {
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
        authToken,
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
