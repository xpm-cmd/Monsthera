/* eslint-disable no-console */
import {
  formatArticle,
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
import { applyTagDelta } from "../knowledge/tags.js";
import { confirm } from "./prompt.js";
import type { KnowledgeArticle } from "../knowledge/repository.js";
import { parseCustomFilter, matchesCustomFilter, type CustomFilter } from "../knowledge/custom-filter.js";

/**
 * Build a human-readable, field-level diff between an article and a proposed
 * update `input`. Only fields that actually change are listed. `content` is
 * summarized as a character-count delta rather than dumping the whole body,
 * so a `--dry-run` preview stays terminal-friendly.
 */
function describeUpdateDiff(current: KnowledgeArticle, input: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (typeof input.title === "string" && input.title !== current.title) {
    lines.push(`  title: ${JSON.stringify(current.title)} → ${JSON.stringify(input.title)}`);
  }
  if (typeof input.category === "string" && input.category !== current.category) {
    lines.push(`  category: ${JSON.stringify(current.category)} → ${JSON.stringify(input.category)}`);
  }
  if (typeof input.content === "string" && input.content !== current.content) {
    lines.push(`  content: ${current.content.length} → ${input.content.length} chars`);
  }
  if (Array.isArray(input.tags)) {
    const next = input.tags as string[];
    if (JSON.stringify(next) !== JSON.stringify([...current.tags])) {
      lines.push(`  tags: [${current.tags.join(", ")}] → [${next.join(", ")}]`);
    }
  }
  return lines;
}

export async function handleKnowledge(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  if (subcommand === undefined || wantsHelp([subcommand])) {
    printGroupHelp({
      command: "monsthera knowledge",
      summary: "Manage knowledge articles (notes, guides, decisions, patterns).",
      subcommands: [
        { name: "create", summary: "Create a new knowledge article." },
        { name: "get", summary: "Fetch an article by id or slug." },
        { name: "list", summary: "List articles, optionally filtered by category." },
        { name: "update", summary: "Update an article's fields." },
        { name: "delete", summary: "Delete an article by id." },
        { name: "refs", summary: "Query the reference graph (--to, --from, --orphans)." },
        {
          name: "verify-citations",
          summary:
            "Check that inline citation-with-number pairs match the cited article's content.",
        },
      ],
    });
    return;
  }

  switch (subcommand) {
    case "create":
      await handleKnowledgeCreate(subArgs);
      break;
    case "get":
      await handleKnowledgeGet(subArgs);
      break;
    case "list":
      await handleKnowledgeList(subArgs);
      break;
    case "update":
      await handleKnowledgeUpdate(subArgs);
      break;
    case "delete":
      await handleKnowledgeDelete(subArgs);
      break;
    case "refs":
      await handleKnowledgeRefs(subArgs);
      break;
    case "verify-citations":
      await handleKnowledgeVerifyCitations(subArgs);
      break;
    default:
      console.error(`Unknown knowledge subcommand: ${subcommand}`);
      console.error('Run "monsthera knowledge --help" for usage.');
      process.exit(1);
  }
}

async function handleKnowledgeRefs(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera knowledge refs",
      summary: "Query the reference graph across knowledge + work articles.",
      usage: "(--to <id> | --from <id> | --orphans) [--format table|json]",
      flags: [
        { name: "--to <id-or-slug>", description: "List articles that cite <id> (incoming edges)." },
        { name: "--from <id-or-slug>", description: "List articles cited by <id> (outgoing edges)." },
        { name: "--orphans", description: "List every citation whose target does not resolve." },
        { name: "--format <fmt>", description: "table (default) or json." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: [
        "Exactly one of --to, --from, --orphans is required.",
        "Direction: an article's frontmatter `references:` are its OUTGOING citations (what it cites). `--from <id>` lists those outgoing edges; `--to <id>` lists INCOMING edges (who cites <id>); `--orphans` lists outgoing citations whose target does not resolve.",
        "Unlike `knowledge get` connections, this view is unbounded — use it for audits.",
      ],
      examples: [
        "monsthera knowledge refs --to k-canonical-values",
        "monsthera knowledge refs --from w-abc123 --format json",
        "monsthera knowledge refs --orphans",
      ],
    });
    return;
  }

  const to = parseFlag(args, "--to");
  const from = parseFlag(args, "--from");
  const orphans = args.includes("--orphans");
  const format = parseFlag(args, "--format") ?? "table";

  const modeCount = [to !== undefined, from !== undefined, orphans].filter(Boolean).length;
  if (modeCount !== 1) {
    console.error("Pass exactly one of --to <id>, --from <id>, or --orphans.");
    process.exit(1);
  }
  if (!["table", "json"].includes(format)) {
    console.error(`Invalid --format "${format}" (expected table|json).`);
    process.exit(1);
  }

  await withContainer(args, async (container) => {
    if (orphans) {
      const result = await container.structureService.getOrphanCitations();
      if (!result.ok) {
        console.error(formatError(result.error));
        process.exit(1);
      }
      if (format === "json") {
        process.stdout.write(JSON.stringify(result.value, null, 2) + "\n");
        return;
      }
      if (result.value.length === 0) {
        process.stdout.write("No orphan citations.\n");
        return;
      }
      process.stdout.write(
        formatTable(
          ["Source", "Missing ref", "Path"],
          result.value.map((o) => [o.sourceArticleId, o.missingRefId, o.sourcePath ?? ""]),
        ) + "\n",
      );
      return;
    }

    const target = to ?? from!;
    const result = await container.structureService.getRefGraph(target);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    const edges = to !== undefined ? result.value.incoming : result.value.outgoing;
    if (format === "json") {
      process.stdout.write(JSON.stringify(edges, null, 2) + "\n");
      return;
    }
    if (edges.length === 0) {
      const direction = to !== undefined ? "incoming" : "outgoing";
      process.stdout.write(`No ${direction} references for ${target}.\n`);
      return;
    }
    process.stdout.write(
      formatTable(
        ["Id", "Title", "Kind"],
        edges.map((e) => [e.id, e.title, e.kind]),
      ) + "\n",
    );
  });
}

