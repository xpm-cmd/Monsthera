/* eslint-disable no-console */
import { workId as workIdBrand, agentId as agentIdBrand } from "../core/types.js";
import {
  AGENT_LIFECYCLE_EVENT_TYPES,
  VALID_ORCHESTRATION_EVENT_TYPES,
  type AgentLifecycleEventType,
  type OrchestrationEvent,
  type OrchestrationEventRepository,
  type OrchestrationEventType,
} from "../orchestration/repository.js";
import type { AgentLifecycleDetails } from "../orchestration/types.js";
import { parseFlag, withContainer } from "./arg-helpers.js";
import { printSubcommandHelp, wantsHelp } from "./help.js";

const TAIL_DEFAULT_LIMIT = 50;
const FOLLOW_POLL_MS = 2000;

/**
 * Lifecycle types accepted by `events emit`. `agent_needed` is excluded
 * deliberately — the dispatcher is its only legitimate emitter, and a
 * harness emitting one would defeat dedup. Tail still surfaces all four.
 */
const HARNESS_EMIT_TYPES: readonly AgentLifecycleEventType[] = [
  "agent_started",
  "agent_completed",
  "agent_failed",
];
const HARNESS_EMIT_SET: ReadonlySet<string> = new Set<string>(HARNESS_EMIT_TYPES);
// Re-exported for the help text only — keeps the literal list in one place.
const HARNESS_EMIT_LABEL = HARNESS_EMIT_TYPES.join(", ");
// Reference the constant to keep the import alive when only HARNESS_EMIT_TYPES is used.
void AGENT_LIFECYCLE_EVENT_TYPES;

/**
 * `monsthera events <subcommand>` — read and emit orchestration events. The
 * tail subcommand prints JSON-lines on stdout (one event per line) so the
 * stream is pipeable to `jq` / `grep`. Logs continue to flow to stderr
 * through the shared logger; the CLI itself never writes to stdout outside
 * the data path. See `cli-stream-separation.test.ts` for the contract.
 */
export async function handleEvents(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || wantsHelp(args)) {
    return printEventsHelp();
  }
  switch (sub) {
    case "tail":
      return handleTail(args.slice(1));
    case "emit":
      return handleEmit(args.slice(1));
    default:
      console.error(`Unknown events subcommand: ${sub}`);
      console.error('Run "monsthera events --help" for usage.');
      process.exit(1);
  }
}

// ─── tail ───────────────────────────────────────────────────────────────────

async function handleTail(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    return printEventsHelp();
  }
  const typeFlag = parseFlag(args, "--type");
  if (typeFlag !== undefined && !VALID_ORCHESTRATION_EVENT_TYPES.has(typeFlag as OrchestrationEventType)) {
    console.error(
      `Invalid --type "${typeFlag}". Must be one of: ${[...VALID_ORCHESTRATION_EVENT_TYPES].join(", ")}`,
    );
    process.exit(1);
  }
  const limitFlag = parseFlag(args, "--limit");
  let limit = TAIL_DEFAULT_LIMIT;
  if (limitFlag !== undefined) {
    const parsed = Number(limitFlag);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      console.error(`Invalid --limit "${limitFlag}" (expected a positive integer).`);
      process.exit(1);
    }
    limit = parsed;
  }
  const follow = args.includes("--follow");

  await withContainer(args, async (container) => {
    const seen = new Set<string>();
    const initial = await fetchEvents(container.orchestrationRepo, typeFlag as OrchestrationEventType | undefined, limit);
    for (const event of initial) {
      seen.add(event.id);
      process.stdout.write(JSON.stringify(event) + "\n");
    }
    if (!follow) return;

    // Poll loop. Logs stay on stderr; new events stream to stdout. Cap the
    // seen-set so a long follow session does not leak memory — keep ~10x
    // the user's limit, which is plenty to dedup against re-fetches.
    const seenCap = Math.max(500, limit * 10);
    while (true) {
      await sleep(FOLLOW_POLL_MS);
      const next = await fetchEvents(
        container.orchestrationRepo,
        typeFlag as OrchestrationEventType | undefined,
        limit,
      );
      for (const event of next) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        process.stdout.write(JSON.stringify(event) + "\n");
      }
      if (seen.size > seenCap) {
        // Trim to most recent — Set preserves insertion order so we can
        // shift from the head until the size is back inside the cap.
        const overflow = seen.size - seenCap;
        let shifted = 0;
        for (const id of seen) {
          if (shifted >= overflow) break;
          seen.delete(id);
          shifted += 1;
        }
      }
    }
  });
}

