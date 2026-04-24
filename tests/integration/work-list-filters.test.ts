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

async function seedRepo(repoPath: string, articles: Array<{ title: string; tags?: string[] }>) {
  for (const a of articles) {
    const createArgs = [
      "work", "create",
      "--title", a.title,
      "--template", "feature",
      "--author", "agent-test",
    ];
    if (a.tags && a.tags.length > 0) {
      createArgs.push("--tags", a.tags.join(","));
    }
    createArgs.push("--content", "## Objective\nseed\n\n## Acceptance Criteria\n- [ ] seeded");
    const res = cli(repoPath, createArgs);
    if (res.status !== 0) {
      throw new Error(`seed create failed for "${a.title}": ${res.stderr}`);
    }
  }
}

describe("Integration: monsthera work list filters", () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 60_000);

  it("--format json emits NDJSON with one summary per line on stdout", async () => {
    const repoPath = path.join("/tmp", `monsthera-list-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedRepo(repoPath, [
      { title: "Alpha", tags: ["wave-2", "backend"] },
      { title: "Beta", tags: ["wave-3"] },
    ]);

    const res = cli(repoPath, ["work", "list", "--format", "json"]);
    expect(res.status).toBe(0);

    const lines = res.stdout.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    const items = lines.map((l) => JSON.parse(l) as { title: string });
    const titles = items.map((i) => i.title).sort();
    expect(titles).toEqual(["Alpha", "Beta"]);

    // stdout is NDJSON only — no log lines leaked in.
    expect(res.stdout).not.toMatch(/"level"\s*:\s*"(info|warn|debug)"/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("--tag filter narrows the list", async () => {
    const repoPath = path.join("/tmp", `monsthera-list-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedRepo(repoPath, [
      { title: "Alpha", tags: ["backend"] },
      { title: "Beta", tags: ["frontend"] },
      { title: "Gamma", tags: ["backend", "db"] },
    ]);

    const res = cli(repoPath, ["work", "list", "--tag", "backend", "--format", "json"]);
    expect(res.status).toBe(0);
    const lines = res.stdout.trim().split("\n").filter((l) => l.length > 0);
    const titles = lines.map((l) => (JSON.parse(l) as { title: string }).title).sort();
    expect(titles).toEqual(["Alpha", "Gamma"]);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("--wave shorthand matches `wave-<name>` tag", async () => {
    const repoPath = path.join("/tmp", `monsthera-list-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedRepo(repoPath, [
      { title: "Alpha", tags: ["wave-2"] },
      { title: "Beta", tags: ["wave-3"] },
    ]);

    const res = cli(repoPath, ["work", "list", "--wave", "2", "--format", "json"]);
    expect(res.status).toBe(0);
    const lines = res.stdout.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect((JSON.parse(lines[0]!) as { title: string }).title).toBe("Alpha");

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("--format csv produces header + rows with quoted cells for commas", async () => {
    const repoPath = path.join("/tmp", `monsthera-list-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedRepo(repoPath, [{ title: "A, with comma", tags: ["x"] }]);

    const res = cli(repoPath, ["work", "list", "--format", "csv"]);
    expect(res.status).toBe(0);
    const lines = res.stdout.trim().split("\n");
    expect(lines[0]).toBe("id,title,template,phase,priority,updatedAt");
    expect(lines[1]).toMatch(/,"A, with comma",feature,planning,medium,/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("--format tsv produces tab-separated rows", async () => {
    const repoPath = path.join("/tmp", `monsthera-list-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedRepo(repoPath, [{ title: "Alpha" }]);

    const res = cli(repoPath, ["work", "list", "--format", "tsv"]);
    expect(res.status).toBe(0);
    const firstRow = res.stdout.trim().split("\n")[0]!;
    expect(firstRow.split("\t")).toEqual(["id", "title", "template", "phase", "priority", "updatedAt"]);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("--phase-age-days 1 filters out just-created articles", async () => {
    const repoPath = path.join("/tmp", `monsthera-list-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedRepo(repoPath, [{ title: "Fresh" }]);

    const res = cli(repoPath, ["work", "list", "--phase-age-days", "1", "--format", "json"]);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);

  it("rejects an invalid --format", async () => {
    const repoPath = path.join("/tmp", `monsthera-list-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const res = cli(repoPath, ["work", "list", "--format", "yaml"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Invalid --format/);
    await fs.rm(repoPath, { recursive: true, force: true });
  }, 60_000);

  it("--json still works as a backwards-compat alias for --format json", async () => {
    const repoPath = path.join("/tmp", `monsthera-list-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedRepo(repoPath, [{ title: "Alpha" }]);

    const res = cli(repoPath, ["work", "list", "--json"]);
    expect(res.status).toBe(0);
    const lines = res.stdout.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect((JSON.parse(lines[0]!) as { title: string }).title).toBe("Alpha");

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 180_000);
});
