/* eslint-disable no-console */
import * as fs from "node:fs";
import { handleSearchTool } from "../tools/search-tools.js";
import { parseFlag, withContainer } from "./arg-helpers.js";

/**
 * `monsthera pack` — end-to-end build_context_pack (+ optional
 * record_environment_snapshot) from the CLI. Replaces the scratch
 * `scripts/probe.ts` pattern that every Tier 5 session reinvented.
 *
 * Usage:
 *   monsthera pack <query...> [--mode general|code|research] [--limit N]
 *                  [--type knowledge|work|all] [--agent-id A] [--work-id W]
 *                  [--include-content] [--verbose] [--json]
 *                  [--record <path-or-->]
 *
 * `--record <path>` reads JSON from disk first, `--record -` reads JSON
 * from stdin, both call `snapshotService.record` before the pack is built.
 */
export async function handlePack(args: string[]): Promise<void> {
  // Collect positional args as the query (skipping flag values).
  const queryParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      // --json / --include-content / --verbose are bare booleans; everything
      // else consumes the next token as its value. Keep the consumed list in
      // sync with the flag handling below.
      if (arg !== "--json" && arg !== "--include-content" && arg !== "--verbose") {
        i++;
      }
      continue;
    }
    queryParts.push(arg);
  }
  const query = queryParts.join(" ");
  if (!query) {
    console.error("Missing required argument: <query>");
    console.error('Run "monsthera pack <query> [--flags]".');
    process.exit(1);
    return;
  }

  const recordSource = parseFlag(args, "--record");
  const mode = parseFlag(args, "--mode");
  const type = parseFlag(args, "--type");
  const agentId = parseFlag(args, "--agent-id");
  const workId = parseFlag(args, "--work-id");
  const limitRaw = parseFlag(args, "--limit");
  const includeContent = args.includes("--include-content");
  const verbose = args.includes("--verbose");
  const asJson = args.includes("--json");

  await withContainer(args, async (container) => {
    // Optional snapshot recording — reuse the snapshot service directly so
    // payload validation lives in one place (Zod inside snapshot-schema).
    let recordedSnapshotId: string | undefined;
    if (recordSource !== undefined) {
      const raw =
        recordSource === "-"
          ? fs.readFileSync(0, "utf-8")
          : fs.readFileSync(recordSource, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to parse --record JSON from "${recordSource}": ${msg}`);
        process.exit(1);
        return;
      }
      const recordResult = await container.snapshotService.record(parsed);
      if (!recordResult.ok) {
        console.error(`Error [${recordResult.error.code}]: ${recordResult.error.message}`);
        process.exit(1);
        return;
      }
      recordedSnapshotId = recordResult.value.id;
    }

    // Build the pack via the same dispatcher the MCP server uses.
    const packArgs: Record<string, unknown> = { query };
    if (mode !== undefined) packArgs.mode = mode;
    if (type !== undefined) packArgs.type = type;
    if (agentId !== undefined) packArgs.agent_id = agentId;
    if (workId !== undefined) packArgs.work_id = workId;
    if (limitRaw !== undefined) packArgs.limit = Number(limitRaw);
    if (includeContent) packArgs.include_content = true;
    if (verbose) packArgs.verbose = true;

    const response = await handleSearchTool(
      "build_context_pack",
      packArgs,
      container.searchService,
      {
        knowledgeRepo: container.knowledgeRepo,
        workRepo: container.workRepo,
        snapshotService: container.snapshotService,
      },
    );

    const textBlock = response.content[0];
    if (!textBlock || textBlock.type !== "text") {
      console.error("build_context_pack returned no text content");
      process.exit(1);
      return;
    }

    if (response.isError) {
      console.error(textBlock.text);
      process.exit(1);
      return;
    }

    if (asJson) {
      const payload: Record<string, unknown> = JSON.parse(textBlock.text);
      if (recordedSnapshotId !== undefined) payload.recordedSnapshotId = recordedSnapshotId;
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      return;
    }

    const parsed: ContextPackResponse = JSON.parse(textBlock.text);
    process.stdout.write(renderPack(parsed, recordedSnapshotId) + "\n");
  });
}

// ─── Pretty-printing ─────────────────────────────────────────────────────────

interface ContextPackItem {
  readonly id: string;
  readonly title: string;
  readonly type: "knowledge" | "work";
  readonly score: number;
  readonly snippet?: string;
  readonly category?: string;
  readonly template?: string;
  readonly phase?: string;
}

interface ContextPackResponse {
  readonly query: string;
  readonly mode: "general" | "code" | "research";
  readonly summary: {
    readonly itemCount: number;
    readonly knowledgeCount: number;
    readonly workCount: number;
    readonly freshCount: number;
    readonly staleCount: number;
    readonly codeLinkedCount: number;
    readonly sourceLinkedCount: number;
    readonly skippedStaleIndexCount: number;
  };
  readonly guidance: readonly string[];
  readonly items: readonly ContextPackItem[];
  readonly snapshot?: {
    readonly id: string;
    readonly agentId: string;
    readonly workId?: string;
    readonly capturedAt: string;
    readonly ageSeconds: number;
    readonly stale: boolean;
    readonly gitRef?: { branch?: string; sha?: string; dirty?: boolean };
    readonly runtimes: Record<string, string>;
  };
}

function renderPack(pack: ContextPackResponse, recordedSnapshotId?: string): string {
  const lines: string[] = [];
  lines.push(`Pack: query="${pack.query}" mode=${pack.mode}`);
  lines.push(
    `Summary: ${pack.summary.itemCount} items (${pack.summary.knowledgeCount} knowledge, ${pack.summary.workCount} work, ${pack.summary.freshCount} fresh, ${pack.summary.staleCount} stale)`,
  );
  if (recordedSnapshotId !== undefined) {
    lines.push(`Recorded snapshot: ${recordedSnapshotId}`);
  }
  if (pack.snapshot) {
    const git = pack.snapshot.gitRef;
    const ref = git ? `${git.branch ?? "?"}@${(git.sha ?? "").slice(0, 8)}${git.dirty ? " (dirty)" : ""}` : "n/a";
    const runtimes = Object.entries(pack.snapshot.runtimes)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(
      `Snapshot: id=${pack.snapshot.id} age=${pack.snapshot.ageSeconds}s${pack.snapshot.stale ? " (stale)" : ""} git=${ref}${runtimes ? ` runtimes=${runtimes}` : ""}`,
    );
  }
  if (pack.guidance.length > 0) {
    lines.push("Guidance:");
    for (const g of pack.guidance) lines.push(`  - ${g}`);
  }
  lines.push("Items:");
  for (const item of pack.items) {
    const tag = item.category ?? item.template ?? item.type;
    const phase = item.phase ? ` [${item.phase}]` : "";
    lines.push(
      `  ${item.score.toFixed(3)}  [${item.type}/${tag}]${phase} ${item.id}  ${item.title}`,
    );
    if (item.snippet) {
      lines.push(`    ${item.snippet.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  return lines.join("\n");
}
