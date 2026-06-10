import type { RouteContext } from "./context.js";
import { jsonResponse, errorResponse, parseJsonBody, mapErrorToHttp } from "../http.js";
import {
  VALID_ORCHESTRATION_EVENT_TYPES,
  type OrchestrationEventType,
} from "../../orchestration/repository.js";
import type { AgentLifecycleDetails } from "../../orchestration/types.js";
import { workId, agentId } from "../../core/types.js";

// Orchestration routes: wave planning/execution and the events feed.
// Route bodies are moved verbatim from the original src/dashboard/index.ts router.
export async function handleOrchestrationRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, pathname, container } = ctx;
  const { searchParams } = ctx.url;
  const orchestrationWavePath = pathname === "/api/orchestration/wave";
  const orchestrationWaveExecutePath = pathname === "/api/orchestration/wave/execute";
  const autoAdvanceOnly = searchParams.get("autoAdvanceOnly") === "1" || searchParams.get("autoAdvanceOnly") === "true";

  // ── GET /api/orchestration/wave ─────────────────────────────────────────
  if (orchestrationWavePath && req.method === "GET") {
    const planResult = await container.orchestrationService.planWave(
      autoAdvanceOnly ? { autoAdvanceOnly: true } : undefined,
    );
    if (!planResult.ok) {
      const { status, code } = mapErrorToHttp(planResult.error);
      errorResponse(res, status, code, planResult.error.message);
      return true;
    }

    const workResult = await container.workService.listWork();
    if (!workResult.ok) {
      const { status, code } = mapErrorToHttp(workResult.error);
      errorResponse(res, status, code, workResult.error.message);
      return true;
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
    return true;
  }

  // ── POST /api/orchestration/wave/execute ────────────────────────────────
  if (orchestrationWaveExecutePath) {
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }

    const planResult = await container.orchestrationService.planWave(
      autoAdvanceOnly ? { autoAdvanceOnly: true } : undefined,
    );
    if (!planResult.ok) {
      const { status, code } = mapErrorToHttp(planResult.error);
      errorResponse(res, status, code, planResult.error.message);
      return true;
    }

    const executionResult = await container.orchestrationService.executeWave(planResult.value);
    if (!executionResult.ok) {
      const { status, code } = mapErrorToHttp(executionResult.error);
      errorResponse(res, status, code, executionResult.error.message);
      return true;
    }

    const workResult = await container.workService.listWork();
    if (!workResult.ok) {
      const { status, code } = mapErrorToHttp(workResult.error);
      errorResponse(res, status, code, workResult.error.message);
      return true;
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
    return true;
  }

  // ── /api/events ──────────────────────────────────────────────────────────
  if (pathname === "/api/events" && req.method === "GET") {
    const typeParam = searchParams.get("type") ?? undefined;
    if (typeParam && !VALID_ORCHESTRATION_EVENT_TYPES.has(typeParam as OrchestrationEventType)) {
      errorResponse(
        res,
        400,
        "VALIDATION_FAILED",
        `Invalid type "${typeParam}". Must be one of: ${[...VALID_ORCHESTRATION_EVENT_TYPES].join(", ")}`,
      );
      return true;
    }
    const limitParam = searchParams.get("limit");
    let limit = 100;
    if (limitParam) {
      const parsed = Number(limitParam);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1000) {
        errorResponse(res, 400, "VALIDATION_FAILED", "limit must be in (0, 1000]");
        return true;
      }
      limit = Math.floor(parsed);
    }
    const widParam = searchParams.get("workId") ?? undefined;
    if (widParam) {
      const result = await container.orchestrationRepo.findByWorkId(workId(widParam));
      if (!result.ok) {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
        return true;
      }
      let filtered = typeParam ? result.value.filter((e) => e.eventType === typeParam) : result.value;
      filtered = [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      jsonResponse(res, 200, { events: filtered });
      return true;
    }
    if (typeParam) {
      const result = await container.orchestrationRepo.findByType(typeParam as OrchestrationEventType);
      if (!result.ok) {
        const { status, code } = mapErrorToHttp(result.error);
        errorResponse(res, status, code, result.error.message);
        return true;
      }
      jsonResponse(res, 200, { events: result.value.slice(0, limit) });
      return true;
    }
    const result = await container.orchestrationRepo.findRecent(limit);
    if (!result.ok) {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
      return true;
    }
    jsonResponse(res, 200, { events: result.value });
    return true;
  }

  // ── POST /api/events/emit ────────────────────────────────────────────────
  if (pathname === "/api/events/emit") {
    if (req.method !== "POST") {
      errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
      return true;
    }
    const body = await parseJsonBody(req);
    if (!body.ok) {
      errorResponse(res, 400, "VALIDATION_FAILED", body.message);
      return true;
    }
    const payload = body.value as Record<string, unknown>;
    const harnessTypes = new Set<string>(["agent_started", "agent_completed", "agent_failed"]);
    const type = typeof payload.type === "string" ? payload.type : "";
    if (!harnessTypes.has(type)) {
      errorResponse(res, 400, "VALIDATION_FAILED", `Invalid type "${type}". /api/events/emit accepts: ${[...harnessTypes].join(", ")}`);
      return true;
    }
    const wid = typeof payload.workId === "string" ? payload.workId : "";
    const role = typeof payload.role === "string" ? payload.role : "";
    const from = typeof payload.from === "string" ? payload.from : "";
    const to = typeof payload.to === "string" ? payload.to : "";
    if (!wid || !role || !from || !to) {
      errorResponse(res, 400, "VALIDATION_FAILED", "workId, role, from, to are required");
      return true;
    }
    const aid = typeof payload.agentId === "string" ? payload.agentId : undefined;
    const errMsg = typeof payload.error === "string" ? payload.error : undefined;
    if (type === "agent_failed" && !errMsg) {
      errorResponse(res, 400, "VALIDATION_FAILED", "error is required when type=agent_failed");
      return true;
    }
    const articleResult = await container.workRepo.findById(wid);
    if (!articleResult.ok) {
      const { status, code } = mapErrorToHttp(articleResult.error);
      errorResponse(res, status, code, `Unknown work article "${wid}"`);
      return true;
    }
    const details: AgentLifecycleDetails = {
      role,
      transition: { from: from as never, to: to as never },
      ...(errMsg ? { error: errMsg } : {}),
    };
    const result = await container.orchestrationRepo.logEvent({
      workId: workId(wid),
      eventType: type as OrchestrationEventType,
      ...(aid ? { agentId: agentId(aid) } : {}),
      details: details as unknown as Record<string, unknown>,
    });
    if (!result.ok) {
      const { status, code } = mapErrorToHttp(result.error);
      errorResponse(res, status, code, result.error.message);
      return true;
    }
    jsonResponse(res, 201, result.value);
    return true;
  }

  return false;
}
