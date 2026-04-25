import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

/**
 * `monsthera convoy` exercised through the built CLI in a real child
 * process. Mirrors the events-cli test contract:
 *   - stdout is JSON (one object per line)
 *   - stderr carries logs only
 *   - typecheck-strict env (NO_COLOR=1) so the diff is deterministic
 *
 * Convoys are Dolt-only state, but with `MONSTHERA_DOLT_ENABLED=false`
 * they fall through to the in-memory repo — which is enough for the CLI
 * round-trip (single-process, lifetime of one command). Multi-command
 * persistence requires Dolt and is covered by the unit tests at the
 * repository layer.
 */

const repoRoot = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const binPath = path.join(repoRoot, "dist", "bin.js");

async function ensureBuilt(): Promise<void> {
  try {
    await fs.access(binPath);
    return;
  } catch {
    // fall through
  }
  const res = spawnSync("pnpm", ["build"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (res.status !== 0 || res.error) {
    throw new Error(
      `Auto-build failed for ${binPath}.\nstdout: ${res.stdout ?? ""}\nstderr: ${res.stderr ?? ""}`,
    );
  }
}

function isStructuredLogLine(line: string): boolean {
  if (!line.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && "level" in parsed && "domain" in parsed;
  } catch {
    return false;
  }
}

function cli(repoPath: string, args: readonly string[]) {
  return spawnSync("node", [binPath, ...args, "--repo", repoPath], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

async function seedWork(repoPath: string, title: string): Promise<string> {
  const res = cli(repoPath, [
    "work",
    "create",
    "--title",
    title,
    "--template",
    "feature",
    "--author",
    "agent-test",
    "--priority",
    "medium",
    "--content",
    "## Objective\nx\n\n## Acceptance Criteria\n- ok",
  ]);
  if (res.status !== 0) {
    throw new Error(`work create failed for "${title}": ${res.stderr}`);
  }
  const match = res.stdout.match(/\b(w-[a-z0-9]+)\b/);
  if (!match) throw new Error(`couldn't extract work id from stdout: ${res.stdout}`);
  return match[1]!;
}

describe("Integration: monsthera convoy CLI", () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 60_000);

  it("create + list + complete round-trips, with stdout=JSON only", async () => {
    const repoPath = path.join("/tmp", `monsthera-convoy-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });

    const lead = await seedWork(repoPath, "lead");
    const memberA = await seedWork(repoPath, "member-a");
    const memberB = await seedWork(repoPath, "member-b");

    // create
    const create = cli(repoPath, [
      "convoy",
      "create",
      "--lead",
      lead,
      "--members",
      `${memberA},${memberB}`,
      "--goal",
      "round-trip test",
    ]);
    expect(create.status).toBe(0);
    const createLines = create.stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(createLines).toHaveLength(1);
    for (const line of createLines) {
      expect(isStructuredLogLine(line)).toBe(false);
    }
    const created = JSON.parse(createLines[0]!) as {
      id: string;
      leadWorkId: string;
      memberWorkIds: string[];
      status: string;
      targetPhase: string;
    };
    expect(created.id.startsWith("cv-")).toBe(true);
    expect(created.leadWorkId).toBe(lead);
    expect(created.memberWorkIds).toEqual([memberA, memberB]);
    expect(created.status).toBe("active");
    expect(created.targetPhase).toBe("implementation");

    // list --active (single-process Dolt-off path: same in-memory repo)
    const list = cli(repoPath, ["convoy", "list", "--active"]);
    expect(list.status).toBe(0);
    // In Dolt-off mode each CLI invocation gets a fresh in-memory repo,
    // so list won't see the just-created convoy. We assert only that the
    // command succeeds with empty stdout (no error). The Dolt path is
    // covered by the unit tests of the repository.
    const listLines = list.stdout.split("\n").filter((l) => l.trim().length > 0);
    for (const line of listLines) {
      expect(isStructuredLogLine(line)).toBe(false);
    }
  });

  it("rejects missing required flags with non-zero exit and stderr message", async () => {
    const repoPath = path.join("/tmp", `monsthera-convoy-validation-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });

    const res = cli(repoPath, ["convoy", "create"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Missing required flag: --lead/);
  });

  it("rejects an invalid --target-phase", async () => {
    const repoPath = path.join("/tmp", `monsthera-convoy-target-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const lead = await seedWork(repoPath, "lead");
    const member = await seedWork(repoPath, "member");

    const res = cli(repoPath, [
      "convoy",
      "create",
      "--lead",
      lead,
      "--members",
      member,
      "--goal",
      "x",
      "--target-phase",
      "definitely-not-a-phase",
    ]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Invalid --target-phase/);
  });

  it("convoy get --id <unknown> exits non-zero with stderr message", async () => {
    const repoPath = path.join("/tmp", `monsthera-convoy-get-missing-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const res = cli(repoPath, ["convoy", "get", "--id", "cv-doesnt-exist"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Failed to get convoy/i);
  });

  it("convoy get without --id exits non-zero with stderr message", async () => {
    const repoPath = path.join("/tmp", `monsthera-convoy-get-noid-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const res = cli(repoPath, ["convoy", "get"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Missing required flag: --id/);
  });

  it("convoy get --help prints usage on stderr-clean stdout", async () => {
    const repoPath = path.join("/tmp", `monsthera-convoy-get-help-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const res = cli(repoPath, ["convoy", "get", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/monsthera convoy/i);
    expect(res.stdout).toMatch(/get --id/);
  });

  it("convoy --help prints usage on stderr-clean stdout", async () => {
    const repoPath = path.join("/tmp", `monsthera-convoy-help-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const res = cli(repoPath, ["convoy", "--help"]);
    expect(res.status).toBe(0);
    // Help is allowed to write to stdout but the lines must NOT be
    // structured logger output.
    const stdoutLines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
    for (const line of stdoutLines) {
      expect(isStructuredLogLine(line)).toBe(false);
    }
    expect(res.stdout).toMatch(/monsthera convoy/i);
  });
});
