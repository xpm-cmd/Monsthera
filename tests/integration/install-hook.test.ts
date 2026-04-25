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
  if (res.status !== 0 || res.error) throw new Error("Auto-build failed");
}

async function initGitRepo(): Promise<string> {
  const dir = path.join("/tmp", `monsthera-hook-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf-8" });
  if (init.status !== 0) throw new Error("git init failed");
  return dir;
}

describe("Integration: monsthera install-hook / uninstall-hook", () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 120_000);

  it("installs a marker-tagged hook into .git/hooks/pre-commit and removes it on uninstall", async () => {
    const repo = await initGitRepo();

    const install = spawnSync(
      "node",
      [binPath, "install-hook", "--scope", "local", "--repo", repo],
      { encoding: "utf-8" },
    );
    expect(install.status).toBe(0);

    const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
    const hookBody = await fs.readFile(hookPath, "utf-8");
    expect(hookBody).toContain("monsthera-managed-hook");
    expect(hookBody).toContain("monsthera lint");

    const stat = await fs.stat(hookPath);
    // Owner-executable bit set.
    expect(stat.mode & 0o100).toBe(0o100);

    const uninstall = spawnSync(
      "node",
      [binPath, "uninstall-hook", "--scope", "local", "--repo", repo],
      { encoding: "utf-8" },
    );
    expect(uninstall.status).toBe(0);
    await expect(fs.stat(hookPath)).rejects.toThrow();

    await fs.rm(repo, { recursive: true, force: true });
  });

  it("refuses to overwrite a non-monsthera hook without --overwrite", async () => {
    const repo = await initGitRepo();
    const hooksDir = path.join(repo, ".git", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    await fs.writeFile(hookPath, "#!/usr/bin/env bash\necho user-hook\n", { mode: 0o755 });

    const install = spawnSync(
      "node",
      [binPath, "install-hook", "--scope", "local", "--repo", repo],
      { encoding: "utf-8" },
    );
    expect(install.status).toBe(1);
    expect(install.stderr).toContain("not monsthera-managed");

    // Existing hook untouched.
    const body = await fs.readFile(hookPath, "utf-8");
    expect(body).toContain("user-hook");

    // Uninstall also refuses on the user hook.
    const uninstall = spawnSync(
      "node",
      [binPath, "uninstall-hook", "--scope", "local", "--repo", repo],
      { encoding: "utf-8" },
    );
    expect(uninstall.status).toBe(1);
    expect(uninstall.stderr).toContain("not monsthera-managed");

    await fs.rm(repo, { recursive: true, force: true });
  });

  it("--overwrite replaces an existing non-monsthera hook", async () => {
    const repo = await initGitRepo();
    const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(hookPath, "#!/usr/bin/env bash\necho legacy\n", { mode: 0o755 });

    const install = spawnSync(
      "node",
      [binPath, "install-hook", "--scope", "local", "--repo", repo, "--overwrite"],
      { encoding: "utf-8" },
    );
    expect(install.status).toBe(0);
    const body = await fs.readFile(hookPath, "utf-8");
    expect(body).toContain("monsthera-managed-hook");

    await fs.rm(repo, { recursive: true, force: true });
  });

  it("uninstall is a no-op when no hook is present", async () => {
    const repo = await initGitRepo();
    const res = spawnSync(
      "node",
      [binPath, "uninstall-hook", "--scope", "local", "--repo", repo],
      { encoding: "utf-8" },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("nothing to do");
    await fs.rm(repo, { recursive: true, force: true });
  });
});
