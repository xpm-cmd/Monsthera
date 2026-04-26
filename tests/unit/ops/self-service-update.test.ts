import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner, CommandSpec } from "../../../src/ops/command-runner.js";
import { executeSelfUpdate, type SelfUpdateRollback } from "../../../src/ops/self-service.js";
import { ok, err } from "../../../src/core/result.js";
import { StorageError } from "../../../src/core/errors.js";

interface ScriptedResponse {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly fail?: string;
}

interface Recorded {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

function buildRunner(scripts: Map<string, ScriptedResponse>, recorded: Recorded[]): CommandRunner {
  return async (spec: CommandSpec) => {
    recorded.push({ command: spec.command, args: spec.args, cwd: spec.cwd });
    const key = `${path.basename(spec.command)} ${spec.args.join(" ")}`;
    const baseKey = path.basename(spec.command);
    const response = scripts.get(key) ?? scripts.get(baseKey) ?? { stdout: "" };
    if (response.fail) {
      return err(new StorageError(response.fail, { spec: key }));
    }
    return ok({ stdout: response.stdout ?? "", stderr: response.stderr ?? "" });
  };
}

async function makeFakeInstall(): Promise<{ installPath: string; repoPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-update-"));
  const installPath = path.join(root, "install");
  const repoPath = path.join(root, "repo");
  await fs.mkdir(installPath, { recursive: true });
  await fs.mkdir(path.join(repoPath, "knowledge"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "knowledge", "seed.md"), "before update\n", "utf-8");
  return { installPath, repoPath };
}

function gitClean(installPath: string): Map<string, ScriptedResponse> {
  return new Map([
    ["git rev-parse --show-toplevel", { stdout: `${installPath}\n` }],
    ["git branch --show-current", { stdout: "main\n" }],
    ["git rev-parse HEAD", { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" }],
    ["git rev-parse --verify origin/main", { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" }],
    ["git status --porcelain", { stdout: "" }],
    ["git pull --ff-only", { stdout: "Already up to date.\n" }],
    ["pnpm install --frozen-lockfile", { stdout: "Done\n" }],
    ["pnpm build", { stdout: "Built\n" }],
  ]);
}

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("executeSelfUpdate with mocked runner", () => {
  it("runs the happy path end-to-end and reports completed steps", async () => {
    const { installPath, repoPath } = await makeFakeInstall();
    cleanups.push(path.dirname(installPath));

    const scripts = gitClean(installPath);
    scripts.set("node", { stdout: "reindex ok\n" });
    const recorded: Recorded[] = [];
    const runner = buildRunner(scripts, recorded);

    const result = await executeSelfUpdate({ installPath, repoPath, runner });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.steps.map((s) => s.name);
    expect(names).toEqual([
      "workspace backup",
      "stop managed Dolt",
      "git pull --ff-only",
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "workspace migrate",
      "reindex",
      "restart Dolt",
      "restart MCP client",
    ]);
    expect(result.value.steps.every((s) => s.status !== "failed")).toBe(true);

    const commands = recorded.map((r) => `${path.basename(r.command)} ${r.args.join(" ")}`);
    expect(commands).toContain("git pull --ff-only");
    expect(commands).toContain("pnpm install --frozen-lockfile");
    expect(commands).toContain("pnpm build");
  });

  it("rolls back the workspace when pnpm build fails", async () => {
    const { installPath, repoPath } = await makeFakeInstall();
    cleanups.push(path.dirname(installPath));

    const scripts = gitClean(installPath);
    scripts.set("pnpm build", { fail: "build exploded" });

    const recorded: Recorded[] = [];
    const runner = buildRunner(scripts, recorded);

    const result = await executeSelfUpdate({ installPath, repoPath, runner });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.details?.["failedStep"]).toBe("pnpm build");
    const rollback = result.error.details?.["rollback"] as SelfUpdateRollback | undefined;
    expect(rollback).toBeDefined();
    expect(rollback?.performed).toBe(true);
    expect(rollback?.restored).toContain("knowledge");
    expect(rollback?.errors).toEqual([]);

    const seed = await fs.readFile(path.join(repoPath, "knowledge", "seed.md"), "utf-8");
    expect(seed).toBe("before update\n");

    const commands = recorded.map((r) => `${path.basename(r.command)} ${r.args.join(" ")}`);
    expect(commands).toContain("pnpm install --frozen-lockfile");
    expect(commands).toContain("pnpm build");
    expect(commands).not.toContain("node");
  });

  it("reports performed=false when the backup is gone before rollback runs", async () => {
    const { installPath, repoPath } = await makeFakeInstall();
    cleanups.push(path.dirname(installPath));

    const scripts = gitClean(installPath);

    const recorded: Recorded[] = [];
    let backupWiped = false;
    const runner: CommandRunner = async (spec) => {
      recorded.push({ command: spec.command, args: spec.args, cwd: spec.cwd });
      if (spec.command === "pnpm" && spec.args.includes("build")) {
        // Simulate a catastrophic loss of the backup directory mid-update
        // (e.g. operator deleted .monsthera/backups by mistake) so that
        // rollback's restore step has nothing to read.
        await fs.rm(path.join(repoPath, ".monsthera", "backups"), {
          recursive: true,
          force: true,
        });
        backupWiped = true;
        return err(new StorageError("build exploded"));
      }
      const key = `${path.basename(spec.command)} ${spec.args.join(" ")}`;
      const baseKey = path.basename(spec.command);
      const response = scripts.get(key) ?? scripts.get(baseKey) ?? { stdout: "", stderr: "" };
      return ok({ stdout: response.stdout ?? "", stderr: response.stderr ?? "" });
    };

    const result = await executeSelfUpdate({ installPath, repoPath, runner });
    expect(backupWiped).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const rollback = result.error.details?.["rollback"] as SelfUpdateRollback | undefined;
    expect(rollback).toBeDefined();
    expect(rollback?.performed).toBe(false);
    expect(rollback?.errors.some((e) => e.includes("workspace restore failed"))).toBe(true);
    expect(rollback?.doltRestarted).toBe(false);
  });

  it("refuses to execute when working tree is dirty (blocker)", async () => {
    const { installPath, repoPath } = await makeFakeInstall();
    cleanups.push(path.dirname(installPath));

    const scripts = gitClean(installPath);
    scripts.set("git status --porcelain", { stdout: " M package.json\n" });
    const runner = buildRunner(scripts, []);

    const result = await executeSelfUpdate({ installPath, repoPath, runner });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.["blockers"]).toContain("installation working tree is dirty");
  });
});
