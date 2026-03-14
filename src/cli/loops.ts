import { setTimeout as sleepTimeout } from "node:timers/promises";
import { CouncilSpecializationId, type CouncilSpecializationId as CouncilSpecialization } from "../../schemas/council.js";
import type { AgoraConfig } from "../core/config.js";
import type { AgoraContext } from "../core/context.js";
import { createAgoraContextLoader } from "../core/context-loader.js";
import type { InsightStream } from "../core/insight-stream.js";
import { loadRepoAgentCatalog } from "../repo-agents/catalog.js";
import { createAgoraServer } from "../server.js";
import { getToolRunner, type ToolRunner, type ToolRunnerCallResult } from "../tools/tool-runner.js";

type LoopCommand = "plan" | "dev" | "council";
type LoopRole = "facilitator" | "developer" | "reviewer";
type WatchStopReason = "signal" | "max_runs" | "workflow_failed";
type WorkflowPrintReason = "initial" | "changed" | "review_request" | "in_review_queue" | "technical_analysis_queue";
type PlannerAutonomousActionReason = Extract<WorkflowPrintReason, "in_review_queue" | "technical_analysis_queue">;

interface LoopSpec {
  workflowName: string;
  role: LoopRole;
  defaultAgentName: string;
}

interface RegisteredLoopAgent {
  agentId: string;
  sessionId: string;
  role: string;
  resumed?: boolean;
}

interface LoopAgentPayload {
  name: string;
  agentId: string;
  sessionId: string;
  role: string;
  resumed: boolean;
}

interface LoopInvocation {
  workflowParams: Record<string, unknown>;
  councilQueueWatch: boolean;
  queueLimit: number;
  councilSpecialization?: CouncilSpecialization;
}

interface LoopWatchOptions {
  enabled: boolean;
  intervalMs: number;
  maxRuns?: number;
}

