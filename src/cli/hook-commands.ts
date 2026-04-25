/* eslint-disable no-console */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { detectWorktree } from "../core/worktree.js";
import { parseFlag } from "./arg-helpers.js";
import { printSubcommandHelp, wantsHelp } from "./help.js";

const MARKER = "# monsthera-managed-hook";
const HOOK_NAME = "pre-commit";

type Scope = "local" | "global";

/**
 * Resolve the directory git would actually invoke hooks from. Order
 * mirrors the rules a user expects:
 * 1. `core.hooksPath` (local for `--scope local`, global for `--scope global`)
 * 2. `<repoRoot>/.husky/` if it exists — the husky 9 convention is to keep
 *    user-authored hooks alongside the auto-generated `_/` forwarders, so
 *    writing here gets picked up via husky's `core.hooksPath` indirection.
 * 3. `<gitDir>/hooks/` — the classic location. Resolved against the
 *    main repo when invoked from inside a worktree.
 *
 * Local-scope resolution that lands in case 3 must use the *common* git
 * dir, not the worktree's own git dir, otherwise hooks would be installed
 * per-worktree and silently absent everywhere else.
 */
async function resolveHooksDir(scope: Scope, repoPath: string): Promise<string> {
  if (scope === "global") {
    const configured = readGitConfig(["--global", "--get", "core.hooksPath"]);
    if (!configured) {
      throw new Error(
        "global core.hooksPath is not configured. Set it first: " +
          "`git config --global core.hooksPath ~/.config/git/hooks` (or any other path).",
      );
    }
    return expandHome(configured);
  }

  const localConfigured = readGitConfig(["--get", "core.hooksPath"], repoPath);
  if (localConfigured) {
    return path.isAbsolute(localConfigured)
      ? localConfigured
      : path.resolve(repoPath, localConfigured);
  }

  const huskyDir = path.join(repoPath, ".husky");
  if (await dirExists(huskyDir)) return huskyDir;

  const status = await detectWorktree(repoPath);
  const gitRoot = status.mainRepoPath ?? repoPath;
  return path.join(gitRoot, ".git", "hooks");
}

function readGitConfig(args: string[], cwd?: string): string | undefined {
  const res = spawnSync("git", ["config", ...args], {
    cwd: cwd ?? process.cwd(),
    encoding: "utf-8",
  });
  if (res.status !== 0) return undefined;
  const value = (res.stdout ?? "").trim();
  return value.length > 0 ? value : undefined;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(process.env["HOME"] ?? "", p.slice(2));
  return p;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileContents(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Build the hook script body. Uses `pnpm exec monsthera lint` when the
 * containing repo lists `monsthera` in its `package.json` — this lets the
 * Monsthera self-repo run its own hook without a globally-installed binary.
 * Falls back to bare `monsthera` everywhere else.
 */
async function buildHookScript(repoPath: string): Promise<string> {
  const pkgJson = await fileContents(path.join(repoPath, "package.json"));
  let invocation = "monsthera lint --format text";
  if (pkgJson) {
    try {
      const parsed = JSON.parse(pkgJson) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const isSelf = parsed.name === "monsthera";
      const hasDep =
        (parsed.dependencies && "monsthera" in parsed.dependencies) ||
        (parsed.devDependencies && "monsthera" in parsed.devDependencies);
      if (isSelf || hasDep) invocation = "pnpm exec monsthera lint --format text";
    } catch {
      // Malformed package.json — keep the safe default.
    }
  }

  return [
    "#!/usr/bin/env bash",
    `${MARKER} — do not delete this marker line`,
    "set -e",
    "staged=$(git diff --cached --name-only --diff-filter=ACM | " +
      "grep -E '^knowledge/(notes|work-articles)/.*\\.md$' || true)",
    '[ -z "$staged" ] && exit 0',
    `exec ${invocation}`,
    "",
  ].join("\n");
}

export async function handleInstallHook(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera install-hook",
      summary: "Install a pre-commit hook that runs `monsthera lint` on staged knowledge/work .md files.",
      usage: "[--scope local|global] [--overwrite]",
      flags: [
        {
          name: "--scope <s>",
          description:
            "local (default) — current repo. global — git's global hooks dir (must have core.hooksPath set).",
        },
        {
          name: "--overwrite",
          description: "Replace an existing hook even if it is not monsthera-managed. Off by default.",
        },
      ],
      notes: [
        "Resolution order: core.hooksPath > .husky/ > <gitDir>/hooks/. Worktree-aware: hooks land in the main repo's .git so they fire from every worktree.",
        "The installed hook auto-detects pnpm exec for the Monsthera self-repo and falls back to a bare `monsthera` binary elsewhere.",
        "Uninstall via `monsthera uninstall-hook`. Only files containing the `monsthera-managed-hook` marker are removed.",
      ],
      examples: ["monsthera install-hook", "monsthera install-hook --scope global", "monsthera install-hook --overwrite"],
    });
    return;
  }

  const scope = (parseFlag(args, "--scope") as Scope | undefined) ?? "local";
  if (scope !== "local" && scope !== "global") {
    console.error(`Invalid --scope "${scope}" (expected local|global).`);
    process.exit(1);
  }
  const overwrite = args.includes("--overwrite");
  const repoPath = parseFlag(args, "--repo", "-r") ?? process.cwd();

  let hooksDir: string;
  try {
    hooksDir = await resolveHooksDir(scope, repoPath);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  await fs.mkdir(hooksDir, { recursive: true });
  const target = path.join(hooksDir, HOOK_NAME);

  const existing = await fileContents(target);
  if (existing !== null && !overwrite) {
    if (!existing.includes(MARKER)) {
      console.error(
        `Refusing to overwrite ${target}: existing hook is not monsthera-managed. Re-run with --overwrite to replace it.`,
      );
      process.exit(1);
    }
    // Existing monsthera-managed hook — quietly refresh it.
  }

  const body = await buildHookScript(repoPath);
  await fs.writeFile(target, body, { encoding: "utf-8", mode: 0o755 });
  await fs.chmod(target, 0o755);
  console.log(target);
}

export async function handleUninstallHook(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera uninstall-hook",
      summary: "Remove a previously-installed monsthera pre-commit hook.",
      usage: "[--scope local|global]",
      flags: [
        {
          name: "--scope <s>",
          description: "local (default) or global. Mirrors install-hook resolution.",
        },
      ],
      notes: [
        "Only files containing the `monsthera-managed-hook` marker are removed; user-authored hooks are left in place with a clear message.",
      ],
      examples: ["monsthera uninstall-hook", "monsthera uninstall-hook --scope global"],
    });
    return;
  }

  const scope = (parseFlag(args, "--scope") as Scope | undefined) ?? "local";
  if (scope !== "local" && scope !== "global") {
    console.error(`Invalid --scope "${scope}" (expected local|global).`);
    process.exit(1);
  }
  const repoPath = parseFlag(args, "--repo", "-r") ?? process.cwd();

  let hooksDir: string;
  try {
    hooksDir = await resolveHooksDir(scope, repoPath);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const target = path.join(hooksDir, HOOK_NAME);
  const existing = await fileContents(target);
  if (existing === null) {
    console.log(`No hook installed at ${target}; nothing to do.`);
    return;
  }
  if (!existing.includes(MARKER)) {
    console.error(
      `Hook at ${target} is not monsthera-managed; refusing to delete. Inspect manually or remove by hand.`,
    );
    process.exit(1);
  }
  await fs.rm(target, { force: true });
  console.log(`Removed ${target}`);
}
