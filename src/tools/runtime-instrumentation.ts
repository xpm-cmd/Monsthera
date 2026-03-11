import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgoraContext } from "../core/context.js";
import type { AgoraConfig } from "../core/config.js";
import * as queries from "../db/queries.js";
import { getHead } from "../git/operations.js";
import { logEvent } from "../logging/event-logger.js";

type GetContext = () => Promise<AgoraContext>;
type ToolHandler = (input: unknown) => Promise<unknown>;
type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

interface RuntimeEventInput {
  tool: string;
  input: unknown;
  output: string;
  status: "success" | "error" | "denied" | "stale";
  durationMs: number;
  denialReason?: string;
  errorCode?: string;
  errorDetail?: string;
  agentId?: string;
  sessionId?: string;
}

const PUBLIC_AGENT_ID = "public";
const PUBLIC_SESSION_ID = "session-public";
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_TOOL_LIMIT_PER_MINUTE = 10;
const toolRateWindows = new Map<string, number[]>();

type LoggingContext = Pick<AgoraContext, "config" | "db" | "repoId" | "repoPath">;
type MinimalLoggingContext = {
  config: Pick<AgoraConfig, "debugLogging" | "secretPatterns">;
  db: AgoraContext["db"];
  repoId: number;
  repoPath: string;
};

export function installToolRuntimeInstrumentation(server: McpServer, getContext: GetContext): void {
  const instrumentableServer = server as McpServer & {
    __agoraToolInstrumentationInstalled?: boolean;
    tool: (...args: [string, string, object, ToolHandler]) => unknown;
  };

  if (instrumentableServer.__agoraToolInstrumentationInstalled) return;

  const originalTool = instrumentableServer.tool.bind(server);
  instrumentableServer.tool = ((name: string, description: string, inputSchema: object, handler: ToolHandler) => {
    return originalTool(name, description, inputSchema, instrumentToolHandler(name, getContext, handler));
  }) as typeof instrumentableServer.tool;
  instrumentableServer.__agoraToolInstrumentationInstalled = true;
}

export function instrumentToolHandler(
  tool: string,
  getContext: GetContext,
  handler: ToolHandler,
): ToolHandler {
  return async (input: unknown) => {
    const startedAt = Date.now();
    let ctx: Awaited<ReturnType<GetContext>> | null = null;
    const actor = extractActor(input);

    try {
      ctx = await getContext();
    } catch {
      ctx = null;
    }

    const rateLimit = ctx ? consumeToolRateLimit(ctx.config, tool, actor, startedAt) : null;
    if (rateLimit && !rateLimit.allowed) {
      const limitedResult = buildRateLimitedResult(tool, rateLimit);
      await recordRuntimeEventFromSource(ctx, getContext, {
        tool,
        input,
        output: serializeResult(limitedResult),
        ...classifyResult(limitedResult),
        durationMs: Date.now() - startedAt,
        ...actor,
      });
      return limitedResult;
    }

    try {
      const result = await handler(input);
      await recordRuntimeEventFromSource(ctx, getContext, {
        tool,
        input,
        output: serializeResult(result),
        ...classifyResult(result),
        durationMs: Date.now() - startedAt,
        ...actor,
      });
      return result;
    } catch (error) {
      await recordRuntimeEventFromSource(ctx, getContext, {
        tool,
        input,
        output: error instanceof Error ? error.message : String(error),
        ...classifyThrownError(error),
        durationMs: Date.now() - startedAt,
        ...actor,
      });
      throw error;
    }
  };
}

export async function recordRuntimeEvent(
  getContext: GetContext,
  event: RuntimeEventInput,
): Promise<void> {
  try {
    const ctx = await getContext();
    await recordRuntimeEventWithContext(ctx, event);
  } catch {
    // Telemetry should never break tool execution.
  }
}

export async function recordRuntimeEventWithContext(
  ctx: LoggingContext | MinimalLoggingContext,
  event: RuntimeEventInput,
): Promise<void> {
  const indexState = queries.getIndexState(ctx.db, ctx.repoId);
  const commitScope = indexState?.dbIndexedCommit ?? await getHead({ cwd: ctx.repoPath });

  logEvent(ctx.db, {
    agentId: event.agentId ?? PUBLIC_AGENT_ID,
    sessionId: event.sessionId ?? PUBLIC_SESSION_ID,
    tool: event.tool,
    repoId: String(ctx.repoId),
    commitScope,
    input: safeStringify(event.input),
    output: event.output,
    status: event.status,
    durationMs: event.durationMs,
    denialReason: event.denialReason,
    errorCode: event.errorCode,
    errorDetail: event.errorDetail,
  }, ctx.config.debugLogging, ctx.config.secretPatterns);
}

export function resetToolRateLimitState(): void {
  toolRateWindows.clear();
}

function extractActor(input: unknown): { agentId?: string; sessionId?: string } {
  if (!input || typeof input !== "object") return {};

  const maybeAgentId = Reflect.get(input, "agentId");
  const maybeSessionId = Reflect.get(input, "sessionId");

  return {
    agentId: typeof maybeAgentId === "string" ? maybeAgentId : undefined,
    sessionId: typeof maybeSessionId === "string" ? maybeSessionId : undefined,
  };
}