interface CoordinationMessageRecord {
  id: string;
  from: string;
  to: string | null;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

interface CoordinationPollPayload {
  topology: string | null;
  count: number;
  messages: CoordinationMessageRecord[];
}

interface WorkflowExecution {
  call: ToolRunnerCallResult;
  payload: unknown;
}

interface CouncilRequestContext {
  messageId: string;
  sourceAgentId: string;
  ticketId: string;
  transition: string | null;
  requestedRoles: CouncilSpecialization[];
}

interface QueueTicketSummary {
  ticketId: string;
  title?: string;
  status?: string;
  priority?: number;
  severity?: string;
}

interface PlannerAutonomousAction {
  workflowName: "ta-review" | "deep-review-v2";
  params: Record<string, unknown>;
  queueTicket: QueueTicketSummary;
  reason: PlannerAutonomousActionReason;
}

interface DeveloperAutoTakeCandidate {
  ticketId: string;
  affectedPaths: string[];
}

export interface LoopExecutionPayload {
  loop: LoopCommand;
  workflowName: string;
  agent: LoopAgentPayload;
  result: unknown;
}

export interface LoopCliDeps {
  createServer?: typeof createAgoraServer;
  getRunner?: (server: ReturnType<typeof createAgoraServer>) => ToolRunner;
  createContextLoader?: typeof createAgoraContextLoader;
  sleep?: (ms: number) => Promise<void>;
}

const LOOP_SPECS: Record<LoopCommand, LoopSpec> = {
  plan: {
    workflowName: "planner-loop",
    role: "facilitator",
    defaultAgentName: "Planner Loop Facilitator",
  },
  dev: {
    workflowName: "developer-loop",
    role: "developer",
    defaultAgentName: "Developer Loop",
  },
  council: {
    workflowName: "council-loop",
    role: "reviewer",
    defaultAgentName: "Council Loop Reviewer",
  },
};

const COUNCIL_TRANSITIONS = new Set([
  "technical_analysis→approved",
  "in_review→ready_for_commit",
]);

const COUNCIL_TARGET_STATUS: Record<string, string> = {
  "technical_analysis→approved": "approved",
  "in_review→ready_for_commit": "ready_for_commit",
};

const DEFAULT_WATCH_INTERVAL_MS = 30_000;
const DEFAULT_QUEUE_LIMIT = 5;
const AUTONOMOUS_QUEUE_TIMEOUT_SECONDS = 5;
const VOLATILE_RESULT_KEYS = new Set(["durationMs", "elapsedMs"]);

export async function cmdLoop(
  config: AgoraConfig,
  insight: InsightStream,
  args: string[],
  deps: LoopCliDeps = {},
): Promise<void> {
  const rawCommand = args[0];
  if (!rawCommand || rawCommand === "help" || args.includes("--help") || args.includes("-h")) {
    printLoopHelp();
    return;
  }

  const loop = resolveLoopCommand(rawCommand);
  if (!loop) {
    insight.error(`Unknown loop subcommand: ${rawCommand}`);
    printLoopHelp();
    process.exitCode = 1;
    return;
  }

  const asJson = args.includes("--json");
  const spec = LOOP_SPECS[loop];

  let watch: LoopWatchOptions;
  let invocation: LoopInvocation;
  try {
    watch = buildWatchOptions(args);
    invocation = buildLoopInvocation(loop, args, watch.enabled);
  } catch (error) {
    insight.error(error instanceof Error ? error.message : String(error));
    printLoopHelp();
    process.exitCode = 1;
    return;
  }

  let context: AgoraContext | null = null;
  const baseGetContext = (deps.createContextLoader ?? createAgoraContextLoader)(
    config,
    insight,
    { startLifecycleSweep: false },
  );
  const getContext = async () => {
    context ??= await baseGetContext();
    return context;
  };

  const serverFactory = deps.createServer ?? createAgoraServer;
  const server = serverFactory(config, { insight, getContext });
  const runner = (deps.getRunner ?? getToolRunner)(server);
  const agentName = getArg(args, "--agent-name") ?? spec.defaultAgentName;
  const sleep = deps.sleep ?? (async (ms: number) => {
    await sleepTimeout(ms);
  });

  let registered: RegisteredLoopAgent | null = null;

  try {
    const registration = await runner.callTool("register_agent", compactRecord({
      name: agentName,
      type: getArg(args, "--agent-type") ?? "cli-loop",
      provider: getArg(args, "--provider"),
      model: getArg(args, "--model"),
      modelFamily: getArg(args, "--model-family"),
      modelVersion: getArg(args, "--model-version"),
      desiredRole: spec.role,
      authToken: getArg(args, "--auth-token"),
    }));
    registered = parseRegisteredAgent(registration);

    if (loop === "council") {
      invocation = {
        ...invocation,
        councilSpecialization: await resolveCouncilLoopSpecialization({
          explicit: invocation.councilSpecialization,
          agentName,
          getContext,
        }),
      };
      if (!invocation.councilQueueWatch && !invocation.councilSpecialization) {
        throw new Error(
          "Council loop requires a reviewer specialization. Use --specialization <role> or --agent-name matching a specialized reviewer manifest.",
        );
      }
    }

    const agent = toLoopAgentPayload(agentName, registered);
    if (watch.enabled) {
      await runWatchLoop({
        loop,
        spec,
        agent,
        invocation,
        watch,
        runner,
        sleep,
        asJson,
      });
      return;
    }

    const effectiveParams = loop === "council"
      ? enrichCouncilParams(invocation.workflowParams, agent, invocation.councilSpecialization)
      : invocation.workflowParams;
    const workflowExecution = await executeWorkflow(runner, spec.workflowName, agent, effectiveParams);
    if (!workflowExecution.call.ok) {
      process.exitCode = 1;
      printLoopFailure(workflowExecution.call, workflowExecution.payload, asJson, agent, loop, spec.workflowName);
      return;
    }

    printLoopOutput({
      loop,
      workflowName: spec.workflowName,
      agent,
      result: workflowExecution.payload,
    }, asJson);
  } catch (error) {
    insight.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (registered) {
      const endResult = await runner.callTool("end_session", {
        agentId: registered.agentId,
        sessionId: registered.sessionId,
      });
      if (!endResult.ok) {
        insight.warn(formatToolFailure(endResult));
      }
    }
    closeLoopContext(context);
  }
}

async function runWatchLoop(input: {
  loop: LoopCommand;
  spec: LoopSpec;
  agent: LoopAgentPayload;
  invocation: LoopInvocation;
  watch: LoopWatchOptions;
  runner: ToolRunner;
  sleep: (ms: number) => Promise<void>;
  asJson: boolean;
}): Promise<void> {
  const { loop, spec, agent, invocation, watch, runner, sleep, asJson } = input;
  const stopController = createStopController();
  let cycles = 0;
  // Start from "now" so watch mode behaves like a live worker, not a full bus history replay.
  let lastCoordinationTimestamp: string | undefined = new Date().toISOString();
  const seenMessageIds = new Set<string>();
  const fingerprints = new Map<string, string>();
  let stopReason: WatchStopReason = "signal";

  try {
    printWatchEvent({
      event: "watch_started",
      loop,
      workflowName: spec.workflowName,
      intervalMs: watch.intervalMs,
      agent,
      councilMode: loop === "council" && invocation.councilQueueWatch ? "queue" : "fixed",
    }, asJson);

    while (!stopController.stopped) {
      cycles += 1;
      const coordination = await pollCoordination(runner, agent, lastCoordinationTimestamp);
      if (coordination.messages.length > 0) {
        lastCoordinationTimestamp = coordination.messages[coordination.messages.length - 1]?.timestamp ?? lastCoordinationTimestamp;
        printWatchCoordinationEvent(loop, coordination.messages, asJson);
      }

      if (loop === "council" && invocation.councilQueueWatch) {
        const requests = extractCouncilRequests(coordination.messages, seenMessageIds);
        let handledRequest = false;

        for (const request of requests) {
          const councilParams = await resolveCouncilRequestParams(
            runner,
            agent,
            request,
            invocation.councilSpecialization,
          );
          if (!councilParams) {
            printWatchEvent({
              event: "watch_warning",
              loop,
              message: `Skipping review request ${request.messageId}: no matching council specialization was available for ${request.ticketId}.`,
            }, asJson);
            continue;
          }

          handledRequest = true;
          const execution = await executeWorkflow(runner, spec.workflowName, agent, councilParams);
          const handled = printWatchWorkflowEvent({
            loop,
            workflowName: spec.workflowName,
            cycle: cycles,
            reason: "review_request",
            params: councilParams,
            agent,
            execution,
            asJson,
            fingerprintKey: `review_request:${request.messageId}`,
            fingerprints,
            request,
            forcePrint: true,
          });

          if (!handled.ok) {
            process.exitCode = 1;
          }
        }

        if (!handledRequest) {
          if (!invocation.councilSpecialization) {
            const warning = "Council queue watch requires --specialization <role> or a specialized --agent-name to self-review queued tickets.";
            if (fingerprints.get("council:missing_specialization") !== warning) {
              fingerprints.set("council:missing_specialization", warning);
              printWatchEvent({
                event: "watch_warning",
                loop,
                message: warning,
              }, asJson);
            }
          } else {
            const inReviewTicket = await getTopQueueTicket(runner, agent, "in_review", invocation.queueLimit);
            if (inReviewTicket) {
              const params = enrichCouncilParams(
                { ticketId: inReviewTicket.ticketId, transition: "in_review→ready_for_commit" },
                agent,
                invocation.councilSpecialization,
              );
              const execution = await executeWorkflow(runner, spec.workflowName, agent, params);
              const handled = printWatchWorkflowEvent({
                loop,
                workflowName: spec.workflowName,
                cycle: cycles,
                reason: "in_review_queue",
                params,
                agent,
                execution,
                asJson,
                fingerprintKey: "queue:in_review",
                fingerprints,
                queueTicket: inReviewTicket,
              });
              if (!handled.ok) {
                process.exitCode = 1;
                stopReason = "workflow_failed";
                break;
              }
            } else {
              const technicalAnalysisTicket = await getTopQueueTicket(runner, agent, "technical_analysis", invocation.queueLimit);
              if (technicalAnalysisTicket) {
                const params = enrichCouncilParams(
                  { ticketId: technicalAnalysisTicket.ticketId, transition: "technical_analysis→approved" },
                  agent,
                  invocation.councilSpecialization,
                );
                const execution = await executeWorkflow(runner, spec.workflowName, agent, params);
                const handled = printWatchWorkflowEvent({
                  loop,
                  workflowName: spec.workflowName,
                  cycle: cycles,
                  reason: "technical_analysis_queue",
                  params,
                  agent,
                  execution,
                  asJson,
                  fingerprintKey: "queue:technical_analysis",
                  fingerprints,
                  queueTicket: technicalAnalysisTicket,
                });
                if (!handled.ok) {
                  process.exitCode = 1;
                  stopReason = "workflow_failed";
                  break;
                }
              } else {
                const backlogTickets = await listTickets(runner, agent, "backlog", invocation.queueLimit);
                const backlogFingerprint = fingerprintValue(backlogTickets);
                if (fingerprints.get("queue:backlog") !== backlogFingerprint) {
                  fingerprints.set("queue:backlog", backlogFingerprint);
                  printWatchEvent({
                    event: "backlog_queue",
                    loop,
                    cycle: cycles,
                    message: "No review requests, in_review tickets, or technical_analysis tickets. Council can advance backlog planning.",
                    tickets: backlogTickets,
                  }, asJson);
                }
              }
            }
          }
        }
      } else if (loop === "plan") {
        const execution = await executeWorkflow(runner, spec.workflowName, agent, invocation.workflowParams);
        const handled = printWatchWorkflowEvent({
          loop,
          workflowName: spec.workflowName,
          cycle: cycles,
          reason: fingerprints.size === 0 ? "initial" : "changed",
          params: invocation.workflowParams,
          agent,
          execution,
          asJson,
          fingerprintKey: `${loop}:fixed`,
          fingerprints,
        });
        if (!handled.ok) {
          process.exitCode = 1;
          stopReason = "workflow_failed";
          break;
        }

        const autonomousAction = selectPlannerAutonomousAction(execution.payload);
        if (autonomousAction) {
          const routeExecution = await executeWorkflow(
            runner,
            autonomousAction.workflowName,
            agent,
            autonomousAction.params,
          );
          printWatchWorkflowEvent({
            loop,
            workflowName: autonomousAction.workflowName,
            cycle: cycles,
            reason: autonomousAction.reason,
            params: autonomousAction.params,
            agent,
            execution: routeExecution,
            asJson,
            fingerprintKey: `plan:auto:${autonomousAction.workflowName}:${autonomousAction.queueTicket.ticketId}`,
            fingerprints,
            queueTicket: autonomousAction.queueTicket,
          });
        }
      } else {
        const effectiveParams = loop === "council"
          ? enrichCouncilParams(invocation.workflowParams, agent, invocation.councilSpecialization)
          : invocation.workflowParams;
        const execution = await executeWorkflow(runner, spec.workflowName, agent, effectiveParams);
        const handled = printWatchWorkflowEvent({
          loop,
          workflowName: spec.workflowName,
          cycle: cycles,
          reason: fingerprints.size === 0 ? "initial" : "changed",
          params: effectiveParams,
          agent,
          execution,
          asJson,
          fingerprintKey: `${loop}:fixed`,
          fingerprints,
        });
        if (!handled.ok) {
          process.exitCode = 1;
          stopReason = "workflow_failed";
          break;
        }

        if (loop === "dev") {
          await maybeAutoTakeDeveloperWork({
            runner,
            agent,
            cycle: cycles,
            asJson,
            payload: execution.payload,
          });
        }
      }

      if (watch.maxRuns && cycles >= watch.maxRuns) {
        stopReason = "max_runs";
        break;
      }

      const interrupted = await stopController.wait(watch.intervalMs, sleep);
      if (interrupted) {
        stopReason = "signal";
        break;
      }
    }
  } finally {
    stopController.dispose();
    printWatchEvent({
      event: "watch_stopped",
      loop,
      workflowName: spec.workflowName,
      cycles,
      reason: stopReason,
      agent,
    }, asJson);
  }
}

function printWatchWorkflowEvent(input: {
  loop: LoopCommand;
  workflowName: string;
  cycle: number;
  reason: WorkflowPrintReason;
  params: Record<string, unknown>;
  agent: LoopAgentPayload;
  execution: WorkflowExecution;
  asJson: boolean;
  fingerprintKey: string;
  fingerprints: Map<string, string>;
  forcePrint?: boolean;
  request?: CouncilRequestContext;
  queueTicket?: QueueTicketSummary;
}): { ok: boolean } {
  const { execution, fingerprintKey, fingerprints, forcePrint = false } = input;
  const fingerprint = fingerprintValue(execution.payload);
  const changed = fingerprints.get(fingerprintKey) !== fingerprint;
  fingerprints.set(fingerprintKey, fingerprint);

  if (!execution.call.ok) {
    printWatchEvent({
      event: "workflow_failed",
      loop: input.loop,
      workflowName: input.workflowName,
      cycle: input.cycle,
      reason: input.reason,
      params: input.params,
      agent: input.agent,
      request: input.request,
      queueTicket: input.queueTicket,
      result: execution.payload ?? {
        tool: execution.call.tool,
        message: execution.call.message,
      },
    }, input.asJson);
    return { ok: false };
  }

  if (forcePrint || changed) {
    printWatchEvent({
      event: "workflow_result",
      loop: input.loop,
      workflowName: input.workflowName,
      cycle: input.cycle,
      reason: input.reason,
      params: input.params,
      agent: input.agent,
      request: input.request,
      queueTicket: input.queueTicket,
      result: execution.payload,
    }, input.asJson);
  }

  return { ok: true };
}

function buildLoopInvocation(loop: LoopCommand, args: string[], watchEnabled: boolean): LoopInvocation {
  switch (loop) {
    case "plan":
    case "dev":
      return {
        workflowParams: buildLimitParams(args),
        councilQueueWatch: false,
        queueLimit: buildQueueLimit(args),
      };
    case "council":
      return buildCouncilInvocation(args, watchEnabled);
  }
}

function buildCouncilInvocation(args: string[], watchEnabled: boolean): LoopInvocation {
  const positionalTicketId = isPositionalValue(args[1]) ? args[1] : undefined;
  const positionalTransition = isPositionalValue(args[2]) ? args[2] : undefined;
  const ticketId = getArg(args, "--ticket") ?? positionalTicketId;
  const rawTransition = getArg(args, "--transition") ?? positionalTransition;
  const queueLimit = buildQueueLimit(args);
  const rawSpecialization = getArg(args, "--specialization");
  const councilSpecialization = rawSpecialization == null
    ? undefined
    : parseCouncilSpecialization(rawSpecialization, "--specialization");

  if (!watchEnabled) {
    if (!ticketId || !/^TKT-[A-Za-z0-9]+$/i.test(ticketId)) {
      throw new Error("Usage: agora loop council <ticket-id> --transition <technical_analysis->approved|in_review->ready_for_commit> [--since-commit <sha>] [--json]");
    }
    if (!rawTransition) {
      throw new Error("Usage: agora loop council <ticket-id> --transition <technical_analysis->approved|in_review->ready_for_commit> [--since-commit <sha>] [--json]");
    }
    const transition = normalizeCouncilTransition(rawTransition);
    if (!COUNCIL_TRANSITIONS.has(transition)) {
      throw new Error(`Invalid council transition: ${rawTransition}`);
    }
    return {
      workflowParams: compactRecord({
        ticketId,
        transition,
        sinceCommit: getArg(args, "--since-commit"),
      }),
      councilQueueWatch: false,
      queueLimit,
      councilSpecialization,
    };
  }

  if ((ticketId && !rawTransition) || (!ticketId && rawTransition)) {
    throw new Error("Council watch mode requires both <ticket-id> and --transition when targeting a fixed ticket, or neither to operate from the queue.");
  }

  if (ticketId && !/^TKT-[A-Za-z0-9]+$/i.test(ticketId)) {
    throw new Error(`Invalid council ticket id: ${ticketId}`);
  }

  if (ticketId && rawTransition) {
    const transition = normalizeCouncilTransition(rawTransition);
    if (!COUNCIL_TRANSITIONS.has(transition)) {
      throw new Error(`Invalid council transition: ${rawTransition}`);
    }
    return {
      workflowParams: compactRecord({
        ticketId,
        transition,
        sinceCommit: getArg(args, "--since-commit"),
      }),
      councilQueueWatch: false,
      queueLimit,
      councilSpecialization,
    };
  }

  return {
    workflowParams: {},
    councilQueueWatch: true,
    queueLimit,
    councilSpecialization,
  };
}

function buildLimitParams(args: string[]): Record<string, unknown> {
  const limit = getArg(args, "--limit");
  if (limit == null) return {};

  const parsed = parsePositiveInt(limit, "--limit");
  return { limit: parsed };
}

function buildQueueLimit(args: string[]): number {
  const limit = getArg(args, "--limit");
  if (limit == null) return DEFAULT_QUEUE_LIMIT;
  return parsePositiveInt(limit, "--limit");
}

function buildWatchOptions(args: string[]): LoopWatchOptions {
  const enabled = args.includes("--watch");
  const intervalArg = getArg(args, "--interval-ms");
  const maxRunsArg = getArg(args, "--max-runs");

  if (!enabled && (intervalArg != null || maxRunsArg != null)) {
    throw new Error("--interval-ms and --max-runs require --watch");
  }

  const intervalMs = intervalArg == null
    ? DEFAULT_WATCH_INTERVAL_MS
    : parsePositiveInt(intervalArg, "--interval-ms");

  if (enabled && intervalMs < 1_000) {
    throw new Error("--interval-ms must be at least 1000 in watch mode");
  }

  const maxRuns = maxRunsArg == null ? undefined : parsePositiveInt(maxRunsArg, "--max-runs");

  return { enabled, intervalMs, maxRuns };
}

async function executeWorkflow(
  runner: ToolRunner,
  workflowName: string,
  agent: LoopAgentPayload,
  params: Record<string, unknown>,
): Promise<WorkflowExecution> {
  const call = await runner.callTool("run_workflow", {
    name: workflowName,
    params,
    agentId: agent.agentId,
    sessionId: agent.sessionId,
  });
  return {
    call,
    payload: parseToolPayload(call),
  };
}

async function pollCoordination(
  runner: ToolRunner,
  agent: LoopAgentPayload,
  since?: string,
): Promise<CoordinationPollPayload> {
  const result = await runner.callTool("poll_coordination", compactRecord({
    agentId: agent.agentId,
    sessionId: agent.sessionId,
    since,
    limit: 100,
  }));

  if (!result.ok) {
    throw new Error(formatToolFailure(result));
  }

  const payload = parseToolPayload(result);
  if (!isRecord(payload)) {
    return { topology: null, count: 0, messages: [] };
  }

  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = rawMessages.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.from !== "string" || typeof entry.timestamp !== "string") {
      return [];
    }
    return [{
      id: entry.id,
      from: entry.from,
      to: typeof entry.to === "string" ? entry.to : null,
      type: typeof entry.type === "string" ? entry.type : "broadcast",
      payload: isRecord(entry.payload) ? entry.payload : {},
      timestamp: entry.timestamp,
    } satisfies CoordinationMessageRecord];
  });

  return {
    topology: typeof payload.topology === "string" ? payload.topology : null,
    count: typeof payload.count === "number" ? payload.count : messages.length,
    messages,
  };
}

