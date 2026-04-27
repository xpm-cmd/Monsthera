import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSelfDoctor } from "../../../src/ops/doctor.js";
import { manifestPath } from "../../../src/workspace/manifest.js";
import { legacyPidPath, writeProcessMetadata } from "../../../src/ops/process-registry.js";
import type { CommandRunner, CommandSpec } from "../../../src/ops/command-runner.js";
import { ok, err } from "../../../src/core/result.js";
import { StorageError } from "../../../src/core/errors.js";

const cleanups: string[] = [];

async function tempRoot(): Promise<{ installPath: string; repoPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-doctor-"));
  cleanups.push(dir);
  const installPath = path.join(dir, "install");
  const repoPath = path.join(dir, "repo");
  await fs.mkdir(installPath, { recursive: true });
  await fs.mkdir(repoPath, { recursive: true });
  return { installPath, repoPath };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

function notAGitCheckout(): CommandRunner {
  return async (_spec: CommandSpec) => err(new StorageError("not a git repository"));
}

function cleanGitCheckout(installPath: string): CommandRunner {
  const responses = new Map<string, string>([
    [`git rev-parse --show-toplevel`, `${installPath}\n`],
    [`git branch --show-current`, "main\n"],
    [`git rev-parse HEAD`, "abc1234abc1234abc1234abc1234abc1234abc12\n"],
    [`git rev-parse --verify origin/main`, "abc1234abc1234abc1234abc1234abc1234abc12\n"],
    [`git status --porcelain`, ""],
  ]);
  return async (spec: CommandSpec) => {
    const key = `${spec.command} ${spec.args.join(" ")}`;
    if (!responses.has(key)) return err(new StorageError(`unexpected command: ${key}`));
    return ok({ stdout: responses.get(key) ?? "", stderr: "" });
  };
}

describe("runSelfDoctor", () => {
  it("flags non-git installs as a blocker that is not fixable", async () => {
    const { installPath, repoPath } = await tempRoot();
    const result = await runSelfDoctor({ installPath, repoPath, runner: notAGitCheckout() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const blockers = result.value.findings.filter((f) => f.severity === "blocker");
    expect(blockers.some((f) => f.id === "install.not-git")).toBe(true);
    expect(result.value.healthy).toBe(false);
  });

  it("reports missing manifest as a fixable warning when fix=false", async () => {
    const { installPath, repoPath } = await tempRoot();
    const result = await runSelfDoctor({
      installPath,
      repoPath,
      runner: cleanGitCheckout(installPath),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const noManifest = result.value.findings.find((f) => f.id === "workspace.no-manifest");
    expect(noManifest).toBeDefined();
    expect(noManifest?.fixable).toBe(true);
    expect(noManifest?.fixed).toBeUndefined();

    await expect(fs.access(manifestPath(repoPath))).rejects.toBeTruthy();
  });

  it("creates the manifest when invoked with fix=true", async () => {
    const { installPath, repoPath } = await tempRoot();
    const result = await runSelfDoctor({
      installPath,
      repoPath,
      runner: cleanGitCheckout(installPath),
      fix: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const noManifest = result.value.findings.find((f) => f.id === "workspace.no-manifest");
    expect(noManifest?.fixed).toBe(true);
    await expect(fs.access(manifestPath(repoPath))).resolves.toBeUndefined();
    expect(result.value.fixesApplied).toBeGreaterThan(0);
  });

  it("flags legacy pid files and adopts them when fix=true", async () => {
    const { installPath, repoPath } = await tempRoot();
    const legacy = legacyPidPath(installPath, "dolt");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, `${process.pid}\n`, "utf-8");

    const noFix = await runSelfDoctor({
      installPath,
      repoPath,
      runner: cleanGitCheckout(installPath),
    });
    expect(noFix.ok).toBe(true);
    if (!noFix.ok) return;
    expect(noFix.value.findings.some((f) => f.id === "dolt.legacy-pid")).toBe(true);

    const fixed = await runSelfDoctor({
      installPath,
      repoPath,
      runner: cleanGitCheckout(installPath),
      fix: true,
    });
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    const f = fixed.value.findings.find((x) => x.id === "dolt.legacy-pid");
    expect(f?.fixed).toBe(true);
  });

  it("flags stale dolt metadata as fixable", async () => {
    const { installPath, repoPath } = await tempRoot();
    await writeProcessMetadata(installPath, {
      kind: "dolt",
      pid: 0x7ffffffe,
      command: ["/nonexistent/dolt"],
      cwd: installPath,
      startedAt: new Date().toISOString(),
    });

    const result = await runSelfDoctor({
      installPath,
      repoPath,
      runner: cleanGitCheckout(installPath),
      fix: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stale = result.value.findings.find((f) => f.id === "dolt.stale-metadata");
    expect(stale?.fixed).toBe(true);
  });
});
