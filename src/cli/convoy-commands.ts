/* eslint-disable no-console */
import {
  agentId as toAgentId,
  convoyId as toConvoyId,
  workId as toWorkId,
} from "../core/types.js";
import type { AgentId, ConvoyId, WorkPhase } from "../core/types.js";
import { VALID_PHASES } from "../core/types.js";
import { parseFlag, withContainer } from "./arg-helpers.js";
import { printSubcommandHelp, wantsHelp } from "./help.js";

function resolveActor(args: string[]): AgentId | undefined {
  const flag = parseFlag(args, "--actor");
  const raw = flag ?? process.env.MONSTHERA_ACTOR;
  if (!raw || raw.trim().length === 0) return undefined;
  return toAgentId(raw);
}

const VALID_TARGET_PHASES = [...VALID_PHASES];

/**
 * `monsthera convoy <subcommand>` — manage convoys (ADR-009). Convoys
 * are orchestration-state-only (no markdown source-of-truth, see ADR-009
 * for the carve-out from AGENTS.md §4). The CLI mirrors the events
 * surface: stdout is JSON-only (one record per command), stderr is the
 * shared logger. See `cli-stream-separation.test.ts` for the contract.
 */
export async function handleConvoy(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || wantsHelp(args)) {
    return printConvoyHelp();
  }
  switch (sub) {
    case "create":
      return handleCreate(args.slice(1));
    case "list":
      return handleList(args.slice(1));
    case "get":
      return handleGet(args.slice(1));
    case "complete":
      return handleComplete(args.slice(1));
    case "cancel":
      return handleCancel(args.slice(1));
    default:
      console.error(`Unknown convoy subcommand: ${sub}`);
      console.error('Run "monsthera convoy --help" for usage.');
      process.exit(1);
  }
}

async function handleGet(args: string[]): Promise<void> {
  if (wantsHelp(args)) return printConvoyHelp();
  const id = parseFlag(args, "--id");
  if (!id) {
    console.error("Missing required flag: --id <convoy-id>");
    process.exit(1);
  }
  await withContainer(args, async (container) => {
    const result = await container.convoyRepo.findById(toConvoyId(id) as ConvoyId);
    if (!result.ok) {
      console.error(`Failed to get convoy: ${result.error.message}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result.value) + "\n");
  });
}

async function handleCreate(args: string[]): Promise<void> {
  if (wantsHelp(args)) return printConvoyHelp();
  const lead = parseFlag(args, "--lead");
  const membersFlag = parseFlag(args, "--members");
  const goal = parseFlag(args, "--goal");
  const targetPhaseFlag = parseFlag(args, "--target-phase");

  if (!lead) {
    console.error("Missing required flag: --lead <work-id>");
    process.exit(1);
  }
  if (!membersFlag) {
    console.error("Missing required flag: --members <w-1,w-2,...>");
    process.exit(1);
  }
  if (!goal) {
    console.error("Missing required flag: --goal <text>");
    process.exit(1);
  }
  const members = membersFlag.split(",").map((m) => m.trim()).filter(Boolean);
  if (members.length === 0) {
    console.error("--members must list at least one work id");
    process.exit(1);
  }
  let targetPhase: WorkPhase | undefined;
  if (targetPhaseFlag) {
    if (!VALID_TARGET_PHASES.includes(targetPhaseFlag as WorkPhase)) {
      console.error(
        `Invalid --target-phase "${targetPhaseFlag}". Must be one of: ${VALID_TARGET_PHASES.join(", ")}`,
      );
      process.exit(1);
    }
    targetPhase = targetPhaseFlag as WorkPhase;
  }

  const actor = resolveActor(args);
  await withContainer(args, async (container) => {
    const result = await container.convoyRepo.create({
      leadWorkId: toWorkId(lead),
      memberWorkIds: members.map((m) => toWorkId(m)),
      goal,
      ...(targetPhase ? { targetPhase } : {}),
      ...(actor ? { actor } : {}),
    });
    if (!result.ok) {
      console.error(`Failed to create convoy: ${result.error.message}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result.value) + "\n");
  });
}

