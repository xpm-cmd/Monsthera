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
    // fall through to build
  }
  const res = spawnSync("pnpm", ["build"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (res.status !== 0 || res.error) {
    throw new Error(`Auto-build failed: ${res.stderr ?? ""}`);
  }
}

function cli(repoPath: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("node", [binPath, ...args, "--repo", repoPath], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

async function seedWorkAndGetId(repoPath: string): Promise<string> {
  const res = cli(repoPath, [
    "work", "create",
    "--title", "meta work",
    "--template", "bugfix",
    "--author", "agent-1",
    "--content",
    "## Objective\nseed\n\n## Steps to Reproduce\n1. s\n\n## Acceptance Criteria\n- [ ] a",
  ]);
  if (res.status !== 0) throw new Error(`seed: ${res.stderr}`);
  const match = res.stdout.match(/ID:\s+(w-\S+)/);
  if (!match) throw new Error(`no id in create output: ${res.stdout}`);
  return match[1]!;
}

async function readArticleJson(repoPath: string, id: string): Promise<{
  phaseHistory: Array<{
    phase: string;
    enteredAt: string;
    metadata?: Record<string, unknown>;
  }>;
}> {
  const res = cli(repoPath, ["work", "list", "--json"]);
  if (res.status !== 0) throw new Error(`list: ${res.stderr}`);
  const lines = res.stdout.trim().split("\n").filter((l) => l.length > 0);
  const all = lines.map((l) => JSON.parse(l) as {
    id: string;
    phaseHistory: Array<{
      phase: string;
      enteredAt: string;
      metadata?: Record<string, unknown>;
    }>;
  });
  const found = all.find((a) => a.id === id);
  if (!found) throw new Error(`article ${id} not listed`);
  return found;
}

describe("Integration: work advance structured metadata", () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 60_000);

  it("persists --success-test + --blockers + --verdicts on phaseHistory.metadata", async () => {
    const repoPath = path.join("/tmp", `monsthera-meta-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const id = await seedWorkAndGetId(repoPath);

    const res = cli(repoPath, [
      "work", "advance", id,
      "--phase", "enrichment",
      "--success-test", "Y",
      "--blockers", "0",
      "--verdicts", "adopt-v1,monitor",
      "--verify-count", "2",
    ]);
    expect(res.status).toBe(0);

    const article = await readArticleJson(repoPath, id);
    const latest = article.phaseHistory[article.phaseHistory.length - 1];
    expect(latest?.phase).toBe("enrichment");
    expect(latest?.metadata).toEqual({
      success_test: "Y",
      blockers: 0,
      verify_count: 2,
      verdicts: ["adopt-v1", "monitor"],
    });

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("rejects an invalid --success-test value", async () => {
    const repoPath = path.join("/tmp", `monsthera-meta-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const id = await seedWorkAndGetId(repoPath);

    const res = cli(repoPath, [
      "work", "advance", id,
      "--phase", "enrichment",
      "--success-test", "maybe",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Invalid --success-test/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 60_000);

  it("rejects a negative --blockers value", async () => {
    const repoPath = path.join("/tmp", `monsthera-meta-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const id = await seedWorkAndGetId(repoPath);

    const res = cli(repoPath, [
      "work", "advance", id,
      "--phase", "enrichment",
      "--blockers", "-1",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Invalid --blockers/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 60_000);

  it("--metadata-json merges arbitrary fields; explicit flags win on conflict", async () => {
    const repoPath = path.join("/tmp", `monsthera-meta-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const id = await seedWorkAndGetId(repoPath);

    const res = cli(repoPath, [
      "work", "advance", id,
      "--phase", "enrichment",
      "--blockers", "0",
      "--metadata-json", JSON.stringify({ blockers: 99, notes: "ok" }),
    ]);
    expect(res.status).toBe(0);

    const article = await readArticleJson(repoPath, id);
    const latest = article.phaseHistory[article.phaseHistory.length - 1]!;
    // Explicit --blockers beats the JSON payload's blockers.
    expect(latest.metadata).toEqual({ blockers: 0, notes: "ok" });

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("rejects --metadata-json that is not a JSON object", async () => {
    const repoPath = path.join("/tmp", `monsthera-meta-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const id = await seedWorkAndGetId(repoPath);

    const res = cli(repoPath, [
      "work", "advance", id,
      "--phase", "enrichment",
      "--metadata-json", "[1,2,3]",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Invalid --metadata-json: expected a JSON object/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 60_000);
});
