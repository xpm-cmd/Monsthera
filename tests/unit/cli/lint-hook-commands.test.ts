import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { handleLint } from "../../../src/cli/lint-commands.js";
import { handleInstallHook, handleUninstallHook } from "../../../src/cli/hook-commands.js";

/**
 * F2 (audit follow-up) — lint-commands.ts and hook-commands.ts sat at
 * 0.97% / 2.29% statement coverage. These tests pin the CURRENT
 * command-level behavior: help surfaces, flag validation + exit codes,
 * the NDJSON/text output split, warning-vs-error exit semantics, and
 * the managed-marker contract of the pre-commit hook pair.
 *
 * process.exit is mocked to THROW (not no-op): several commands keep
 * executing after a validation exit, so a no-op mock would let the test
 * run the code path the real CLI never reaches.
 */

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  return new Promise(async (resolve) => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await fn();
    } finally {
      process.stdout.write = orig;
    }
    resolve(chunks.join(""));
  });
}

async function expectExit(fn: () => Promise<void>, code: number): Promise<void> {
  try {
    await fn();
    expect.fail("expected process.exit");
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    expect(e.code).toBe(code);
  }
}

async function makeRepo(): Promise<string> {
  const repoPath = `/tmp/monsthera-f2-${randomUUID()}`;
  await fs.mkdir(path.join(repoPath, "knowledge", "notes"), { recursive: true });
  return repoPath;
}

function note(id: string, slug: string, opts: { references?: string[]; body?: string } = {}): string {
  const refs = (opts.references ?? []).map((r) => `  - ${r}`).join("\n");
  return [
    "---",
    `id: ${id}`,
    `title: Note ${slug}`,
    `slug: ${slug}`,
    "category: context",
    "tags: []",
    "codeRefs: []",
    `references:${refs.length > 0 ? `\n${refs}` : " []"}`,
    "createdAt: 2026-06-01T00:00:00.000Z",
    "updatedAt: 2026-06-01T00:00:00.000Z",
    "---",
    "",
    opts.body ?? "A perfectly ordinary body.",
    "",
  ].join("\n");
}

// ─── monsthera lint ─────────────────────────────────────────────────────────

describe("handleLint", () => {
  it("--help prints the usage surface without running a scan", async () => {
    const output = await captureStdout(() => handleLint(["--help"]));
    expect(output).toContain("monsthera lint");
    expect(output).toContain("--registry");
    expect(output).toContain("Exit code 1");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it.each([
    [["--include", "bogus"], "Invalid --include"],
    [["--registry", "bogus"], "Invalid --registry"],
    [["--format", "bogus"], "Invalid --format"],
    [["--verify-density-threshold", "2"], "Invalid --verify-density-threshold"],
  ])("rejects %j with exit 1", async (args, message) => {
    await expectExit(() => handleLint(args as string[]), 1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(message);
  });

  it("clean corpus: no findings on stdout, no exit", async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, "knowledge", "notes", "clean.md"), note("k-f2clean1", "clean"), "utf-8");

    const output = await captureStdout(() => handleLint(["--repo", repo]));
    expect(output.trim()).toBe("");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("orphan citation is a WARNING: NDJSON finding on stdout, exit stays 0", async () => {
    const repo = await makeRepo();
    await fs.writeFile(
      path.join(repo, "knowledge", "notes", "citing.md"),
      note("k-f2citer1", "citing", { references: ["k-missing9"] }),
      "utf-8",
    );

    const output = await captureStdout(() => handleLint(["--repo", repo]));
    const lines = output.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const finding = JSON.parse(lines[0]!) as { rule: string; severity: string; missingRefId: string };
    expect(finding.rule).toBe("orphan_citation");
    expect(finding.severity).toBe("warning");
    expect(finding.missingRefId).toBe("k-missing9");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("--format text renders the human table instead of NDJSON", async () => {
    const repo = await makeRepo();
    await fs.writeFile(
      path.join(repo, "knowledge", "notes", "citing.md"),
      note("k-f2citer2", "citing-two", { references: ["k-missing8"] }),
      "utf-8",
    );

    const output = await captureStdout(() => handleLint(["--repo", repo, "--format", "text"]));
    expect(output).toContain("WARNING");
    expect(output).toContain("orphan citation k-missing8");
    expect(() => JSON.parse(output.trim().split("\n")[0]!)).toThrow();
  });
});

// ─── monsthera install-hook / uninstall-hook ────────────────────────────────

const MARKER = "monsthera-managed-hook";

async function makeGitRepo(): Promise<string> {
  const repoPath = `/tmp/monsthera-f2-hook-${randomUUID()}`;
  await fs.mkdir(repoPath, { recursive: true });
  const init = spawnSync("git", ["init", "-q"], { cwd: repoPath, encoding: "utf-8" });
  if (init.status !== 0) throw new Error("git init failed");
  return repoPath;
}

describe("handleInstallHook / handleUninstallHook", () => {
  it("--help prints usage and touches nothing", async () => {
    const output = await captureStdout(() => handleInstallHook(["--help"]));
    expect(output).toContain("monsthera install-hook");
    expect(output).toContain("--overwrite");
  });

  it("installs an executable pre-commit hook carrying the managed marker", async () => {
    const repo = await makeGitRepo();
    await handleInstallHook(["--repo", repo]);

    const target = path.join(repo, ".git", "hooks", "pre-commit");
    const body = await fs.readFile(target, "utf-8");
    expect(body).toContain(MARKER);
    const mode = (await fs.stat(target)).mode & 0o111;
    expect(mode).not.toBe(0);
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toBe(target);
  });

  it("refuses to overwrite a foreign hook without --overwrite, replaces it with the flag", async () => {
    const repo = await makeGitRepo();
    const target = path.join(repo, ".git", "hooks", "pre-commit");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "#!/bin/sh\necho user-authored\n", "utf-8");

    await expectExit(() => handleInstallHook(["--repo", repo]), 1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("Refusing to overwrite");
    expect(await fs.readFile(target, "utf-8")).toContain("user-authored");

    await handleInstallHook(["--repo", repo, "--overwrite"]);
    expect(await fs.readFile(target, "utf-8")).toContain(MARKER);
  });

  it("quietly refreshes an existing monsthera-managed hook without --overwrite", async () => {
    const repo = await makeGitRepo();
    await handleInstallHook(["--repo", repo]);
    await handleInstallHook(["--repo", repo]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("uninstall removes ONLY managed hooks; foreign hooks survive with exit 1", async () => {
    const repo = await makeGitRepo();
    const target = path.join(repo, ".git", "hooks", "pre-commit");

    await handleInstallHook(["--repo", repo]);
    await handleUninstallHook(["--repo", repo]);
    await expect(fs.access(target)).rejects.toThrow();
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain("Removed");

    await fs.writeFile(target, "#!/bin/sh\necho user-authored\n", "utf-8");
    await expectExit(() => handleUninstallHook(["--repo", repo]), 1);
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain("not monsthera-managed");
    expect(await fs.readFile(target, "utf-8")).toContain("user-authored");
  });

  it("uninstall with no hook installed reports nothing-to-do without error", async () => {
    const repo = await makeGitRepo();
    await handleUninstallHook(["--repo", repo]);
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain("nothing to do");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid --scope with exit 1 (both commands)", async () => {
    await expectExit(() => handleInstallHook(["--scope", "bogus"]), 1);
    await expectExit(() => handleUninstallHook(["--scope", "bogus"]), 1);
  });
});
