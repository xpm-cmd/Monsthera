import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

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
    // Fall through.
  }
  const res = spawnSync("pnpm", ["build"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (res.status !== 0 || res.error) {
    throw new Error(
      `Auto-build failed. stdout: ${res.stdout ?? ""}\nstderr: ${res.stderr ?? ""}\nerror: ${res.error?.message ?? "(none)"}`,
    );
  }
}

function cli(repoPath: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("node", [binPath, ...args, "--repo", repoPath], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

async function seedOneFeature(repoPath: string): Promise<string> {
  const res = cli(repoPath, [
    "work", "create",
    "--title", "Advance me",
    "--template", "bugfix",
    "--author", "agent-1",
    "--content", "## Objective\nseed\n\n## Steps to Reproduce\n1. s\n\n## Acceptance Criteria\n- [ ] a",
  ]);
  if (res.status !== 0) throw new Error(`seed failed: ${res.stderr}`);
  const match = res.stdout.match(/ID:\s+(w-\S+)/);
  if (!match) throw new Error(`no id in create output: ${res.stdout}`);
  return match[1]!;
}

describe("Integration: work advance output modes", () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 60_000);

  it("default output is a single success line on stdout", async () => {
    const repoPath = path.join("/tmp", `monsthera-adv-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const id = await seedOneFeature(repoPath);

    const res = cli(repoPath, ["work", "advance", id, "--phase", "enrichment"]);
    expect(res.status).toBe(0);

    const lines = res.stdout.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(`OK: ${id} advanced planning → enrichment`);

    // stdout has no structured log lines.
    expect(res.stdout).not.toMatch(/"level"\s*:\s*"(info|warn|debug)"/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("adds a truncated reason line when --reason is passed", async () => {
    const repoPath = path.join("/tmp", `monsthera-adv-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const id = await seedOneFeature(repoPath);
    const longReason = "A".repeat(120);

    const res = cli(repoPath, [
      "work", "advance", id,
      "--phase", "cancelled",
      "--reason", longReason,
    ]);
    expect(res.status).toBe(0);

    const lines = res.stdout.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(`OK: ${id} advanced planning → cancelled`);
    expect(lines[1]).toMatch(/^reason: "A{77}\.\.\."$/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("--format json emits a single-line JSON object", async () => {
    const repoPath = path.join("/tmp", `monsthera-adv-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const id = await seedOneFeature(repoPath);

    const res = cli(repoPath, ["work", "advance", id, "--phase", "enrichment", "--format", "json"]);
    expect(res.status).toBe(0);

    const lines = res.stdout.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as {
      workId: string;
      from: string;
      to: string;
      advancedAt: string;
    };
    expect(parsed.workId).toBe(id);
    expect(parsed.from).toBe("planning");
    expect(parsed.to).toBe("enrichment");
    expect(typeof parsed.advancedAt).toBe("string");

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("--verbose dumps the full article (pre-3.0 default)", async () => {
    const repoPath = path.join("/tmp", `monsthera-adv-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const id = await seedOneFeature(repoPath);

    const res = cli(repoPath, ["work", "advance", id, "--phase", "enrichment", "--verbose"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`ID:\\s+${id}`));
    expect(res.stdout).toMatch(/Phase:\s+enrichment/);
    expect(res.stdout).toMatch(/Priority:/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("rejects --verbose and --format json together", async () => {
    const repoPath = path.join("/tmp", `monsthera-adv-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });

    const res = cli(repoPath, [
      "work", "advance", "w-any",
      "--phase", "enrichment",
      "--verbose",
      "--format", "json",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/mutually exclusive/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 60_000);
});