async function handleList(args: string[]): Promise<void> {
  if (wantsHelp(args)) return printConvoyHelp();
  const activeOnly = args.includes("--active");

  await withContainer(args, async (container) => {
    const result = activeOnly
      ? await container.convoyRepo.findActive()
      : null;
    if (activeOnly) {
      if (!result || !result.ok) {
        console.error(`Failed to list convoys: ${result?.error.message ?? "unknown error"}`);
        process.exit(1);
      }
      for (const convoy of result.value) {
        process.stdout.write(JSON.stringify(convoy) + "\n");
      }
      return;
    }
    // No "find-all" method on the interface; we expose active + the user
    // can inspect a specific id with `convoy get` (future). For now,
    // default to active-only and document this in --help.
    const allActive = await container.convoyRepo.findActive();
    if (!allActive.ok) {
      console.error(`Failed to list convoys: ${allActive.error.message}`);
      process.exit(1);
    }
    for (const convoy of allActive.value) {
      process.stdout.write(JSON.stringify(convoy) + "\n");
    }
  });
}

async function handleComplete(args: string[]): Promise<void> {
  if (wantsHelp(args)) return printConvoyHelp();
  const id = parseFlag(args, "--id");
  if (!id) {
    console.error("Missing required flag: --id <convoy-id>");
    process.exit(1);
  }
  const actor = resolveActor(args);
  const reason = parseFlag(args, "--reason");
  const options = {
    ...(actor ? { actor } : {}),
    ...(reason ? { terminationReason: reason } : {}),
  };
  await withContainer(args, async (container) => {
    const result = await container.convoyRepo.complete(toConvoyId(id) as ConvoyId, options);
    if (!result.ok) {
      console.error(`Failed to complete convoy: ${result.error.message}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result.value) + "\n");
  });
}

async function handleCancel(args: string[]): Promise<void> {
  if (wantsHelp(args)) return printConvoyHelp();
  const id = parseFlag(args, "--id");
  if (!id) {
    console.error("Missing required flag: --id <convoy-id>");
    process.exit(1);
  }
  const actor = resolveActor(args);
  const reason = parseFlag(args, "--reason");
  const options = {
    ...(actor ? { actor } : {}),
    ...(reason ? { terminationReason: reason } : {}),
  };
  await withContainer(args, async (container) => {
    const result = await container.convoyRepo.cancel(toConvoyId(id) as ConvoyId, options);
    if (!result.ok) {
      console.error(`Failed to cancel convoy: ${result.error.message}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result.value) + "\n");
  });
}

function printConvoyHelp(): void {
  printSubcommandHelp({
    command: "monsthera convoy",
    summary:
      "Manage convoys: named groups of work articles where the lead's progress unblocks members (ADR-009).",
    usage: "<create|list|get|complete|cancel> [options]",
    flags: [
      {
        name: "create --lead W --members W1,W2,... --goal TEXT [--target-phase PHASE] [--actor AGENT]",
        description: "Create a convoy. Default target phase is `implementation`. `--actor` flows into the convoy_created event (default: $MONSTHERA_ACTOR).",
      },
      {
        name: "list [--active]",
        description: "List convoys (currently always active-only — terminal convoys are not surfaced).",
      },
      {
        name: "get --id CONVOY",
        description: "Get a single convoy by id. Exits non-zero with stderr message if the id is unknown.",
      },
      { name: "complete --id CONVOY [--actor AGENT] [--reason TEXT]", description: "Mark a convoy completed. `--actor` and `--reason` flow into the convoy_completed event." },
      { name: "cancel --id CONVOY [--actor AGENT] [--reason TEXT]", description: "Mark a convoy cancelled. `--actor` and `--reason` flow into the convoy_cancelled event." },
      { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
    ],
    notes: [
      "stdout emits one JSON record per matched convoy or per mutation; logs stay on stderr.",
      "Convoys are Dolt-only (orchestration state). The convoy_lead_ready guard is prepended to every non-terminal transition for members.",
      "ADR-010: lifecycle events (convoy_created/completed/cancelled) carry actor + reason as provenance — the convoys table itself stays slim.",
    ],
    examples: [
      "monsthera convoy create --lead w-lead-1 --members w-a,w-b --goal 'Ship X'",
      "monsthera convoy create --lead w-lead-1 --members w-a --goal 'Ship Y' --target-phase review --actor agent-sarah",
      "monsthera convoy list --active",
      "monsthera convoy complete --id cv-abc12345 --reason 'lead reached implementation'",
    ],
  });
}