async function fetchEvents(
  repo: OrchestrationEventRepository,
  type: OrchestrationEventType | undefined,
  limit: number,
): Promise<readonly OrchestrationEvent[]> {
  if (type) {
    const result = await repo.findByType(type);
    if (!result.ok) {
      console.error(`Failed to read events: ${result.error.message}`);
      process.exit(1);
    }
    // findByType returns newest-first per repo contract; slice to limit
    // and reverse to chronological order so consumers see oldest → newest
    // within each tick (matching the behaviour of `tail -f`).
    return result.value.slice(0, limit).reverse();
  }
  const result = await repo.findRecent(limit);
  if (!result.ok) {
    console.error(`Failed to read events: ${result.error.message}`);
    process.exit(1);
  }
  return [...result.value].reverse();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── emit ───────────────────────────────────────────────────────────────────

async function handleEmit(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    return printEventsHelp();
  }
  const type = parseFlag(args, "--type");
  if (!type) {
    console.error("Missing required flag: --type");
    process.exit(1);
  }
  if (!HARNESS_EMIT_SET.has(type)) {
    console.error(
      `Invalid --type "${type}". monsthera events emit accepts only harness-side lifecycle types: ${HARNESS_EMIT_LABEL}. agent_needed is dispatcher-only.`,
    );
    process.exit(1);
  }
  const wid = parseFlag(args, "--work-id");
  if (!wid) {
    console.error("Missing required flag: --work-id");
    process.exit(1);
  }
  const role = parseFlag(args, "--role");
  if (!role) {
    console.error("Missing required flag: --role");
    process.exit(1);
  }
  const from = parseFlag(args, "--from");
  const to = parseFlag(args, "--to");
  if (!from || !to) {
    console.error("Missing required flags: --from, --to (phase transition)");
    process.exit(1);
  }
  const aid = parseFlag(args, "--agent-id");
  const errorMsg = parseFlag(args, "--error");

  if (type === "agent_failed" && !errorMsg) {
    console.error("--error is required when --type=agent_failed");
    process.exit(1);
  }

  await withContainer(args, async (container) => {
    // Verify the work article exists — emitting against an unknown id is
    // almost always a typo; refusing here keeps the events table clean.
    const articleResult = await container.workRepo.findById(wid);
    if (!articleResult.ok) {
      console.error(`Unknown work article "${wid}": ${articleResult.error.message}`);
      process.exit(1);
    }

    const details: AgentLifecycleDetails = {
      role,
      transition: { from: from as never, to: to as never },
      ...(errorMsg ? { error: errorMsg } : {}),
    };

    const result = await container.orchestrationRepo.logEvent({
      workId: workIdBrand(wid),
      eventType: type as AgentLifecycleEventType,
      ...(aid ? { agentId: agentIdBrand(aid) } : {}),
      details: details as unknown as Record<string, unknown>,
    });
    if (!result.ok) {
      console.error(`Failed to emit event: ${result.error.message}`);
      process.exit(1);
    }
    // Notify the resync monitor so agent_started kicks off tracking and
    // agent_completed/agent_failed cleans it up. Failure here must NOT
    // block the emit — log to stderr and proceed; the next tick will
    // self-correct via cold-start rehydration.
    try {
      await container.resyncMonitor.onEvent(result.value);
    } catch (e) {
      container.logger.warn("Resync monitor onEvent threw", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    process.stdout.write(JSON.stringify(result.value) + "\n");
  });
}

function printEventsHelp(): void {
  printSubcommandHelp({
    command: "monsthera events",
    summary:
      "Tail or emit orchestration events. The dispatcher emits `agent_needed`; harnesses emit the rest.",
    usage: "<tail|emit> [options]",
    flags: [
      { name: "tail [--type T] [--limit N] [--follow]", description: "Print recent events as JSON-lines on stdout." },
      {
        name: "emit --type T --work-id W [--role R] [--from PHASE --to PHASE] [--agent-id A] [--error E]",
        description: "Emit one event. Type must be one of the lifecycle states.",
      },
      { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
    ],
    notes: [
      "tail --follow polls every 2s; logs stay on stderr.",
      "emit accepts only `agent_needed`/`agent_started`/`agent_completed`/`agent_failed`. Use higher-level commands for other event types.",
    ],
    examples: [
      "monsthera events tail",
      "monsthera events tail --type agent_needed --limit 200",
      "monsthera events tail --follow",
      "monsthera events emit --type agent_started --work-id w-foo --role security --from enrichment --to implementation --agent-id sec-agent",
      "monsthera events emit --type agent_failed --work-id w-foo --role security --from enrichment --to implementation --error 'tool crashed'",
    ],
  });
}
