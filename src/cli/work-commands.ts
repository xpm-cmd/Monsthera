/* eslint-disable no-console */
import { VALID_PHASES, WorkPhase, WorkTemplate } from "../core/types.js";
import type { WorkPhase as WorkPhaseType, WorkTemplate as WorkTemplateType } from "../core/types.js";
import { generateInitialContent } from "../work/templates.js";
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
  readContentInput,
  withContainer,
} from "./arg-helpers.js";
import { printGroupHelp, printSubcommandHelp, wantsHelp } from "./help.js";

function isWorkTemplate(value: string): value is WorkTemplateType {
  return (Object.values(WorkTemplate) as string[]).includes(value);
}

export async function handleWork(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  if (subcommand === undefined || wantsHelp([subcommand])) {
    printGroupHelp({
      command: "monsthera work",
      summary: "Manage work articles (planning → enrichment → implementation → review → done).",
      subcommands: [
        { name: "create", summary: "Create a new work article." },
        { name: "get", summary: "Fetch a work article by id." },
        { name: "list", summary: "List work articles." },
        { name: "update", summary: "Update an article's fields." },
        { name: "advance", summary: "Advance the phase of a work article." },
        { name: "enrich", summary: "Record an enrichment contribution." },
        { name: "review", summary: "Submit a reviewer verdict." },
        { name: "close", summary: "Close straight to done with an audit reason." },
        { name: "delete", summary: "Delete a work article by id." },
      ],
    });
    return;
  }

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
    case "close":
      await handleWorkClose(subArgs);
      break;
    case "delete":
      await handleWorkDelete(subArgs);
      break;
    default:
      console.error(`Unknown work subcommand: ${subcommand}`);
      console.error('Run "monsthera work --help" for usage.');
      process.exit(1);
  }
}