async function handleKnowledgeVerifyCitations(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera knowledge verify-citations",
      summary:
        "Verify inline citation-with-number pairs against the cited article's content.",
      usage: "(<id-or-slug> | --all) [--format table|json]",
      flags: [
        {
          name: "<id-or-slug>",
          description:
            "Verify one article. Mutually exclusive with --all. The article is looked up by id first, then by slug.",
        },
        {
          name: "--all",
          description:
            "Iterate every knowledge + work article. O(N*M) in citation pairs — use with intent.",
        },
        { name: "--format <fmt>", description: "table (default) or json (NDJSON)." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: [
        "Exit code 1 if any mismatch is reported; 0 otherwise.",
        "Orphan citations (unknown target) are not reported here — use `knowledge refs --orphans`.",
      ],
      examples: [
        "monsthera knowledge verify-citations k-wave-2-review",
        "monsthera knowledge verify-citations --all --format json",
      ],
    });
    return;
  }

  const all = args.includes("--all");
  const target = parsePositional(args, 0);
  const format = parseFlag(args, "--format") ?? "table";

  if (all && target) {
    console.error("Pass either <id-or-slug> or --all, not both.");
    process.exit(1);
  }
  if (!all && !target) {
    console.error("Provide <id-or-slug> or pass --all. See `--help` for usage.");
    process.exit(1);
  }
  if (!["table", "json"].includes(format)) {
    console.error(`Invalid --format "${format}" (expected table|json).`);
    process.exit(1);
  }

  await withContainer(args, async (container) => {
    const findings: Array<{
      sourceArticle: string;
      citedArticle: string;
      claimedValue: string;
      foundValues: readonly string[];
      lineHint: string;
    }> = [];

    if (all) {
      const [knowledge, work] = await Promise.all([
        container.knowledgeRepo.findMany(),
        container.workRepo.findMany(),
      ]);
      if (!knowledge.ok) {
        console.error(formatError(knowledge.error));
        process.exit(1);
      }
      if (!work.ok) {
        console.error(formatError(work.error));
        process.exit(1);
      }
      const ids = [...knowledge.value.map((a) => a.id), ...work.value.map((a) => a.id)];
      for (const id of ids) {
        const res = await container.structureService.verifyCitedValues(id);
        if (!res.ok) continue;
        findings.push(...res.value);
      }
    } else {
      const res = await container.structureService.verifyCitedValues(target!);
      if (!res.ok) {
        console.error(formatError(res.error));
        process.exit(1);
      }
      findings.push(...res.value);
    }

    if (format === "json") {
      for (const f of findings) {
        process.stdout.write(JSON.stringify(f) + "\n");
      }
    } else if (findings.length === 0) {
      process.stdout.write("No citation-value mismatches.\n");
    } else {
      process.stdout.write(
        formatTable(
          ["Source", "Cited", "Claimed", "Found (sample)", "Line"],
          findings.map((f) => [
            f.sourceArticle,
            f.citedArticle,
            f.claimedValue,
            f.foundValues.slice(0, 3).join(", "),
            f.lineHint,
          ]),
        ) + "\n",
      );
    }

    if (findings.length > 0) process.exit(1);
  });
}

