import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgoraError } from "../core/errors.js";
import { classifyResultForLogging, getInstrumentedToolRegistry } from "./runtime-instrumentation.js";

export type RegisteredToolHandler = (input: unknown) => Promise<unknown>;
export type ToolRunnerErrorCode = "tool_not_found" | "denied" | "execution_failed";

export type ToolRunnerCallResult =
  | {
      ok: true;
      tool: string;
      result: unknown;
    }
  | {
      ok: false;
      tool: string;
      errorCode: ToolRunnerErrorCode;
      message: string;
      result?: unknown;
      causeCode?: string;
      detail?: string;
    };

const DENIED_ERROR_CODES = new Set(["permission_denied", "denied", "rate_limited"]);

export class ToolRunner {
  constructor(private readonly handlers = new Map<string, RegisteredToolHandler>()) {}

  register(name: string, handler: RegisteredToolHandler): void {
    this.handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  listTools(): string[] {
    return [...this.handlers.keys()].sort((a, b) => a.localeCompare(b));
  }

  async callTool(name: string, params: unknown): Promise<ToolRunnerCallResult> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return {
        ok: false,
        tool: name,
        errorCode: "tool_not_found",
        message: `Tool not found: ${name}`,
        causeCode: "tool_not_found",
      };
    }

    try {
      const result = await handler(params);
      const classification = classifyResultForLogging(result);

      if (classification.status === "success") {
        return { ok: true, tool: name, result };
      }

      return {
        ok: false,
        tool: name,
        errorCode: classification.status === "denied" ? "denied" : "execution_failed",
        message: classification.denialReason
          ?? classification.errorDetail
          ?? `Tool ${name} returned ${classification.status}`,
        result,
        causeCode: classification.errorCode,
        detail: classification.errorDetail,
      };
    } catch (error) {
      const normalizedCode = normalizeErrorCode(
        error instanceof AgoraError
          ? error.code
          : typeof error === "object" && error && typeof Reflect.get(error, "code") === "string"
            ? String(Reflect.get(error, "code"))
            : error instanceof Error
              ? error.name
              : "execution_failed",
      );

      return {
        ok: false,
        tool: name,
        errorCode: DENIED_ERROR_CODES.has(normalizedCode) ? "denied" : "execution_failed",
        message: error instanceof Error ? error.message : String(error),
        causeCode: normalizedCode,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

const TOOL_RUNNER = Symbol.for("agora.toolRunner");

export function getToolRunner(server: McpServer): ToolRunner {
  const instrumentableServer = server as McpServer & {
    [TOOL_RUNNER]?: ToolRunner;
  };
  if (!instrumentableServer[TOOL_RUNNER]) {
    instrumentableServer[TOOL_RUNNER] = new ToolRunner(getInstrumentedToolRegistry(server));
  }
  return instrumentableServer[TOOL_RUNNER]!;
}

function normalizeErrorCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "execution_failed";
}
