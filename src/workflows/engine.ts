import type { ToolRunnerCallResult } from "../core/tool-types.js";
import { CouncilSpecializationId, type CouncilSpecializationId as CouncilSpecialization } from "../../schemas/council.js";
import { GOVERNANCE_ANALYTICAL_SPECIALIZATIONS } from "../../schemas/governance.js";
import { buildConsensusPayload, type ReviewVerdictRecord } from "../tickets/consensus.js";
import type {
  WorkflowItemResult,
  WorkflowResult,
  WorkflowSpec,
  WorkflowStatus,
  WorkflowRuntime,
  WorkflowStepResult,
  WorkflowStepSpec,
  WorkflowStepStatus,
  ReviewerResolution,
} from "./types.js";

const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;
const FULL_TEMPLATE_PATTERN = /^\{\{\s*([^}]+?)\s*\}\}$/;
const MAX_WORKFLOW_STEPS = 20;
const DEFAULT_QUORUM_ROLES = [...GOVERNANCE_ANALYTICAL_SPECIALIZATIONS];
const DEFAULT_QUORUM_POLL_INTERVAL_MS = 2_000;
const MAX_QUORUM_TIMEOUT_MS = 120_000;

type WorkflowContext = {
  params: Record<string, unknown>;
  steps: Record<string, unknown>;
  last?: unknown;
  item?: unknown;
  itemIndex?: number;
};

type StepCallResult = {
  status: Exclude<WorkflowStepStatus, "skipped" | "partial">;
  input: Record<string, unknown>;
  output?: unknown;
  durationMs: number;
  errorCode?: string;
  message?: string;
  retryCount?: number;
};

export async function runWorkflow(
  spec: WorkflowSpec,
  runtime: WorkflowRuntime,
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
      if ((step.onError ?? "stop") === "continue") {
        status = status === "failed" ? "failed" : "partial";
      } else {
        status = "failed";
        break;
      }
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
  runtime: WorkflowRuntime,
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

  if (step.type === "quorum_checkpoint") {
    return executeQuorumCheckpoint(step, context, runtime);
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
      retryCount: single.retryCount,
    },
    output: single.output,
  };
}

async function executeStepForEach(
  step: WorkflowStepSpec,
  context: WorkflowContext,
  runtime: WorkflowRuntime,
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
  runtime: WorkflowRuntime,
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

  const maxRetries = Math.min(step.retries ?? 0, 5);
  const baseDelayMs = step.retryDelayMs ?? 1000;
  const sleep = runtime.sleep ?? defaultSleep;

  let lastResult: StepCallResult | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }

    const startedAt = Date.now();
    const result = runtime.runner.has(step.tool)
      ? await runtime.runner.callTool(step.tool, input)
      : ({
          ok: false,
          tool: step.tool,
          errorCode: "tool_not_found",
          message: `Tool not found: ${step.tool}`,
        } satisfies ToolRunnerCallResult);

    lastResult = normalizeStepCall(result, input, Date.now() - startedAt);

    if (lastResult.status === "completed") {
      if (attempt > 0) lastResult.retryCount = attempt;
      return lastResult;
    }

    // tool_not_found is not retryable
    if (!result.ok && result.errorCode === "tool_not_found") {
      return lastResult;
    }
  }

  if (maxRetries > 0) lastResult!.retryCount = maxRetries;
  return lastResult!;
}

