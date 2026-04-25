import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

/**
 * `monsthera events tail` and `monsthera events emit` exercised through
 * the built CLI in a real child process. The contract under test:
 *
 *   - tail prints one JSON object per line on stdout
 *   - emit prints exactly one JSON object on stdout (the persisted event)
 *   - logs stay on stderr (the structured logger)
 *
 * Mirrors `cli-stream-separation.test.ts` so a future regression that
 * leaks logs onto stdout is caught both by the broad sentinel test there
 * and by these events-specific assertions.
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
      `Auto-build failed for ${binPath}. ` +
        `Run \`pnpm build\` manually to see the underlying error.\n` +
        `stdout: ${res.stdout ?? ""}\nstderr: ${res.stderr ?? ""}\n` +
        `error: ${res.error?.message ?? "(none)"}`,
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

describe("Integration: monsthera events CLI", () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 60_000);

  it("events tail returns valid JSON-lines on stdout; logs only on stderr", async () => {
    const repoPath = path.join("/tmp", `monsthera-events-tail-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });

    const res = spawnSync("node", [binPath, "events", "tail", "--repo", repoPath], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(res.status).toBe(0);

    // stdout MUST not contain structured log entries.
    const stdoutLines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
    for (const line of stdoutLines) {
      expect(isStructuredLogLine(line)).toBe(false);
    }
    // Each non-empty stdout line must be valid JSON (an event or empty
    // result — empty when no events exist).
    for (const line of stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("events emit refuses agent_needed (dispatcher-only)", async () => {
    const repoPath = path.join("/tmp", `monsthera-events-emit-needed-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });

    const res = spawnSync(
      "node",
      [
        binPath,
        "events",
        "emit",
        "--type",
        "agent_needed",
        "--work-id",
        "w-fake",
        "--role",
        "security",
        "--from",
        "enrichment",
        "--to",
        "implementation",
        "--repo",
        repoPath,
      ],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/agent_needed is dispatcher-only/i);
  });

  it("events emit succeeds for a real lifecycle event and prints one JSON object", async () => {
    const repoPath = path.join("/tmp", `monsthera-events-emit-ok-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });

    // Seed a work article via the CLI so the emit target exists.
    const create = spawnSync(
      "node",
      [
        binPath,
        "work",
        "create",
        "--title",
        "events-cli test",
        "--template",
        "feature",
        "--author",
        "agent-test",
        "--priority",
        "medium",
        "--content",
        "## Objective\nDo it.\n\n## Acceptance Criteria\nWorks.",
        "--repo",
        repoPath,
      ],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );
    expect(create.status).toBe(0);
    // The work create CLI prints a single line that includes the new id —
    // capture it from stdout. Format is `Work article created: w-xxxxxxxx`
    // or similar; we just grep for `w-` prefixed tokens.
    const workIdMatch = create.stdout.match(/\b(w-[a-z0-9]+)\b/);
    expect(workIdMatch).not.toBeNull();
    const workId = workIdMatch![1]!;

    const res = spawnSync(
      "node",
      [
        binPath,
        "events",
        "emit",
        "--type",
        "agent_started",
        "--work-id",
        workId,
        "--role",
        "architecture",
        "--from",
        "enrichment",
        "--to",
        "implementation",
        "--agent-id",
        "arch-agent-1",
        "--repo",
        repoPath,
      ],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );

    expect(res.status).toBe(0);
    const stdoutLines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0]!);
    expect(parsed.eventType).toBe("agent_started");
    expect(parsed.workId).toBe(workId);
    expect(parsed.details.role).toBe("architecture");
  });
});