async function handleWorkCreate(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera work create",
      summary: "Create a new work article.",
      usage: "--title <t> --template <feature|bugfix|refactor|spike> --author <a> [flags]",
      flags: [
        { name: "--title <t>", required: true, description: "Work article title." },
        { name: "--template <t>", required: true, description: "One of feature | bugfix | refactor | spike." },
        { name: "--author <a>", required: true, description: "Author agent id or name." },
        { name: "--priority <p>", description: "low | medium | high | critical.", default: "medium" },
        { name: "--tags t1,t2", description: "Comma-separated tag list." },
        { name: "--blocked-by w-a,w-b", description: "Comma-separated work ids that block this article (populates frontmatter.blockedBy)." },
        { name: "--dependencies w-a,w-b", description: "Comma-separated work ids this article depends on (populates frontmatter.dependencies)." },
        { name: "--content <body>", description: "Markdown body as a literal string." },
        { name: "--content-file <path>", description: "Markdown body read from disk." },
        { name: "--edit", description: "Open $EDITOR on a scratch buffer seeded from the template." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: [
        "--content, --content-file, and --edit are mutually exclusive.",
        "--blocked-by and --dependencies values must reference existing work articles; invalid ids error out before creation.",
      ],
      examples: [
        'monsthera work create --title "Add auth" --template feature --author agent-1 --priority high',
        "monsthera work create --title 'Wave 2: API' --template feature --author agent-1 --blocked-by w-xxx,w-yyy",
      ],
    });
    return;
  }

  await withContainer(args, async (container) => {
    const title = requireFlag(args, "--title");
    const template = requireFlag(args, "--template");
    const author = requireFlag(args, "--author");
    const priority = parseFlag(args, "--priority") ?? "medium";
    const tags = parseCommaSeparated(args, "--tags");
    const blockedBy = parseCommaSeparated(args, "--blocked-by");
    const dependencies = parseCommaSeparated(args, "--dependencies");
    const seed = isWorkTemplate(template) ? generateInitialContent(template) : "";
    const content = readContentInput(args, { seed });

    // Validate referenced work ids before touching the service. The in-memory
    // repo would surface the same error via addDependency post-creation, but
    // rejecting up front gives a clearer error and avoids creating an article
    // with dangling ids in its frontmatter.
    const referencedIds = [...(blockedBy ?? []), ...(dependencies ?? [])];
    for (const id of referencedIds) {
      const found = await container.workRepo.findById(id);
      if (!found.ok) {
        console.error(
          `Referenced work id not found: ${id}. Check --blocked-by / --dependencies values.`,
        );
        process.exit(1);
      }
    }

    const input: Record<string, unknown> = { title, template, author, priority };
    if (tags) input.tags = tags;
    if (blockedBy) input.blockedBy = blockedBy;
    if (dependencies) input.dependencies = dependencies;
    if (content !== undefined) input.content = content;

    const result = await container.workService.createWork(input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkGet(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera work get",
      summary: "Fetch a work article by id.",
      usage: "<id>",
      positional: [{ name: "<id>", description: "Work article id (w-xxxx)." }],
      flags: [{ name: "--repo, -r <path>", description: "Repository path.", default: "cwd" }],
    });
    return;
  }

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

type WorkListFormat = "table" | "csv" | "tsv" | "json";

const VALID_FORMATS: ReadonlySet<string> = new Set(["table", "csv", "tsv", "json"]);

async function handleWorkList(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera work list",
      summary: "List work articles with optional filters.",
      usage: "[--phase <p>] [--tag <t>] [--wave <name>] [--phase-age-days <n>] [--format table|csv|tsv|json] [--json]",
      flags: [
        { name: "--phase <p>", description: `Filter by phase. One of: ${[...VALID_PHASES].join(" | ")}` },
        { name: "--tag <t>", description: "Filter by a single tag (article must carry it)." },
        { name: "--wave <name>", description: "Shorthand: matches tag `wave-<name>` or the literal name." },
        { name: "--phase-age-days <n>", description: "Only articles whose current phase is at least <n> days old (by latest phaseHistory.enteredAt)." },
        { name: "--format <fmt>", description: "table (default) | csv | tsv | json (NDJSON).", default: "table" },
        { name: "--json", description: "Alias for --format json. Kept for backwards compatibility." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: [
        "Filters are AND-combined. `--phase` goes through the repo's findByPhase; the rest are in-memory.",
        "CSV/TSV/JSON output is stream-friendly (logs stay on stderr).",
      ],
    });
    return;
  }

  const phaseParam = parseFlag(args, "--phase");
  if (phaseParam && !VALID_PHASES.has(phaseParam as WorkPhaseType)) {
    console.error(`Invalid phase "${phaseParam}". Must be one of: ${[...VALID_PHASES].join(", ")}`);
    process.exit(1);
  }

  const tag = parseFlag(args, "--tag");
  const wave = parseFlag(args, "--wave");
  const phaseAgeDaysRaw = parseFlag(args, "--phase-age-days");
  let phaseAgeDays: number | undefined;
  if (phaseAgeDaysRaw !== undefined) {
    const n = Number(phaseAgeDaysRaw);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`Invalid --phase-age-days "${phaseAgeDaysRaw}" (expected a non-negative number).`);
      process.exit(1);
    }
    phaseAgeDays = n;
  }

  const formatFlag = parseFlag(args, "--format");
  let format: WorkListFormat = "table";
  if (formatFlag !== undefined) {
    if (!VALID_FORMATS.has(formatFlag)) {
      console.error(`Invalid --format "${formatFlag}" (expected table|csv|tsv|json).`);
      process.exit(1);
    }
    format = formatFlag as WorkListFormat;
  } else if (args.includes("--json")) {
    format = "json";
  }

  await withContainer(args, async (container) => {
    const phase = phaseParam as WorkPhaseType | undefined;
    const result = await container.workService.listWork(phase);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    const filtered = result.value.filter((w) => {
      if (tag !== undefined && !w.tags.includes(tag)) return false;
      if (wave !== undefined && !(w.tags.includes(`wave-${wave}`) || w.tags.includes(wave))) {
        return false;
      }
      if (phaseAgeDays !== undefined && currentPhaseAgeDays(w) < phaseAgeDays) {
        return false;
      }
      return true;
    });

    process.stdout.write(formatWorkList(filtered, format) + (format === "table" ? "\n" : ""));
  });
}

