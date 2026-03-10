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
  agentId?: string;
  sessionId?: string;
}

const PUBLIC_AGENT_ID = "public";
const PUBLIC_SESSION_ID = "session-public";

type LoggingContext = Pick<AgoraContext, "config" | "db" | "repoId" | "repoPath">;
type MinimalLoggingContext = {
  config: Pick<AgoraConfig, "debugLogging">;
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

    try {
      const result = await handler(input);
      await recordRuntimeEvent(getContext, {
        tool,
        input,
        output: serializeResult(result),
        ...classifyResult(result),
        durationMs: Date.now() - startedAt,
        ...extractActor(input),
      });
      return result;
    } catch (error) {
      await recordRuntimeEvent(getContext, {
        tool,
        input,
        output: error instanceof Error ? error.message : String(error),
        status: "error",
        durationMs: Date.now() - startedAt,
        ...extractActor(input),
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
  }, ctx.config.debugLogging);
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

function classifyResult(result: unknown): Pick<RuntimeEventInput, "status" | "denialReason"> {
  const output = serializeResult(result);
  const parsed = tryParseJson(output);
  const isError = Boolean(result && typeof result === "object" && Reflect.get(result, "isError"));

  if (!isError) {
    if ((parsed && (parsed.stale === true || parsed.state === "stale")) || /\bstale\b/i.test(output)) {
      return { status: "stale" };
    }
    return { status: "success" };
  }

  if (parsed?.denied === true) {
    return {
      status: "denied",
      denialReason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  }

  if ((parsed && (parsed.stale === true || parsed.state === "stale")) || /\bstale\b/i.test(output)) {
    return { status: "stale" };
  }

  return { status: "error" };
}

export function classifyResultForLogging(result: unknown): Pick<RuntimeEventInput, "status" | "denialReason"> {
  return classifyResult(result);
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