function extractCouncilRequests(
  messages: CoordinationMessageRecord[],
  seenMessageIds: Set<string>,
): CouncilRequestContext[] {
  const requests: CouncilRequestContext[] = [];

  for (const message of messages) {
    if (seenMessageIds.has(message.id)) continue;
    seenMessageIds.add(message.id);

    if (!isRecord(message.payload) || message.payload.kind !== "review_request" || typeof message.payload.ticketId !== "string") {
      continue;
    }

    const transition = typeof message.payload.transition === "string"
      ? normalizeCouncilTransition(message.payload.transition)
      : undefined;
    const requestedRoles = Array.isArray(message.payload.roles)
      ? message.payload.roles.flatMap((entry) => {
        const parsed = CouncilSpecializationId.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
      : [];

    requests.push({
      messageId: message.id,
      sourceAgentId: message.from,
      ticketId: message.payload.ticketId,
      transition: transition && COUNCIL_TRANSITIONS.has(transition) ? transition : null,
      requestedRoles,
    });
  }

  return requests;
}

async function resolveCouncilRequestParams(
  runner: ToolRunner,
  agent: LoopAgentPayload,
  request: CouncilRequestContext,
  workerSpecialization?: CouncilSpecialization,
): Promise<Record<string, unknown> | null> {
  const transition = request.transition
    ?? await inferCouncilTransitionFromTicket(runner, agent, request.ticketId);
  if (!transition) return null;
  const specialization = selectCouncilRequestSpecialization(request, workerSpecialization);
  if (!specialization) return null;

  return enrichCouncilParams({
    ticketId: request.ticketId,
    transition,
  }, agent, specialization);
}

function enrichCouncilParams(
  params: Record<string, unknown>,
  agent: LoopAgentPayload,
  specialization?: CouncilSpecialization,
): Record<string, unknown> {
  const transition = typeof params.transition === "string" ? params.transition : "";
  return {
    ...params,
    targetStatus: COUNCIL_TARGET_STATUS[transition] ?? "approved",
    callerAgentId: agent.agentId,
    ...(specialization ? { callerSpecialization: specialization } : {}),
  };
}

function selectCouncilRequestSpecialization(
  request: CouncilRequestContext,
  workerSpecialization?: CouncilSpecialization,
): CouncilSpecialization | null {
  if (request.requestedRoles.length === 0) {
    return workerSpecialization ?? null;
  }
  if (workerSpecialization) {
    return request.requestedRoles.includes(workerSpecialization) ? workerSpecialization : null;
  }
  return request.requestedRoles.length === 1 ? request.requestedRoles[0] ?? null : null;
}

async function resolveCouncilLoopSpecialization(input: {
  explicit?: CouncilSpecialization;
  agentName: string;
  getContext: () => Promise<AgoraContext>;
}): Promise<CouncilSpecialization | undefined> {
  if (input.explicit) return input.explicit;
  const context = await input.getContext();
  const catalog = await loadRepoAgentCatalog(context.repoPath);
  return catalog.repoAgents.find((agent) => agent.name === input.agentName)?.reviewRole ?? undefined;
}

async function inferCouncilTransitionFromTicket(
  runner: ToolRunner,
  agent: LoopAgentPayload,
  ticketId: string,
): Promise<string | null> {
  const result = await runner.callTool("get_ticket", {
    ticketId,
    agentId: agent.agentId,
    sessionId: agent.sessionId,
  });

  if (!result.ok) return null;
  const payload = parseToolPayload(result);
  if (!isRecord(payload) || typeof payload.status !== "string") {
    return null;
  }

  if (payload.status === "in_review") return "in_review→ready_for_commit";
  if (payload.status === "technical_analysis") return "technical_analysis→approved";
  return null;
}

async function listTickets(
  runner: ToolRunner,
  agent: LoopAgentPayload,
  status: string,
  limit: number,
): Promise<QueueTicketSummary[]> {
  const result = await runner.callTool("list_tickets", {
    status,
    limit,
    agentId: agent.agentId,
    sessionId: agent.sessionId,
  });

  if (!result.ok) {
    throw new Error(formatToolFailure(result));
  }

  const payload = parseToolPayload(result);
  if (!isRecord(payload) || !Array.isArray(payload.tickets)) return [];

  return payload.tickets.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.ticketId !== "string") return [];
    return [{
      ticketId: entry.ticketId,
      title: typeof entry.title === "string" ? entry.title : undefined,
      status: typeof entry.status === "string" ? entry.status : undefined,
      priority: typeof entry.priority === "number" ? entry.priority : undefined,
      severity: typeof entry.severity === "string" ? entry.severity : undefined,
    } satisfies QueueTicketSummary];
  });
}

