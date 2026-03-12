import type { ToolRunner, ToolRunnerCallResult } from "../tools/tool-runner.js";
import type {
  WorkflowActor,
  WorkflowItemResult,
  WorkflowResult,
  WorkflowSpec,
  WorkflowStatus,
  WorkflowStepResult,
  WorkflowStepSpec,
  WorkflowStepStatus,
} from "./types.js";

const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;
const FULL_TEMPLATE_PATTERN = /^\{\{\s*([^}]+?)\s*\}\}$/;
const MAX_WORKFLOW_STEPS = 20;

type WorkflowContext = {
  params: Record<string, unknown>;
  steps: Record<string, unknown>;
  last?: unknown;
  item?: unknown;
  itemIndex?: number;
};

type RunnerLike = Pick<ToolRunner, "callTool" | "has">;

type StepCallResult = {
  status: Exclude<WorkflowStepStatus, "skipped" | "partial">;
  input: Record<string, unknown>;
  output?: unknown;
  durationMs: number;
  errorCode?: string;
  message?: string;
};

export async function runWorkflow(
  spec: WorkflowSpec,
  runtime: {
    runner: RunnerLike;
    actor: WorkflowActor;
  },
  params: Record<string, unknown> = {},
): Promise<WorkflowResult> {
  const startedAt = Date.now();
  const effectiveParams = { ...(spec.defaults ?? {}), ...params };
  const missingParams = (spec.requiredParams ?? []).filter((key) => effectiveParams[key] == null);

  if (missingParams.length > 0) {
    return {
      name: spec.name,
      description: spec.description,
      status: "failed",
      params: effectiveParams,
      steps: [],
      outputs: {},
      durationMs: Date.now() - startedAt,
    };
  }

  if (spec.steps.length > MAX_WORKFLOW_STEPS) {
    return {
      name: spec.name,
      description: spec.description,
      status: "failed",
      params: effectiveParams,
      steps: [{
        key: "__workflow__",
        tool: "run_workflow",
        status: "failed",
        durationMs: 0,
        errorCode: "workflow_limit_exceeded",
        message: `Workflow ${spec.name} exceeds the max supported step count of ${MAX_WORKFLOW_STEPS}`,
      }],
      outputs: {},
      durationMs: Date.now() - startedAt,
    };
  }

  const context: WorkflowContext = {
    params: effectiveParams,
    steps: {},
  };
  const steps: WorkflowStepResult[] = [];
  let status: WorkflowStatus = "completed";

  for (const step of spec.steps) {
    const outcome = await executeStep(step, context, runtime);
    steps.push(outcome.stepResult);

    if (outcome.output !== undefined) {
      context.steps[step.key] = outcome.output;
      context.last = outcome.output;
    }

    if (outcome.stepResult.status === "failed") {
      status = "failed";
      break;
    }
    if (outcome.stepResult.status === "partial") {
      status = status === "failed" ? "failed" : "partial";
    }
  }

  return {
    name: spec.name,
    description: spec.description,
    status,
    params: effectiveParams,
    steps,
    outputs: context.steps,
    durationMs: Date.now() - startedAt,
  };
}

async function executeStep(
  step: WorkflowStepSpec,
  context: WorkflowContext,
  runtime: {
    runner: RunnerLike;
    actor: WorkflowActor;
  },
): Promise<{ stepResult: WorkflowStepResult; output?: unknown }> {
  if (step.condition && !evaluateCondition(step.condition, context)) {
    return {
      stepResult: {
        key: step.key,
        tool: step.tool,
        description: step.description,
        status: "skipped",
        durationMs: 0,
        message: `Condition not met: ${step.condition}`,
      },
    };
  }

  if (step.forEach) {
    return executeStepForEach(step, context, runtime);
  }

  const single = await executeSingleCall(step, context, runtime);
  return {
    stepResult: {
      key: step.key,
      tool: step.tool,
      description: step.description,
      status: single.status,
      durationMs: single.durationMs,
      input: single.input,
      output: single.output,
      errorCode: single.errorCode,
      message: single.message,
    },
    output: single.output,
  };
}