async function executeQuorumCheckpoint(
  step: WorkflowStepSpec,
  context: WorkflowContext,
  runtime: WorkflowRuntime,
): Promise<{ stepResult: WorkflowStepResult; output?: unknown }> {
  const resolvedInput = resolveTemplateValue(step.input, context);
  if (!isRecord(resolvedInput)) {
    return {
      stepResult: {
        key: step.key,
        tool: step.tool,
        description: step.description,
        status: "failed",
        durationMs: 0,
        errorCode: "workflow_invalid_input",
        message: `Workflow step ${step.key} did not resolve to a quorum input object`,
      },
    };
  }

  const parsed = parseQuorumCheckpointInput(step.key, resolvedInput);
  if (!parsed.ok) {
    return {
      stepResult: {
        key: step.key,
        tool: step.tool,
        description: step.description,
        status: "failed",
        durationMs: 0,
        input: resolvedInput,
        errorCode: parsed.errorCode,
        message: parsed.message,
      },
    };
  }

  if (!runtime.loadReviewVerdicts || !runtime.sendCoordination) {
    return {
      stepResult: {
        key: step.key,
        tool: step.tool,
        description: step.description,
        status: "failed",
        durationMs: 0,
        input: resolvedInput,
        errorCode: "workflow_runtime_unavailable",
        message: "Workflow runtime does not provide quorum checkpoint hooks",
      },
    };
  }

  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? defaultSleep;
  const startedAt = now();
  let verdictRows = await runtime.loadReviewVerdicts(parsed.ticketId);
  if (verdictRows === null) {
    return {
      stepResult: {
        key: step.key,
        tool: step.tool,
        description: step.description,
        status: "failed",
        durationMs: now() - startedAt,
        input: resolvedInput,
        errorCode: "workflow_ticket_not_found",
        message: `Ticket not found: ${parsed.ticketId}`,
      },
    };
  }

  const summarizeCheckpoint = (rows: ReviewVerdictRecord[], elapsedMs: number, dispatch: ReviewerResolution[]) => {
    const consensus = buildConsensusPayload(parsed.ticketId, rows, {
      councilSpecializations: parsed.roles,
      requiredPasses: parsed.requiredPasses,
      vetoSpecializations: parsed.roles.filter((role) => role === "architect" || role === "security"),
    });
    const blockedOnQuorum = !consensus.advisoryReady
      && !consensus.blockedByVeto
      && (consensus.counts.pass + consensus.counts.missing) < consensus.requiredPasses;
    const timedOut = elapsedMs >= parsed.timeoutMs;
    const checkpointStatus = consensus.advisoryReady
      ? "ready"
      : consensus.blockedByVeto
        ? "blocked_on_veto"
        : blockedOnQuorum
          ? "blocked_on_quorum"
          : timedOut
            ? "timed_out"
            : "waiting";
    const output = {
      ...consensus,
      roles: parsed.roles,
      timeoutMs: parsed.timeoutMs,
      pollIntervalMs: parsed.pollIntervalMs,
      onFail: parsed.onFail,
      status: checkpointStatus,
      elapsedMs,
      ...(dispatch.length > 0 ? { dispatch } : {}),
    };
    return { consensus, blockedOnQuorum, timedOut, output };
  };

  const initialCheckpoint = summarizeCheckpoint(verdictRows, now() - startedAt, []);
  if (initialCheckpoint.consensus.advisoryReady) {
    return {
      stepResult: {
        key: step.key,
        tool: step.tool,
        description: step.description,
        status: "completed",
        durationMs: now() - startedAt,
        input: resolvedInput,
        output: initialCheckpoint.output,
      },
      output: initialCheckpoint.output,
    };
  }

  // Resolve specializations to concrete reviewers if hook is provided
  let dispatchReport: ReviewerResolution[] = [];
  const rolesNeedingDispatch = initialCheckpoint.consensus.missingSpecializations.length > 0
    ? initialCheckpoint.consensus.missingSpecializations
    : parsed.roles;
  if (runtime.resolveReviewers) {
    if (rolesNeedingDispatch.length > 0) {
      dispatchReport = await runtime.resolveReviewers(rolesNeedingDispatch, parsed.ticketId);

      // Send targeted messages to each resolved agent for unresolved roles only.
      for (const resolved of dispatchReport.filter((r) => r.status === "resolved")) {
        await runtime.sendCoordination({
          ticketId: parsed.ticketId,
          roles: [resolved.specialization],
          workflowName: runtime.workflowName ?? "workflow",
          stepKey: step.key,
          requestedBy: runtime.actor.agentId,
          timeoutSeconds: Math.ceil(parsed.timeoutMs / 1000),
          targetAgentId: resolved.agentId,
        });
      }

      const missingRoles = dispatchReport
        .filter((resolution) => resolution.status === "no_candidate")
        .map((resolution) => resolution.specialization);
      if (missingRoles.length > 0) {
        const status = parsed.onFail === "continue_with_warning" ? "partial" : "failed";
        const blockedOutput = {
          status: "blocked_on_dispatch",
          dispatch: dispatchReport,
          roles: parsed.roles,
          requestedRoles: rolesNeedingDispatch,
          missingRoles,
        };
        return {
          stepResult: {
            key: step.key,
            tool: step.tool,
            description: step.description,
            status,
            durationMs: now() - startedAt,
            input: resolvedInput,
            output: blockedOutput,
            errorCode: status === "failed" ? "workflow_dispatch_blocked" : undefined,
            message: `No active reviewers found for: ${missingRoles.join(", ")}`,
          },
          output: blockedOutput,
        };
      }
    }
  } else if (rolesNeedingDispatch.length > 0) {
    // Fallback: broadcast to all agents
    await runtime.sendCoordination({
      ticketId: parsed.ticketId,
      roles: rolesNeedingDispatch,
      workflowName: runtime.workflowName ?? "workflow",
      stepKey: step.key,
      requestedBy: runtime.actor.agentId,
      timeoutSeconds: Math.ceil(parsed.timeoutMs / 1000),
    });
  }

  while (true) {
    const elapsedMs = now() - startedAt;
    const checkpoint = summarizeCheckpoint(verdictRows, elapsedMs, dispatchReport);
    if (checkpoint.consensus.advisoryReady) {
      return {
        stepResult: {
          key: step.key,
          tool: step.tool,
          description: step.description,
          status: "completed",
          durationMs: elapsedMs,
          input: resolvedInput,
          output: checkpoint.output,
        },
        output: checkpoint.output,
      };
    }

    if (checkpoint.consensus.blockedByVeto || checkpoint.blockedOnQuorum || checkpoint.timedOut) {
      const status = parsed.onFail === "continue_with_warning" ? "partial" : "failed";
      const message = checkpoint.consensus.blockedByVeto
        ? `Workflow step ${step.key} blocked by veto`
        : checkpoint.timedOut
          ? `Workflow step ${step.key} timed out waiting for quorum`
          : `Workflow step ${step.key} cannot reach quorum with current verdicts`;
      return {
        stepResult: {
          key: step.key,
          tool: step.tool,
          description: step.description,
          status,
          durationMs: elapsedMs,
          input: resolvedInput,
          output: checkpoint.output,
          errorCode: status === "failed" ? "workflow_quorum_blocked" : undefined,
          message,
        },
        output: checkpoint.output,
      };
    }

    await sleep(parsed.pollIntervalMs);
    verdictRows = await runtime.loadReviewVerdicts(parsed.ticketId);
    if (verdictRows === null) {
      return {
        stepResult: {
          key: step.key,
          tool: step.tool,
          description: step.description,
          status: "failed",
          durationMs: now() - startedAt,
          input: resolvedInput,
          errorCode: "workflow_ticket_not_found",
          message: `Ticket not found: ${parsed.ticketId}`,
        },
      };
    }
  }
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

  // Support && (all must be truthy) and || (any must be truthy)
  if (normalized.includes("&&")) {
    return normalized.split("&&").every((part) => evaluateCondition(part, context));
  }
  if (normalized.includes("||")) {
    return normalized.split("||").some((part) => evaluateCondition(part, context));
  }

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

function parseQuorumCheckpointInput(
  stepKey: string,
  input: Record<string, unknown>,
): (
  | {
      ok: true;
      ticketId: string;
      roles: CouncilSpecialization[];
      requiredPasses?: number;
      timeoutMs: number;
      pollIntervalMs: number;
      onFail: "block" | "continue_with_warning";
    }
  | {
      ok: false;
      errorCode: string;
      message: string;
    }
) {
  const ticketId = normalizeString(input.ticketId);
  if (!ticketId) {
    return {
      ok: false,
      errorCode: "workflow_invalid_quorum_input",
      message: `Workflow step ${stepKey} requires a ticketId`,
    };
  }

  const requestedRoles = Array.isArray(input.roles) ? input.roles : DEFAULT_QUORUM_ROLES;
  const roles = requestedRoles.flatMap((entry) => {
    const parsed = CouncilSpecializationId.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const uniqueRoles = [...new Set(roles)];
  if (uniqueRoles.length === 0) {
    return {
      ok: false,
      errorCode: "workflow_invalid_quorum_input",
      message: `Workflow step ${stepKey} requires at least one valid council specialization`,
    };
  }

  const timeoutMs = clampTimeoutMs(asNonNegativeInteger(input.timeout));
  if (timeoutMs == null) {
    return {
      ok: false,
      errorCode: "workflow_invalid_quorum_input",
      message: `Workflow step ${stepKey} requires a non-negative timeout in seconds`,
    };
  }

  const requiredPasses = input.requiredPasses == null ? undefined : asPositiveInteger(input.requiredPasses);
  if (input.requiredPasses != null && requiredPasses == null) {
    return {
      ok: false,
      errorCode: "workflow_invalid_quorum_input",
      message: `Workflow step ${stepKey} requires requiredPasses to be a positive integer`,
    };
  }

  const pollIntervalMs = input.pollIntervalMs == null
    ? DEFAULT_QUORUM_POLL_INTERVAL_MS
    : asPositiveInteger(input.pollIntervalMs);
  if (pollIntervalMs == null) {
    return {
      ok: false,
      errorCode: "workflow_invalid_quorum_input",
      message: `Workflow step ${stepKey} requires pollIntervalMs to be a positive integer`,
    };
  }

  const onFail = input.onFail === "continue_with_warning" ? "continue_with_warning" : "block";

  return {
    ok: true,
    ticketId,
    roles: uniqueRoles,
    requiredPasses: requiredPasses ?? undefined,
    timeoutMs,
    pollIntervalMs,
    onFail,
  };
}

function clampTimeoutMs(timeoutSeconds: number | null): number | null {
  if (timeoutSeconds == null) return null;
  return Math.min(timeoutSeconds * 1000, MAX_QUORUM_TIMEOUT_MS);
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim()) && Number(value.trim()) > 0) {
    return Number(value.trim());
  }
  return null;
}

function asNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