async function getTopQueueTicket(
  runner: ToolRunner,
  agent: LoopAgentPayload,
  status: string,
  limit: number,
): Promise<QueueTicketSummary | null> {
  const tickets = await listTickets(runner, agent, status, limit);
  return tickets[0] ?? null;
}

function selectPlannerAutonomousAction(payload: unknown): PlannerAutonomousAction | null {
  const outputs = isRecord(payload) && isRecord(payload.outputs) ? payload.outputs : null;
  if (!outputs) return null;

  const inReviewTicket = readTopQueueTicket(outputs.in_review);
  if (inReviewTicket) {
    return {
      workflowName: "deep-review-v2",
      params: {
        ticketId: inReviewTicket.ticketId,
        timeoutSeconds: AUTONOMOUS_QUEUE_TIMEOUT_SECONDS,
      },
      queueTicket: inReviewTicket,
      reason: "in_review_queue",
    };
  }

  const technicalAnalysisTicket = readTopQueueTicket(outputs.technical_analysis);
  if (technicalAnalysisTicket) {
    return {
      workflowName: "ta-review",
      params: {
        ticketId: technicalAnalysisTicket.ticketId,
        timeoutSeconds: AUTONOMOUS_QUEUE_TIMEOUT_SECONDS,
      },
      queueTicket: technicalAnalysisTicket,
      reason: "technical_analysis_queue",
    };
  }

  return null;
}

