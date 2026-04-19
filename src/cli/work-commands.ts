/* eslint-disable no-console */
import { VALID_PHASES } from "../core/types.js";
import type { WorkPhase as WorkPhaseType } from "../core/types.js";
import {
  formatWorkArticle,
  formatTable,
  formatError,
} from "./formatters.js";
import {
  requireFlag,
  parseFlag,
  parsePositional,
  parseCommaSeparated,
  withContainer,
} from "./arg-helpers.js";

export async function handleWork(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "create":
      await handleWorkCreate(subArgs);
      break;
    case "get":
      await handleWorkGet(subArgs);
      break;
    case "list":
      await handleWorkList(subArgs);
      break;
    case "update":
      await handleWorkUpdate(subArgs);
      break;
    case "advance":
      await handleWorkAdvance(subArgs);
      break;
    case "enrich":
      await handleWorkEnrich(subArgs);
      break;
    case "review":
      await handleWorkReview(subArgs);
      break;
    case "delete":
      await handleWorkDelete(subArgs);
      break;
    default:
      console.error(`Unknown work subcommand: ${subcommand ?? "(none)"}`);
      console.error('Run "monsthera --help" for usage.');
      process.exit(1);
  }
}

async function handleWorkCreate(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const title = requireFlag(args, "--title");
    const template = requireFlag(args, "--template");
    const author = requireFlag(args, "--author");
    const priority = parseFlag(args, "--priority") ?? "medium";
    const tags = parseCommaSeparated(args, "--tags");
    const content = parseFlag(args, "--content");

    const input: Record<string, unknown> = { title, template, author, priority };
    if (tags) input.tags = tags;
    if (content) input.content = content;

    const result = await container.workService.createWork(input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkGet(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const result = await container.workService.getWork(id);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkList(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const phaseParam = parseFlag(args, "--phase");
    if (phaseParam && !VALID_PHASES.has(phaseParam as WorkPhaseType)) {
      console.error(`Invalid phase "${phaseParam}". Must be one of: ${[...VALID_PHASES].join(", ")}`);
      process.exit(1);
    }
    const phase = phaseParam as WorkPhaseType | undefined;
    const result = await container.workService.listWork(phase);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    if (result.value.length === 0) {
      process.stdout.write("No work articles found.\n");
      return;
    }

    const headers = ["ID", "TITLE", "TEMPLATE", "PHASE", "PRIORITY", "UPDATED"];
    const rows = result.value.map((w) => [
      w.id,
      w.title,
      w.template,
      w.phase,
      w.priority,
      w.updatedAt,
    ]);
    process.stdout.write(formatTable(headers, rows) + "\n");
  });
}

async function handleWorkUpdate(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const input: Record<string, unknown> = {};
    const title = parseFlag(args, "--title");
    const assignee = parseFlag(args, "--assignee");
    const priority = parseFlag(args, "--priority");
    const tags = parseCommaSeparated(args, "--tags");
    const content = parseFlag(args, "--content");

    if (title) input.title = title;
    if (assignee) input.assignee = assignee;
    if (priority) input.priority = priority;
    if (tags) input.tags = tags;
    if (content) input.content = content;

    if (Object.keys(input).length === 0) {
      console.error("No update fields provided. Use --title, --assignee, --priority, --tags, or --content.");
      process.exit(1);
    }

    const result = await container.workService.updateWork(id, input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkAdvance(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const phaseStr = requireFlag(args, "--phase");
    if (!VALID_PHASES.has(phaseStr as WorkPhaseType)) {
      console.error(`Invalid phase "${phaseStr}". Must be one of: ${[...VALID_PHASES].join(", ")}`);
      process.exit(1);
    }
    const phase = phaseStr as WorkPhaseType;
    const reason = parseFlag(args, "--reason");
    const skipGuardReason = parseFlag(args, "--skip-guard-reason");
    const options: { reason?: string; skipGuard?: { reason: string } } = {};
    if (reason) options.reason = reason;
    if (skipGuardReason) options.skipGuard = { reason: skipGuardReason };
    const result = await container.workService.advancePhase(id, phase, options);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkEnrich(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const role = requireFlag(args, "--role");
    const status = requireFlag(args, "--status");
    if (status !== "contributed" && status !== "skipped") {
      console.error(`Invalid --status "${status}". Must be "contributed" or "skipped".`);
      process.exit(1);
    }
    const result = await container.workService.contributeEnrichment(id, role, status);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkReview(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const reviewer = requireFlag(args, "--reviewer");
    const status = requireFlag(args, "--status");
    if (status !== "approved" && status !== "changes-requested") {
      console.error(`Invalid --status "${status}". Must be "approved" or "changes-requested".`);
      process.exit(1);
    }
    const result = await container.workService.submitReview(id, reviewer, status);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkDelete(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const result = await container.workService.deleteWork(id);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(`Deleted work article: ${id}\n`);
  });
}
