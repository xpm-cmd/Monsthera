/* eslint-disable no-console */
import { spawnSync } from "node:child_process";
import { parseFlag, parsePositional, withContainer } from "./arg-helpers.js";
import { printSubcommandHelp, wantsHelp } from "./help.js";

/**
 * `monsthera code <subcommand>` — code-ref intelligence (ADR-015 Layer 1)
 * exposed at the CLI surface. The MCP tools `code_get_ref`, `code_find_owners`,
 * `code_analyze_impact`, and `code_detect_changes` already cover agent
 * access; these commands make the same operations available to humans and
 * shell scripts.
 *
 * Output contract: one JSON record per command on stdout, errors to stderr
 * with a non-zero exit. Mirrors `monsthera convoy` and `monsthera events` so
 * shell pipes (`monsthera code impact src/foo.ts | jq .risk`) work uniformly.
 */
export async function handleCode(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || wantsHelp(args)) {
    return printCodeHelp();
  }
  switch (sub) {
    case "ref":
      return handleRef(args.slice(1));
    case "owners":
      return handleOwners(args.slice(1));
    case "impact":
      return handleImpact(args.slice(1));
    case "changes":
      return handleChanges(args.slice(1));
    default:
      console.error(`Unknown code subcommand: ${sub}`);
      console.error('Run "monsthera code --help" for usage.');
      process.exit(1);
  }
}

async function handleRef(args: string[]): Promise<void> {
  if (wantsHelp(args)) return printCodeHelp();
  const ref = parsePositional(args, 0);
  if (!ref) {
    console.error("Missing required argument: <path>");
    process.exit(1);
  }
  await withContainer(args, async (container) => {
    const result = await container.codeIntelligenceService.getCodeRef({ ref });
    if (!result.ok) {
      console.error(`Failed to get code ref: ${result.error.message}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result.value) + "\n");
  });
}

async function handleOwners(args: string[]): Promise<void> {
  if (wantsHelp(args)) return printCodeHelp();
  const ref = parsePositional(args, 0);
  if (!ref) {
    console.error("Missing required argument: <path>");
    process.exit(1);
  }
  await withContainer(args, async (container) => {
    const result = await container.codeIntelligenceService.findCodeOwners({ ref });
    if (!result.ok) {
      console.error(`Failed to find owners: ${result.error.message}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result.value) + "\n");
  });
}

async function handleImpact(args: string[]): Promise<void> {
  if (wantsHelp(args)) return printCodeHelp();
  const ref = parsePositional(args, 0);
  if (!ref) {
    console.error("Missing required argument: <path>");
    process.exit(1);
  }
  await withContainer(args, async (container) => {
    const result = await container.codeIntelligenceService.analyzeCodeRefImpact({ ref });
    if (!result.ok) {
      console.error(`Failed to analyze impact: ${result.error.message}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result.value) + "\n");
  });
}

async function handleChanges(args: string[]): Promise<void> {
  if (wantsHelp(args)) return printCodeHelp();
  const staged = args.includes("--staged");
  const base = parseFlag(args, "--base");
  if (staged && base !== undefined) {
    console.error("--staged and --base are mutually exclusive");
    process.exit(1);
  }
  const repoPath = parseFlag(args, "--repo", "-r") ?? process.cwd();
  const changedPaths = collectChangedPaths(repoPath, { staged, base });
  if (!changedPaths.ok) {
    console.error(changedPaths.message);
    process.exit(1);
  }

  await withContainer(args, async (container) => {
    const result = await container.codeIntelligenceService.detectChangedCodeRefs({
      changedPaths: changedPaths.paths,
    });
    if (!result.ok) {
      console.error(`Failed to detect changes: ${result.error.message}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result.value) + "\n");
  });
}

interface ChangedPathsOk {
  readonly ok: true;
  readonly paths: string[];
}

interface ChangedPathsErr {
  readonly ok: false;
  readonly message: string;
}

/**
 * Capture `git diff --name-only` output for the requested mode. The MCP
 * server intentionally never shells out to git (ADR-015 Resolved Decisions);
 * the CLI is the right surface to bridge git into the
 * `detect_changed_code_refs` contract because it's already running in the
 * operator's working tree with their credentials.
 *
 * Default mode (`HEAD`) covers staged + unstaged tracked changes. `--staged`
 * narrows to index-only changes (matches what a pre-commit hook sees).
 * `--base <ref>` covers an arbitrary range — useful for review bots that
 * compare a feature branch against `origin/main`.
 *
 * Empty diff → empty array. The service rejects the empty input with
 * `VALIDATION_FAILED` at the MCP boundary, but at the CLI boundary an empty
 * diff is a normal "nothing to do" signal — we surface a zero-impact
 * payload so callers don't need to special-case the absence of changes.
 */
function collectChangedPaths(
  repoPath: string,
  options: { staged: boolean; base: string | undefined },
): ChangedPathsOk | ChangedPathsErr {
  const args = ["diff", "--name-only"];
  if (options.staged) {
    args.push("--cached");
  } else if (options.base !== undefined) {
    args.push(`${options.base}...HEAD`);
  } else {
    args.push("HEAD");
  }

  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf-8",
  });
  if (result.error) {
    return { ok: false, message: `git diff failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    return {
      ok: false,
      message: `git diff exited with status ${result.status}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  const paths = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { ok: true, paths };
}

function printCodeHelp(): void {
  printSubcommandHelp({
    command: "monsthera code",
    summary:
      "Code-ref intelligence (ADR-015 Layer 1): inspect a path's Monsthera footprint, discover its owners, score change impact, and detect impact across a git diff.",
    usage: "<ref|owners|impact|changes> [path] [options]",
    flags: [
      {
        name: "ref <path>",
        description:
          "Inspect a single code reference: existence, line anchor, owners, active work, policies, and summary counts.",
      },
      {
        name: "owners <path>",
        description:
          "List the knowledge and work articles linked to a path, without filesystem stat or risk scoring. Faster than `impact` when you only need ownership.",
      },
      {
        name: "impact <path>",
        description:
          "Score the operational impact of touching a path: risk, reasons, recommended next actions, plus full owner detail.",
      },
      {
        name: "changes [--staged] [--base <ref>] [--repo <path>]",
        description:
          "Analyze a git diff: default is `HEAD` (staged + unstaged); `--staged` narrows to the index; `--base <ref>` diffs `<ref>...HEAD`.",
      },
      { name: "--repo, -r <path>", description: "Repository path used for git diff and container resolution.", default: "cwd" },
    ],
    notes: [
      "stdout emits a single JSON record per invocation; logs stay on stderr.",
      "`changes` shells out to `git` in the CLI rather than the MCP server, preserving the MCP boundary as side-effect-free (ADR-015 Resolved Decisions).",
      "An empty diff produces a zero-impact payload (changedPathCount: 0), not an error — useful for pre-commit hooks that run unconditionally.",
      "Path matching is exact + directory-prefix; glob expansion happens in the caller (e.g., your shell), not in this command.",
    ],
    examples: [
      "monsthera code ref src/auth/session.ts",
      "monsthera code owners src/auth/session.ts#L42",
      "monsthera code impact src/dashboard/index.ts",
      "monsthera code changes",
      "monsthera code changes --staged",
      "monsthera code changes --base origin/main",
    ],
  });
}