async function maybeAutoTakeDeveloperWork(input: {
  runner: ToolRunner;
  agent: LoopAgentPayload;
  cycle: number;
  asJson: boolean;
  payload: unknown;
}): Promise<void> {
  const candidate = selectDeveloperAutoTakeCandidate(input.payload);
  if (!candidate) return;

  const assignResult = await input.runner.callTool("assign_ticket", {
    ticketId: candidate.ticketId,
    assigneeAgentId: input.agent.agentId,
    agentId: input.agent.agentId,
    sessionId: input.agent.sessionId,
  });
  if (!assignResult.ok) {
    printWatchEvent({
      event: "ticket_take_failed",
      loop: "dev",
      cycle: input.cycle,
      ticketId: candidate.ticketId,
      message: formatToolFailure(assignResult),
    }, input.asJson);
    return;
  }

  let claimPayload: unknown = null;
  if (candidate.affectedPaths.length > 0) {
    const claimResult = await input.runner.callTool("claim_files", {
      paths: candidate.affectedPaths,
      agentId: input.agent.agentId,
      sessionId: input.agent.sessionId,
    });
    if (!claimResult.ok) {
      printWatchEvent({
        event: "ticket_take_failed",
        loop: "dev",
        cycle: input.cycle,
        ticketId: candidate.ticketId,
        message: formatToolFailure(claimResult),
      }, input.asJson);
      return;
    }
    claimPayload = parseToolPayload(claimResult);
  }

  const transitionResult = await input.runner.callTool("update_ticket_status", {
    ticketId: candidate.ticketId,
    status: "in_progress",
    comment: "Developer loop auto-take: claimed approved work for implementation",
    agentId: input.agent.agentId,
    sessionId: input.agent.sessionId,
  });
  if (!transitionResult.ok) {
    printWatchEvent({
      event: "ticket_take_failed",
      loop: "dev",
      cycle: input.cycle,
      ticketId: candidate.ticketId,
      message: formatToolFailure(transitionResult),
    }, input.asJson);
    return;
  }

  printWatchEvent({
    event: "ticket_taken",
    loop: "dev",
    cycle: input.cycle,
    ticketId: candidate.ticketId,
    affectedPaths: candidate.affectedPaths,
    assignment: parseToolPayload(assignResult),
    claims: claimPayload,
    transition: parseToolPayload(transitionResult),
  }, input.asJson);
}

