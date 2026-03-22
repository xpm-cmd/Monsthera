import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { AgoraError } from "../core/errors.js";
import type { InstrumentedToolRegistration } from "./runtime-instrumentation.js";
import { classifyResultForLogging, getInstrumentedToolRegistry, normalizeErrorCode } from "./runtime-instrumentation.js";

// Re-export types from canonical location for backward compat
export type { ToolRunnerCallResult, ToolRunnerErrorCode } from "../core/tool-types.js";
import type { ToolRunnerCallResult } from "../core/tool-types.js";

export type RegisteredToolHandler = InstrumentedToolRegistration["handler"];

const DENIED_ERROR_CODES = new Set(["permission_denied", "denied", "rate_limited"]);

export class ToolRunner {
  constructor(private readonly tools = new Map<string, InstrumentedToolRegistration>()) {}

  register(name: string, handler: RegisteredToolHandler, inputSchema: object = {}): void {
    this.tools.set(name, { handler, inputSchema });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  listTools(): string[] {
    return [...this.tools.keys()].sort((a, b) => a.localeCompare(b));
  }

  async callTool(name: string, params: unknown): Promise<ToolRunnerCallResult> {
    const registration = this.tools.get(name);
    if (!registration) {
      return {
        ok: false,
        tool: name,
        errorCode: "tool_not_found",
        message: `Tool not found: ${name}`,
        causeCode: "tool_not_found",
      };
    }

    const validated = validateToolInput(name, registration.inputSchema, params);
    if (!validated.ok) {
      return validated.result;
    }

    try {
      const result = await registration.handler(validated.data);
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



function validateToolInput(
  tool: string,
  inputSchema: object,
  params: unknown,
): { ok: true; data: unknown } | { ok: false; result: ToolRunnerCallResult } {
  const parsed = hasSafeParse(inputSchema)
    ? inputSchema.safeParse(params)
    : z.object(inputSchema as z.ZodRawShape).safeParse(params);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }

  return {
    ok: false,
    result: {
      ok: false,
      tool,
      errorCode: "validation_failed",
      message: `Invalid input for tool ${tool}`,
      causeCode: "validation_failed",
      detail: parsed.error.message,
    },
  };
}

function hasSafeParse(
  inputSchema: object,
): inputSchema is object & { safeParse: (input: unknown) => { success: true; data: unknown } | { success: false; error: { message: string } } } {
  return typeof Reflect.get(inputSchema, "safeParse") === "function";
}