function serializeResult(result: unknown): string {
  if (result && typeof result === "object") {
    const maybeContent = Reflect.get(result, "content");
    if (Array.isArray(maybeContent)) {
      const text = maybeContent
        .map((entry) => (entry && typeof entry === "object" && typeof Reflect.get(entry, "text") === "string")
          ? String(Reflect.get(entry, "text"))
          : "")
        .filter(Boolean)
        .join("\n");

      if (text) return text;
    }
  }

  return safeStringify(result);
}

function classifyResult(result: unknown): Pick<RuntimeEventInput, "status" | "denialReason" | "errorCode" | "errorDetail"> {
  const output = serializeResult(result);
  const parsed = tryParseJson(output);
  const isError = Boolean(result && typeof result === "object" && Reflect.get(result, "isError"));
  const detail = extractDetail(parsed, output);

  if (!isError) {
    if ((parsed && (parsed.stale === true || parsed.state === "stale")) || /\bstale\b/i.test(output)) {
      return { status: "stale", errorCode: normalizeErrorCode(getStringField(parsed, ["errorCode", "code", "state"]) ?? "stale"), errorDetail: detail };
    }
    return { status: "success" };
  }

  if (parsed?.denied === true) {
    return {
      status: "denied",
      denialReason: getStringField(parsed, ["reason", "error", "message"]) ?? detail,
      errorCode: normalizeErrorCode(getStringField(parsed, ["errorCode", "code"]) ?? "denied"),
      errorDetail: detail,
    };
  }

  if ((parsed && (parsed.stale === true || parsed.state === "stale")) || /\bstale\b/i.test(output)) {
    return {
      status: "stale",
      errorCode: normalizeErrorCode(getStringField(parsed, ["errorCode", "code", "state"]) ?? "stale"),
      errorDetail: detail,
    };
  }

  return {
    status: "error",
    errorCode: normalizeErrorCode(getStringField(parsed, ["errorCode", "code"]) ?? "error"),
    errorDetail: detail,
  };
}

export function classifyResultForLogging(result: unknown): Pick<RuntimeEventInput, "status" | "denialReason" | "errorCode" | "errorDetail"> {
  return classifyResult(result);
}

function classifyThrownError(error: unknown): Pick<RuntimeEventInput, "status" | "errorCode" | "errorDetail"> {
  const detail = error instanceof Error ? error.message : String(error);
  const rawCode = typeof error === "object" && error && typeof Reflect.get(error, "code") === "string"
    ? String(Reflect.get(error, "code"))
    : error instanceof Error && error.name
      ? error.name
      : "error";
  if (/\bstale\b/i.test(detail)) {
    return { status: "stale", errorCode: normalizeErrorCode(rawCode || "stale"), errorDetail: detail };
  }
  return { status: "error", errorCode: normalizeErrorCode(rawCode || "error"), errorDetail: detail };
}

function extractDetail(parsed: Record<string, unknown> | null, fallback: string): string | undefined {
  return getStringField(parsed, ["detail", "details", "reason", "error", "message"]) ?? truncateDetail(fallback);
}

function getStringField(parsed: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!parsed) return undefined;
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) return truncateDetail(value);
  }
  return undefined;
}

function truncateDetail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

function normalizeErrorCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "error";
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

async function recordRuntimeEventFromSource(
  ctx: Awaited<ReturnType<GetContext>> | null,
  getContext: GetContext,
  event: RuntimeEventInput,
): Promise<void> {
  if (ctx) {
    await recordRuntimeEventWithContext(ctx, event);
    return;
  }
  await recordRuntimeEvent(getContext, event);
}

function consumeToolRateLimit(
  config: Partial<AgoraConfig>,
  tool: string,
  actor: { agentId?: string; sessionId?: string },
  now: number,
): { allowed: boolean; limit: number; retryAfterSeconds?: number } {
  const limit = resolveToolRateLimit(config, tool);
  const key = `${tool}:${actor.agentId ?? PUBLIC_AGENT_ID}:${actor.sessionId ?? PUBLIC_SESSION_ID}`;
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const retained = (toolRateWindows.get(key) ?? []).filter((timestamp) => timestamp > windowStart);

  if (retained.length >= limit) {
    if (retained.length > 0) {
      toolRateWindows.set(key, retained);
    } else {
      toolRateWindows.delete(key);
    }
    return {
      allowed: false,
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil((retained[0]! + RATE_LIMIT_WINDOW_MS - now) / 1000)),
    };
  }

  retained.push(now);
  toolRateWindows.set(key, retained);
  return { allowed: true, limit };
}

function resolveToolRateLimit(config: Partial<AgoraConfig>, tool: string): number {
  return config.toolRateLimits?.overrides?.[tool]
    ?? config.toolRateLimits?.defaultPerMinute
    ?? DEFAULT_TOOL_LIMIT_PER_MINUTE;
}

function buildRateLimitedResult(
  tool: string,
  rateLimit: { limit: number; retryAfterSeconds?: number },
): ToolResult {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        denied: true,
        reason: `Rate limit exceeded for ${tool}`,
        errorCode: "rate_limited",
        limitPerMinute: rateLimit.limit,
        retryAfterSeconds: rateLimit.retryAfterSeconds ?? 1,
      }),
    }],
    isError: true,
  };
}