function selectDeveloperAutoTakeCandidate(payload: unknown): DeveloperAutoTakeCandidate | null {
  const outputs = isRecord(payload) && isRecord(payload.outputs) ? payload.outputs : null;
  if (!outputs) return null;

  const ticket = isRecord(outputs.ticket) ? outputs.ticket : null;
  if (!ticket || typeof ticket.ticketId !== "string") return null;

  const suggestions = isRecord(outputs.suggestions) ? outputs.suggestions : null;
  const suggestionRows = Array.isArray(suggestions?.suggestions)
    ? suggestions.suggestions.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const topSuggestion = suggestionRows[0];
  if (!topSuggestion || typeof topSuggestion.ticketId !== "string" || topSuggestion.ticketId !== ticket.ticketId) {
    return null;
  }

  const routingRecommendation = isRecord(suggestions?.routingRecommendation)
    ? suggestions.routingRecommendation
    : null;
  const recommendationAction = typeof routingRecommendation?.action === "string"
    ? routingRecommendation.action
    : null;
  const canAutoTake = recommendationAction === "recommend" || suggestionRows.length === 1;
  if (!canAutoTake) return null;

  const affectedPaths = Array.isArray(ticket.affectedPaths)
    ? ticket.affectedPaths.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ticketId: ticket.ticketId,
    affectedPaths,
  };
}