/**
 * Collect repeatable `--field key=value` flags into a custom-frontmatter map
 * (ADR-020). Values are strings (CLI input). Throws on a malformed pair so the
 * caller sees a clear message rather than silently dropping a field.
 */
function parseFields(args: string[]): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--field") continue;
    const pair = args[i + 1];
    if (pair === undefined) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--field expects key=value, got "${pair}"`);
    }
    fields[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

async function handleKnowledgeCreate(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera knowledge create",
      summary: "Create a new knowledge article.",
      usage: "--title <t> --category <c> (--content <body> | --content-file <path>) [--tags t1,t2] [--code-refs r1,r2]",
      flags: [
        { name: "--title <t>", required: true, description: "Article title." },
        { name: "--category <c>", required: true, description: "Article category (decision, context, guide, solution, pattern, gotcha, etc.)." },
        { name: "--content <body>", description: "Markdown body as a literal string." },
        { name: "--content-file <path>", description: "Read the markdown body verbatim from disk. Avoids shell heredoc corruption of backticks etc." },
        { name: "--tags t1,t2", description: "Comma-separated tag list." },
        { name: "--code-refs r1,r2", description: "Comma-separated code-reference paths." },
        { name: "--field key=value", description: "Custom frontmatter field (repeatable). Persisted verbatim (ADR-020)." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: [
        "Exactly one of --content or --content-file is required.",
      ],
      examples: [
        'monsthera knowledge create --title "API Design" --category architecture --content "REST vs GraphQL..."',
        "monsthera knowledge create --title 'Long Note' --category guide --content-file /tmp/note.md",
      ],
    });
    return;
  }

  await withContainer(args, async (container) => {
    const title = requireFlag(args, "--title");
    const category = requireFlag(args, "--category");
    // --content / --content-file are mutually exclusive. --edit is
    // intentionally not exposed here — knowledge articles are usually
    // written programmatically, and keeping the surface narrow avoids
    // scope creep. Reject it explicitly with a clear message.
    if (args.includes("--edit")) {
      console.error(
        "--edit is not supported on `knowledge create`. Use --content or --content-file.",
      );
      process.exit(1);
    }
    // Narrow the mutual-exclusion error to match the flags this command
    // actually exposes, instead of leaking `readContentInput`'s generic
    // "--content, --content-file, and --edit are mutually exclusive".
    const hasContent = parseFlag(args, "--content") !== undefined;
    const hasContentFile = parseFlag(args, "--content-file") !== undefined;
    if (hasContent && hasContentFile) {
      console.error("Use --content or --content-file, not both.");
      process.exit(1);
    }
    const content = readContentInput(args);
    if (content === undefined) {
      console.error("Missing required flag: --content or --content-file");
      process.exit(1);
    }
    const tags = parseCommaSeparated(args, "--tags");
    const codeRefs = parseCommaSeparated(args, "--code-refs");

    const input: Record<string, unknown> = { title, category, content };
    if (tags) input.tags = tags;
    if (codeRefs) input.codeRefs = codeRefs;
    const fields = parseFields(args);
    if (fields) input.extraFrontmatter = fields;

    const result = await container.knowledgeService.createArticle(input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatArticle(result.value) + "\n");
  });
}

async function handleKnowledgeGet(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera knowledge get",
      summary: "Fetch a knowledge article by id or slug.",
      usage: "<id-or-slug> [--json]",
      positional: [
        { name: "<id-or-slug>", description: "Article id (k-xxxx) or slug." },
      ],
      flags: [
        { name: "--json", description: "Emit the article as JSON (same shape as `list --json` items) instead of the human format." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
    });
    return;
  }

  await withContainer(args, async (container) => {
    const idOrSlug = parsePositional(args, 0);
    if (!idOrSlug) {
      console.error("Missing required argument: <id-or-slug>");
      process.exit(1);
    }
    const asJson = args.includes("--json");

    // Try by ID first, then by slug.
    const result = await container.knowledgeService.getArticle(idOrSlug);
    const found = result.ok
      ? result
      : await container.knowledgeService.getArticleBySlug(idOrSlug);
    if (!found.ok) {
      console.error(formatError(found.error));
      process.exit(1);
    }

    if (asJson) {
      process.stdout.write(JSON.stringify(found.value, null, 2) + "\n");
      return;
    }
    process.stdout.write(formatArticle(found.value) + "\n");
  });
}

async function handleKnowledgeList(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera knowledge list",
      summary: "List knowledge articles.",
      usage: "[--category <c>] [--filter custom.<key><op><value>] [--json] [--no-content]",
      flags: [
        { name: "--category <c>", description: "Filter by category." },
        { name: "--filter <expr>", description: "Custom-frontmatter filter `custom.<key><op><value>` (op: =, <, <=, >, >=). Equality is string-based; comparisons numeric. Scalars only (ADR-020). e.g. custom.replicability_score<0.8" },
        { name: "--json", description: "Emit the full list as JSON (no table)." },
        { name: "--no-content", description: "With --json, omit the (potentially large) `content` field from each item." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
    });
    return;
  }

  await withContainer(args, async (container) => {
    const category = parseFlag(args, "--category");
    const asJson = args.includes("--json");
    const noContent = args.includes("--no-content");
    const filterExpr = parseFlag(args, "--filter");
    let customFilter: CustomFilter | undefined;
    if (filterExpr !== undefined) {
      const parsed = parseCustomFilter(filterExpr);
      if (!parsed.ok) {
        console.error(`Invalid --filter: ${parsed.error}`);
        process.exit(1);
      }
      customFilter = parsed.value;
    }
    const result = await container.knowledgeService.listArticles(category);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    let articles = result.value;
    if (customFilter !== undefined) {
      const cf = customFilter;
      articles = articles.filter((a) => matchesCustomFilter(a.extraFrontmatter, cf));
    }

    if (asJson) {
      const payload = noContent
        ? articles.map(({ content: _content, ...rest }) => rest)
        : articles;
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      return;
    }

    if (articles.length === 0) {
      process.stdout.write("No knowledge articles found.\n");
      return;
    }

    const headers = ["ID", "TITLE", "CATEGORY", "TAGS", "UPDATED"];
    const rows = articles.map((a) => [
      a.id,
      a.title,
      a.category,
      a.tags.join(", "),
      a.updatedAt,
    ]);
    process.stdout.write(formatTable(headers, rows) + "\n");
  });
}

async function handleKnowledgeUpdate(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera knowledge update",
      summary: "Update fields of an existing knowledge article.",
      usage: "<id> [--title <t>] [--category <c>] [--content <body>] [--tags t1,t2 | --add-tag t1,t2 --remove-tag t3]",
      positional: [
        { name: "<id>", description: "Article id (k-xxxx)." },
      ],
      flags: [
        { name: "--title <t>", description: "New title." },
        { name: "--category <c>", description: "New category." },
        { name: "--content <body>", description: "New markdown body (literal string)." },
        { name: "--tags t1,t2", description: "Replace the entire tag list with this comma-separated set." },
        { name: "--add-tag t1,t2", description: "Add tags to the existing set (normalized + deduped). Mutually exclusive with --tags." },
        { name: "--remove-tag t1,t2", description: "Remove tags from the existing set (case-insensitive). Mutually exclusive with --tags." },
        { name: "--field key=value", description: "Set a custom frontmatter field (repeatable). Replaces the article's custom-field map (ADR-020)." },
        { name: "--dry-run", description: "Print the field-level diff that would be applied and exit without writing." },
        { name: "--quiet, -q", description: "On success, print a one-line summary instead of the full article body." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: [
        "At least one of --title, --category, --content, --tags, --add-tag, or --remove-tag is required.",
        "--tags replaces the whole list; --add-tag/--remove-tag edit it incrementally. Do not combine them.",
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
    const category = parseFlag(args, "--category");
    const content = parseFlag(args, "--content");
    const tags = parseCommaSeparated(args, "--tags");
    const addTags = parseCommaSeparated(args, "--add-tag");
    const removeTags = parseCommaSeparated(args, "--remove-tag");

    if (tags && (addTags || removeTags)) {
      console.error("Use --tags (full replace) or --add-tag/--remove-tag (incremental), not both.");
      process.exit(1);
    }

    if (title) input.title = title;
    if (category) input.category = category;
    if (content) input.content = content;
    if (tags) input.tags = tags;
    const fields = parseFields(args);
    if (fields) input.extraFrontmatter = fields;

    // Incremental tag edit: read the current tags, apply the delta, and let
    // the normal updateArticle path re-normalize the result (idempotent).
    if (addTags || removeTags) {
      const current = await container.knowledgeService.getArticle(id);
      if (!current.ok) {
        console.error(formatError(current.error));
        process.exit(1);
      }
      input.tags = applyTagDelta(current.value.tags, addTags ?? [], removeTags ?? []);
    }

    if (Object.keys(input).length === 0) {
      console.error(
        "No update fields provided. Use --title, --category, --content, --tags, --add-tag, --remove-tag, or --field.",
      );
      process.exit(1);
    }

    if (args.includes("--dry-run")) {
      const current = await container.knowledgeService.getArticle(id);
      if (!current.ok) {
        console.error(formatError(current.error));
        process.exit(1);
      }
      const diff = describeUpdateDiff(current.value, input);
      if (diff.length === 0) {
        process.stdout.write(`DRY RUN — no changes for ${id}\n`);
        return;
      }
      process.stdout.write(`DRY RUN — would update ${id}:\n${diff.join("\n")}\n`);
      return;
    }

    const result = await container.knowledgeService.updateArticle(id, input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    if (args.includes("--quiet") || args.includes("-q")) {
      const fields = Object.keys(input).sort().join(", ");
      process.stdout.write(`Updated ${result.value.id} (fields: ${fields})\n`);
      return;
    }
    process.stdout.write(formatArticle(result.value) + "\n");
  });
}

async function handleKnowledgeDelete(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera knowledge delete",
      summary: "Delete a knowledge article by id.",
      usage: "<id> [--dry-run] [--yes]",
      positional: [
        { name: "<id>", description: "Article id (k-xxxx)." },
      ],
      flags: [
        { name: "--dry-run", description: "Print which article would be deleted and exit without removing it." },
        { name: "--yes, -y", description: "Skip the interactive confirmation prompt (required for unattended deletes in a terminal)." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: [
        "In an interactive terminal you are asked to confirm; pass --yes to skip. In a non-interactive context (pipe, CI) the delete proceeds without prompting.",
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

    // Resolve the article (id first, then slug) so dry-run and the confirm
    // prompt can show a human-readable label.
    let found = await container.knowledgeService.getArticle(id);
    if (!found.ok) {
      const bySlug = await container.knowledgeService.getArticleBySlug(id);
      if (bySlug.ok) found = bySlug;
    }
    const label = found.ok ? `${found.value.id} (${found.value.title})` : id;

    if (args.includes("--dry-run")) {
      process.stdout.write(`DRY RUN — would delete ${label}\n`);
      return;
    }

    // Destructive: in an interactive terminal, require confirmation unless
    // --yes was passed. Non-interactive contexts (the explicit isTTY check)
    // proceed unprompted so scripts and CI are not blocked on stdin.
    const skipConfirm = args.includes("--yes") || args.includes("-y");
    if (!skipConfirm && process.stdin.isTTY) {
      const ok = await confirm(`Delete ${label}? This cannot be undone.`);
      if (!ok) {
        process.stdout.write("Aborted.\n");
        return;
      }
    }

    const result = await container.knowledgeService.deleteArticle(id);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(`Deleted knowledge article: ${id}\n`);
  });
}