function currentPhaseAgeDays(article: { phaseHistory: readonly { enteredAt: string }[] }): number {
  const latest = article.phaseHistory[article.phaseHistory.length - 1];
  if (!latest) return 0;
  const enteredMs = Date.parse(latest.enteredAt);
  if (!Number.isFinite(enteredMs)) return 0;
  return (Date.now() - enteredMs) / (1000 * 60 * 60 * 24);
}

type WorkListRow = {
  id: string;
  title: string;
  template: string;
  phase: string;
  priority: string;
  updatedAt: string;
};

function toListRow(article: {
  id: string;
  title: string;
  template: string;
  phase: string;
  priority: string;
  updatedAt: string;
}): WorkListRow {
  return {
    id: article.id,
    title: article.title,
    template: article.template,
    phase: article.phase,
    priority: article.priority,
    updatedAt: article.updatedAt,
  };
}

function formatWorkList(
  articles: ReadonlyArray<Parameters<typeof toListRow>[0]>,
  format: WorkListFormat,
): string {
  if (format === "json") {
    // NDJSON of the full article shape so downstream callers get blockedBy,
    // dependencies, tags, phaseHistory, etc. — CSV/TSV below stick to the
    // summary columns since a flat table needs a flat shape.
    return articles.map((a) => JSON.stringify(a)).join("\n") + (articles.length > 0 ? "\n" : "");
  }

  if (articles.length === 0 && format === "table") {
    return "No work articles found.";
  }

  const headers = ["id", "title", "template", "phase", "priority", "updatedAt"];
  const rows = articles.map((a) => {
    const r = toListRow(a);
    return [r.id, r.title, r.template, r.phase, r.priority, r.updatedAt];
  });

  if (format === "csv") {
    return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n") + (rows.length > 0 ? "\n" : "");
  }
  if (format === "tsv") {
    return [headers, ...rows].map((row) => row.map(tsvEscape).join("\t")).join("\n") + (rows.length > 0 ? "\n" : "");
  }

  return formatTable(
    ["ID", "TITLE", "TEMPLATE", "PHASE", "PRIORITY", "UPDATED"],
    rows,
  );
}

function csvEscape(field: string): string {
  if (/[",\n\r]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

function tsvEscape(field: string): string {
  return field.replace(/[\t\n\r]/g, " ");
}

async function handleWorkUpdate(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera work update",
      summary: "Update fields of an existing work article.",
      usage: "<id> [--title <t>] [--assignee <a>] [--priority <p>] [--tags t1,t2] [--blocked-by ids | --dependencies ids] [--content ... | --content-file ... | --edit]",
      positional: [{ name: "<id>", description: "Work article id." }],
      flags: [
        { name: "--title <t>", description: "New title." },
        { name: "--assignee <a>", description: "New assignee id." },
        { name: "--priority <p>", description: "New priority." },
        { name: "--tags t1,t2", description: "Replace the tag list." },
        { name: "--blocked-by ids", description: "Add these work ids as dependencies (comma-separated; idempotent; each adds to both blockedBy and dependencies)." },
        { name: "--dependencies ids", description: "Alias of --blocked-by on update: the repo's addDependency primitive maintains blockedBy ⊆ dependencies." },
        { name: "--content <body>", description: "New markdown body (literal string)." },
        { name: "--content-file <path>", description: "Read new markdown body from disk." },
        { name: "--edit", description: "Open $EDITOR on the existing body." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: [
        "--content, --content-file, and --edit are mutually exclusive.",
        "--blocked-by / --dependencies go through addDependency so each add emits an orchestration event and is auditable. Use `work create --blocked-by ...` to set the initial set atomically.",
        "At least one update field is required.",
      ],
    });
    return;
  }

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
    const blockedBy = parseCommaSeparated(args, "--blocked-by");
    const dependencies = parseCommaSeparated(args, "--dependencies");
    const content = readContentInput(args);

    if (title) input.title = title;
    if (assignee) input.assignee = assignee;
    if (priority) input.priority = priority;
    if (tags) input.tags = tags;
    if (content !== undefined) input.content = content;

    const depsToAdd = [...(blockedBy ?? []), ...(dependencies ?? [])];
    if (Object.keys(input).length === 0 && depsToAdd.length === 0) {
      console.error(
        "No update fields provided. Use --title, --assignee, --priority, --tags, --blocked-by, --dependencies, --content, --content-file, or --edit.",
      );
      process.exit(1);
    }

    // Apply non-dependency updates first so the article title in any
    // subsequent error message is already current.
    let latest: unknown = undefined;
    if (Object.keys(input).length > 0) {
      const result = await container.workService.updateWork(id, input);
      if (!result.ok) {
        console.error(formatError(result.error));
        process.exit(1);
      }
      latest = result.value;
    }

    // Then apply each dependency. addDependency validates the referenced id
    // exists and is idempotent, so re-runs are safe and the orchestration
    // event trail mirrors the MCP `add_dependency` tool exactly.
    for (const depId of depsToAdd) {
      const result = await container.workService.addDependency(id, depId);
      if (!result.ok) {
        console.error(formatError(result.error));
        process.exit(1);
      }
      latest = result.value;
    }

    // Fall back to the pre-update state if the caller only passed -h etc.
    if (latest === undefined) {
      const fetched = await container.workService.getWork(id);
      if (!fetched.ok) {
        console.error(formatError(fetched.error));
        process.exit(1);
      }
      latest = fetched.value;
    }
    process.stdout.write(formatWorkArticle(latest as Parameters<typeof formatWorkArticle>[0]) + "\n");
  });
}