function readTopQueueTicket(value: unknown): QueueTicketSummary | null {
  if (!isRecord(value) || !Array.isArray(value.tickets)) return null;
  const [first] = value.tickets;
  if (!isRecord(first) || typeof first.ticketId !== "string") return null;
  return {
    ticketId: first.ticketId,
    title: typeof first.title === "string" ? first.title : undefined,
    status: typeof first.status === "string" ? first.status : undefined,
    priority: typeof first.priority === "number" ? first.priority : undefined,
    severity: typeof first.severity === "string" ? first.severity : undefined,
  };
}

function parseRegisteredAgent(result: ToolRunnerCallResult): RegisteredLoopAgent {
  if (!result.ok) {
    throw new Error(formatToolFailure(result));
  }

  const payload = parseToolPayload(result);
  if (!isRecord(payload) || typeof payload.agentId !== "string" || typeof payload.sessionId !== "string") {
    throw new Error("register_agent returned an invalid payload");
  }

  return {
    agentId: payload.agentId,
    sessionId: payload.sessionId,
    role: typeof payload.role === "string" ? payload.role : "observer",
    resumed: typeof payload.resumed === "boolean" ? payload.resumed : false,
  };
}

function parseToolPayload(result: Pick<ToolRunnerCallResult, "result">): unknown {
  const text = extractTextContent(result.result);
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function printLoopOutput(payload: LoopExecutionPayload, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log([
    `${payload.workflowName} via ${payload.agent.name}`,
    formatDisplayValue(payload.result),
  ].join("\n"));
}

function printLoopFailure(
  result: Exclude<ToolRunnerCallResult, { ok: true }>,
  payload: unknown,
  asJson: boolean,
  agent: LoopAgentPayload,
  loop: LoopCommand,
  workflowName: string,
): void {
  if (asJson && payload !== null) {
    console.log(JSON.stringify({
      loop,
      workflowName,
      agent,
      result: payload,
    }, null, 2));
    return;
  }

  if (payload !== null) {
    console.log(formatDisplayValue(payload));
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(formatToolFailure(result));
}

function printWatchCoordinationEvent(
  loop: LoopCommand,
  messages: CoordinationMessageRecord[],
  asJson: boolean,
): void {
  if (messages.length === 0) return;
  printWatchEvent({
    event: "coordination",
    loop,
    count: messages.length,
    messages,
  }, asJson);
}

function printWatchEvent(event: Record<string, unknown>, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(event, null, 2));
    return;
  }

  switch (event.event) {
    case "watch_started":
      console.log(`Watching ${String(event.workflowName)} via ${String((event.agent as LoopAgentPayload).name)} every ${String(event.intervalMs)}ms (${String(event.councilMode ?? "fixed")})`);
      return;
    case "workflow_result":
      console.log([
        `[cycle ${String(event.cycle)}] ${String(event.workflowName)} (${String(event.reason)})`,
        formatDisplayValue(event.result),
      ].join("\n"));
      return;
    case "workflow_failed":
      console.log([
        `[cycle ${String(event.cycle)}] ${String(event.workflowName)} failed (${String(event.reason)})`,
        formatDisplayValue(event.result),
      ].join("\n"));
      return;
    case "coordination":
      console.log([
        `Coordination: ${String(event.count)} message(s)`,
        formatDisplayValue(event.messages),
      ].join("\n"));
      return;
    case "backlog_queue":
      console.log([
        String(event.message),
        formatDisplayValue(event.tickets),
      ].join("\n"));
      return;
    case "ticket_taken":
      console.log([
        `Auto-took ${String(event.ticketId)} for implementation`,
        formatDisplayValue({
          affectedPaths: event.affectedPaths,
          assignment: event.assignment,
          claims: event.claims,
          transition: event.transition,
        }),
      ].join("\n"));
      return;
    case "ticket_take_failed":
      console.log(`Auto-take failed for ${String(event.ticketId)}: ${String(event.message)}`);
      return;
    case "watch_warning":
      console.log(`Warning: ${String(event.message)}`);
      return;
    case "watch_stopped":
      console.log(`Stopped ${String(event.workflowName)} after ${String(event.cycles)} cycle(s) (${String(event.reason)})`);
      return;
    default:
      console.log(formatDisplayValue(event));
  }
}

