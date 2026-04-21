import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

// This integration test spawns the built CLI in a real child process so
// we can capture stdout and stderr as independent streams — the in-process
// `captureStdout` helper used by the unit tests can't detect leaks onto
// stdout from an arbitrary logger.  The contract under test:
//
//   stdout is reserved for user-facing output (tables, JSON, messages)
//   stderr carries structured JSON logs (INFO/DEBUG/WARN/ERROR)
//
// so a consumer can redirect `2>/dev/null` and get a clean stdout pipeline.

const repoRoot = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const binPath = path.join(repoRoot, "dist", "bin.js");

async function ensureBuilt(): Promise<void> {
  try {
    await fs.access(binPath);
  } catch {
    throw new Error(
      `dist/bin.js is missing at ${binPath}. Run \`pnpm build\` before running this test.`,
    );
  }
}

describe("Integration: CLI stdout/stderr separation", () => {
  beforeAll(async () => {
    await ensureBuilt();
  });

  it("knowledge list keeps logs on stderr; stdout has no JSON log lines", async () => {
    const repoPath = path.join("/tmp", `monsthera-stream-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });

    const res = spawnSync("node", [binPath, "knowledge", "list", "--repo", repoPath], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(res.status).toBe(0);

    // stdout must NOT contain structured log entries like {"level":"info",...}
    // or `domain:"monsthera"` — those belong on stderr. We check both the
    // level marker and the timestamp key since the logger always emits both.
    expect(res.stdout).not.toMatch(/"level"\s*:\s*"(info|warn|debug)"/);
    expect(res.stdout).not.toMatch(/"domain"\s*:\s*"monsthera"/);

    // stdout is allowed to be the table header / empty-state message —
    // just sanity-check that it isn't literally empty and that the logs
    // actually went somewhere (stderr).
    expect(res.stdout.length).toBeGreaterThan(0);
    expect(res.stderr).toMatch(/"level"\s*:\s*"info"/);

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("status command keeps its own JSON payload on stdout and logs on stderr", async () => {
    const repoPath = path.join("/tmp", `monsthera-stream-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });

    const res = spawnSync("node", [binPath, "status", "--repo", repoPath], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(res.status).toBe(0);
    // The status payload on stdout must be a single parseable JSON object —
    // if logger output leaked into stdout, JSON.parse would choke on the
    // multiple top-level objects.
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("subsystems");

    // Logger output landed on stderr.
    expect(res.stderr).toMatch(/"level"\s*:\s*"info"/);

    await fs.rm(repoPath, { recursive: true, force: true });
  });
});