async function executeStepForEach(
  step: WorkflowStepSpec,
  context: WorkflowContext,
  runtime: {
    runner: RunnerLike;
    actor: WorkflowActor;
  },
): Promise<{ stepResult: WorkflowStepResult; output?: unknown }> {
  const startedAt = Date.now();
  const collection = resolvePath(step.forEach ?? "", context);
  if (!Array.isArray(collection)) {
    return {
      stepResult: {
        key: step.key,
        tool: step.tool,
        description: step.description,
        status: "failed",
        durationMs: Date.now() - startedAt,
        errorCode: "workflow_invalid_foreach",
        message: `Workflow step ${step.key} expected an array at ${step.forEach}`,
      },
    };
  }

  const items: WorkflowItemResult[] = [];
  const outputs: unknown[] = [];
  let sawFailure = false;

  for (const [index, item] of collection.entries()) {
    const result = await executeSingleCall(step, { ...context, item, itemIndex: index }, runtime);
    items.push({
      index,
      status: result.status,
      input: result.input,
      output: result.output,
      durationMs: result.durationMs,
      errorCode: result.errorCode,
      message: result.message,
    });

    if (result.output !== undefined) {
      outputs.push(result.output);
    }

    if (result.status === "failed") {
      sawFailure = true;
      if ((step.onError ?? "stop") === "stop") {
        return {
          stepResult: {
            key: step.key,
            tool: step.tool,
            description: step.description,
            status: "failed",
            durationMs: Date.now() - startedAt,
            items,
            output: outputs,
            errorCode: result.errorCode,
            message: result.message,
          },
          output: outputs,
        };
      }
    }
  }

  return {
    stepResult: {
      key: step.key,
      tool: step.tool,
      description: step.description,
      status: sawFailure ? "partial" : "completed",
      durationMs: Date.now() - startedAt,
      items,
      output: outputs,
    },
    output: outputs,
  };
}

async function executeSingleCall(
  step: WorkflowStepSpec,
  context: WorkflowContext,
  runtime: {
    runner: RunnerLike;
    actor: WorkflowActor;
  },
): Promise<StepCallResult> {
  const resolvedInput = resolveTemplateValue(step.input, context);
  if (!isRecord(resolvedInput)) {
    return {
      status: "failed",
      input: {},
      durationMs: 0,
      errorCode: "workflow_invalid_input",
      message: `Workflow step ${step.key} did not resolve to an input object`,
    };
  }

  const input = {
    ...resolvedInput,
    agentId: runtime.actor.agentId,
    sessionId: runtime.actor.sessionId,
  };

  const startedAt = Date.now();
  const result = runtime.runner.has(step.tool)
    ? await runtime.runner.callTool(step.tool, input)
    : ({
        ok: false,
        tool: step.tool,
        errorCode: "tool_not_found",
        message: `Tool not found: ${step.tool}`,
      } satisfies ToolRunnerCallResult);

  return normalizeStepCall(result, input, Date.now() - startedAt);
}

function normalizeStepCall(
  result: ToolRunnerCallResult,
  input: Record<string, unknown>,
  durationMs: number,
): StepCallResult {
  if (result.ok) {
    return {
      status: "completed",
      input,
      output: extractStructuredPayload(result.result),
      durationMs,
    };
  }

  return {
    status: "failed",
    input,
    output: result.result === undefined ? undefined : extractStructuredPayload(result.result),
    durationMs,
    errorCode: result.errorCode,
    message: result.message,
  };
}

export function resolveTemplateValue(value: unknown, context: WorkflowContext): unknown {
  if (typeof value === "string") {
    const fullMatch = value.match(FULL_TEMPLATE_PATTERN);
    if (fullMatch) {
      return resolvePath(fullMatch[1] ?? "", context);
    }

    if (!TEMPLATE_PATTERN.test(value)) {
      TEMPLATE_PATTERN.lastIndex = 0;
      return value;
    }

    TEMPLATE_PATTERN.lastIndex = 0;
    return value.replaceAll(TEMPLATE_PATTERN, (_match, path) => stringifyTemplateValue(resolvePath(String(path), context)));
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplateValue(entry, context));
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const resolved = resolveTemplateValue(entry, context);
      if (resolved !== undefined) {
        result[key] = resolved;
      }
    }
    return result;
  }

  return value;
}

export function resolvePath(path: string, context: WorkflowContext): unknown {
  const normalized = path.trim();
  if (!normalized) return undefined;
  const segments = normalized.split(".").filter(Boolean);
  return resolvePathSegments(context, segments);
}

function resolvePathSegments(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return value;
  if (value == null) return undefined;

  const [segment, ...rest] = segments;
  if (!segment) return resolvePathSegments(value, rest);

  if (Array.isArray(value)) {
    if (/^\d+$/.test(segment)) {
      return resolvePathSegments(value[Number(segment)], rest);
    }
    return value
      .map((item) => resolvePathSegments(item, segments))
      .flatMap((item) => (Array.isArray(item) ? item : [item]))
      .filter((item) => item !== undefined);
  }

  if (typeof value === "object") {
    return resolvePathSegments(Reflect.get(value, segment), rest);
  }

  return undefined;
}

export function evaluateCondition(condition: string, context: WorkflowContext): boolean {
  const normalized = condition.trim();
  if (!normalized) return false;
  if (normalized.startsWith("!")) {
    return !Boolean(resolvePath(normalized.slice(1), context));
  }
  return Boolean(resolvePath(normalized, context));
}

export function extractStructuredPayload(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const maybeContent = Reflect.get(result, "content");
  if (!Array.isArray(maybeContent)) {
    return result;
  }

  const text = maybeContent
    .map((entry) => (entry && typeof entry === "object" && typeof Reflect.get(entry, "text") === "string")
      ? String(Reflect.get(entry, "text"))
      : "")
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) return result;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stringifyTemplateValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
