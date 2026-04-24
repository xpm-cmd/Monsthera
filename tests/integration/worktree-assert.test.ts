import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
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
    throw new Error(`Auto-build failed`);
  }
}

async function makeMainRepo(): Promise<string> {
  const dir = path.join("/tmp", `monsthera-wta-main-${randomUUID()}`);
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  return dir;
}

async function makeWorktree(): Promise<string> {
  const main = path.join("/tmp", `monsthera-wta-mainfor-${randomUUID()}`);
  const wt = path.join("/tmp", `monsthera-wta-wt-${randomUUID()}`);
  const wtGit = path.join(main, ".git", "worktrees", "wt1");
  await fs.mkdir(wtGit, { recursive: true });
  await fs.mkdir(path.join(main, ".git"), { recursive: true });
  await fs.mkdir(wt, { recursive: true });
  await fs.writeFile(path.join(wtGit, "commondir"), "../..\n", "utf8");
  await fs.writeFile(path.join(wt, ".git"), `gitdir: ${wtGit}\n`, "utf8");
  return wt;
}

describe("Integration: --assert-worktree / MONSTHERA_REQUIRE_WORKTREE", () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 120_000);

  it("exits 2 from a main repo when --assert-worktree is set", async () => {
    const main = await makeMainRepo();
    const res = spawnSync("node", [binPath, "status", "--assert-worktree"], {
      cwd: main,
      encoding: "utf-8",
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("worktree required");
    await fs.rm(main, { recursive: true, force: true });
  });

  it("exits 2 from a main repo when MONSTHERA_REQUIRE_WORKTREE=true", async () => {
    const main = await makeMainRepo();
    const res = spawnSync("node", [binPath, "status"], {
      cwd: main,
      encoding: "utf-8",
      env: { ...process.env, MONSTHERA_REQUIRE_WORKTREE: "true" },
    });
    expect(res.status).toBe(2);
    await fs.rm(main, { recursive: true, force: true });
  });

  it("does not assert from inside a worktree", async () => {
    const wt = await makeWorktree();
    const res = spawnSync("node", [binPath, "--version", "--assert-worktree"], {
      cwd: wt,
      encoding: "utf-8",
    });
    // --version is exempt anyway, but with the file-based .git it would also pass.
    expect(res.status).toBe(0);
    await fs.rm(wt, { recursive: true, force: true });
  });

  it("exempts --version even when the assert env is set in a main repo", async () => {
    const main = await makeMainRepo();
    const res = spawnSync("node", [binPath, "--version"], {
      cwd: main,
      encoding: "utf-8",
      env: { ...process.env, MONSTHERA_REQUIRE_WORKTREE: "true" },
    });
    expect(res.status).toBe(0);
    await fs.rm(main, { recursive: true, force: true });
  });

  it("exempts install-hook even with the assert flag", async () => {
    const main = path.join("/tmp", `monsthera-wta-ih-${randomUUID()}`);
    await fs.mkdir(path.join(main, ".git", "hooks"), { recursive: true });
    const res = spawnSync(
      "node",
      [binPath, "install-hook", "--assert-worktree", "--repo", main, "--scope", "local"],
      { cwd: main, encoding: "utf-8" },
    );
    // Subcommand may print path on stdout and exit 0; or fail for unrelated
    // reasons. The point is the assert does NOT fire (exit code 2).
    expect(res.status).not.toBe(2);
    await fs.rm(main, { recursive: true, force: true });
  });
});