function toLoopAgentPayload(agentName: string, registered: RegisteredLoopAgent): LoopAgentPayload {
  return {
    name: agentName,
    agentId: registered.agentId,
    sessionId: registered.sessionId,
    role: registered.role,
    resumed: Boolean(registered.resumed),
  };
}

function formatDisplayValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function formatToolFailure(result: Exclude<ToolRunnerCallResult, { ok: true }>): string {
  const toolText = result.result ? extractTextContent(result.result) : null;
  return toolText ?? `${result.tool}: ${result.message}`;
}

function extractTextContent(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const content = result.content;
  if (!Array.isArray(content)) return null;

  const text = content
    .map((entry) => (
      isRecord(entry) && typeof entry.text === "string"
        ? entry.text
        : ""
    ))
    .filter(Boolean)
    .join("\n");

  return text || null;
}

function closeLoopContext(context: AgoraContext | null): void {
  context?.dispose?.();
  context?.sqlite.close();
  context?.globalSqlite?.close();
}

function normalizeCouncilTransition(value: string): string {
  const normalized = value.trim().replace(/\s*->\s*/g, "→");
  if (normalized === "technical_analysis_to_approved") return "technical_analysis→approved";
  if (normalized === "in_review_to_ready_for_commit") return "in_review→ready_for_commit";
  return normalized;
}

function resolveLoopCommand(value: string): LoopCommand | null {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "plan":
    case "planner":
      return "plan";
    case "dev":
    case "developer":
      return "dev";
    case "council":
    case "review":
    case "reviewer":
      return "council";
    default:
      return null;
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function compactRecord<T extends Record<string, unknown>>(value: T): T {
  const entries = Object.entries(value).filter(([, recordValue]) => recordValue !== undefined);
  return Object.fromEntries(entries) as T;
}

function isPositionalValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("--");
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${raw}`);
  }
  return parsed;
}

function parseCouncilSpecialization(raw: string, flag: string): CouncilSpecialization {
  const parsed = CouncilSpecializationId.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${flag} value: ${raw}`);
  }
  return parsed.data;
}

function fingerprintValue(value: unknown): string {
  return JSON.stringify(stripVolatileFields(value));
}

function stripVolatileFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripVolatileFields(entry));
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_RESULT_KEYS.has(key))
      .map(([key, entry]) => [key, stripVolatileFields(entry)]),
  );
}

function createStopController(): {
  stopped: boolean;
  wait: (ms: number, sleep: (ms: number) => Promise<void>) => Promise<boolean>;
  dispose: () => void;
} {
  let stopped = false;
  let resolveStop!: () => void;
  const signalPromise = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  const handleStop = () => {
    if (stopped) return;
    stopped = true;
    resolveStop();
  };

  process.once("SIGINT", handleStop);
  process.once("SIGTERM", handleStop);

  return {
    get stopped() {
      return stopped;
    },
    async wait(ms, sleep) {
      if (stopped) return true;
      await Promise.race([
        sleep(ms),
        signalPromise,
      ]);
      return stopped;
    },
    dispose() {
      process.off("SIGINT", handleStop);
      process.off("SIGTERM", handleStop);
    },
  };
}

function printLoopHelp(): void {
  console.error("Loop commands:");
  console.error("  agora loop plan [--limit <n>] [--watch] [--interval-ms <ms>] [--max-runs <n>] [--agent-name <name>] [--json]");
  console.error("  agora loop dev [--limit <n>] [--watch] [--interval-ms <ms>] [--max-runs <n>] [--agent-name <name>] [--json]");
  console.error("  agora loop council <ticket-id> --transition <technical_analysis->approved|in_review->ready_for_commit> [--since-commit <sha>] [--specialization <role>] [--watch] [--interval-ms <ms>] [--max-runs <n>] [--agent-name <name>] [--json]");
  console.error("  agora loop council --watch [--limit <n>] [--specialization <role>] [--interval-ms <ms>] [--max-runs <n>] [--agent-name <name>] [--json]");
  console.error("");
  console.error("Watch mode:");
  console.error("  --watch keeps a single session alive, polls coordination, and reruns the loop.");
  console.error("  Council watch handles review requests first, then in_review, then technical_analysis, then backlog planning.");
  console.error("  Council queue watch requires --specialization <role> or a specialized --agent-name.");
  console.error("");
  console.error("Role/session handling:");
  console.error("  Each command auto-registers the required role.");
  console.error("  One-shot mode ends the session after the workflow.");
  console.error("  Watch mode keeps the session active until stopped, then ends it cleanly.");
  console.error("  Use --auth-token when privileged self-registration is enabled for the target role.");
}