async function handleWorkAdvance(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera work advance",
      summary: "Advance a work article to a new phase.",
      usage: "<id> --phase <target> [--reason <text>] [--skip-guard-reason <text>]",
      positional: [{ name: "<id>", description: "Work article id." }],
      flags: [
        { name: "--phase <target>", required: true, description: `One of: ${[...VALID_PHASES].join(" | ")}` },
        { name: "--reason <text>", description: "Free-text reason recorded in phase history." },
        { name: "--skip-guard-reason <text>", description: "Bypass phase guards with an audit reason." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
    });
    return;
  }

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
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera work enrich",
      summary: "Record an enrichment contribution from a specialist role.",
      usage: "<id> --role <role> --status <contributed|skipped>",
      positional: [{ name: "<id>", description: "Work article id." }],
      flags: [
        { name: "--role <role>", required: true, description: "Role identifier (e.g. security, architecture)." },
        { name: "--status <s>", required: true, description: "Either 'contributed' or 'skipped'." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
    });
    return;
  }

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
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera work review",
      summary: "Submit a reviewer verdict on a work article.",
      usage: "<id> --reviewer <agent-id> --status <approved|changes-requested>",
      positional: [{ name: "<id>", description: "Work article id." }],
      flags: [
        { name: "--reviewer <id>", required: true, description: "Reviewer agent id." },
        { name: "--status <s>", required: true, description: "Either 'approved' or 'changes-requested'." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
    });
    return;
  }

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

async function handleWorkClose(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera work close",
      summary: "Advance a work article straight to done with an auditable reason.",
      usage: "<id> (--pr <n> | --reason <text>)",
      positional: [{ name: "<id>", description: "Work article id." }],
      flags: [
        { name: "--pr <n>", description: "Close with canonical 'merged via PR #N' reason." },
        { name: "--reason <text>", description: "Close with verbatim reason text." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: ["Exactly one of --pr or --reason is required."],
    });
    return;
  }

  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const reasonFlag = parseFlag(args, "--reason");
    const prFlag = parseFlag(args, "--pr");
    let reason: string;
    if (reasonFlag) {
      reason = reasonFlag;
    } else if (prFlag) {
      // Accept "42", "#42", and "PR #42" — strip leading "#".
      const normalized = prFlag.replace(/^#/, "").trim();
      reason = `merged via PR #${normalized}; no external reviewer — bypass recorded on phase history`;
    } else {
      console.error(
        "work close requires --reason <text> or --pr <number> so the review→done bypass is auditable.",
      );
      process.exit(1);
      return;
    }

    const result = await container.workService.advancePhase(id, WorkPhase.DONE, {
      skipGuard: { reason },
    });
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkDelete(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera work delete",
      summary: "Delete a work article by id.",
      usage: "<id>",
      positional: [{ name: "<id>", description: "Work article id." }],
      flags: [{ name: "--repo, -r <path>", description: "Repository path.", default: "cwd" }],
    });
    return;
  }

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
