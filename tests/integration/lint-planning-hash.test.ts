import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { computePlanningHash } from "../../src/work/planning-hash.js";

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
    throw new Error(
      `Auto-build failed. stdout: ${res.stdout ?? ""}\nstderr: ${res.stderr ?? ""}`,
    );
  }
}

const ORIGINAL_PLANNING = "Initial plan: ship feature X with a hash guard.";
const TAMPERED_PLANNING = "Initial plan: ship feature Y with a hash guard.";

function workArticle(opts: {
  id: string;
  planningBody: string;
  planningHash: string | null;
  phase: string;
}): string {
  const { id, planningBody, planningHash, phase } = opts;
  const hashLine = planningHash !== null ? `planning_hash: "${planningHash}"\n` : "";
  return [
    "---",
    `id: ${id}`,
    `title: "Hash test"`,
    "template: feature",
    `phase: ${phase}`,
    "priority: medium",
    "author: agent-1",
    "tags: []",
    "references: []",
    "codeRefs: []",
    "dependencies: []",
    "blockedBy: []",
    "createdAt: 2026-04-25T00:00:00.000Z",
    "updatedAt: 2026-04-25T00:00:00.000Z",
    'enrichmentRolesJson: \'{"items":[]}\'',
    'reviewersJson: \'{"items":[]}\'',
    `phaseHistoryJson: '{"items":[{"phase":"${phase}","enteredAt":"2026-04-25T00:00:00.000Z"}]}'`,
    hashLine + "---",
    "",
    "## Objective",
    "Test the planning_section_tampered rule.",
    "",
    "## Planning",
    planningBody,
    "",
    "## Acceptance Criteria",
    "- something",
    "",
  ].join("\n");
}

describe("Integration: monsthera lint — planning_section_tampered", () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 120_000);

  it("emits a planning_section_tampered finding when the section diverges from planning_hash", async () => {
    const repoPath = path.join("/tmp", `monsthera-lint-ph-${randomUUID()}`);
    const workDir = path.join(repoPath, "knowledge", "work-articles");
    await fs.mkdir(workDir, { recursive: true });

    const expectedHash = computePlanningHash(`...\n## Planning\n${ORIGINAL_PLANNING}\n\n## End\n`)!;
    const articlePath = path.join(workDir, "w-tamper.md");
    await fs.writeFile(
      articlePath,
      workArticle({
        id: "w-tamper",
        planningBody: TAMPERED_PLANNING, // body diverges from hash
        planningHash: expectedHash,
        phase: "enrichment",
      }),
      "utf-8",
    );

    const res = spawnSync(
      "node",
      [binPath, "lint", "--repo", repoPath, "--registry", "planning-hash"],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );

    expect(res.status).toBe(1);
    const findings = res.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

    const tamper = findings.filter((f) => f.rule === "planning_section_tampered");
    expect(tamper.length).toBe(1);
    expect(tamper[0].articleId).toBe("w-tamper");
    expect(tamper[0].phase).toBe("enrichment");
    expect(tamper[0].expectedHash).toBe(expectedHash);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);

  it("skips articles still in planning, missing the hash, or matching it", async () => {
    const repoPath = path.join("/tmp", `monsthera-lint-ph-skip-${randomUUID()}`);
    const workDir = path.join(repoPath, "knowledge", "work-articles");
    await fs.mkdir(workDir, { recursive: true });

    // 1. Still in planning — hash absent, no finding expected.
    await fs.writeFile(
      path.join(workDir, "w-planning.md"),
      workArticle({
        id: "w-planning",
        planningBody: "any content",
        planningHash: null,
        phase: "planning",
      }),
      "utf-8",
    );

    // 2. Historical article without planning_hash, in enrichment — skipped.
    await fs.writeFile(
      path.join(workDir, "w-historical.md"),
      workArticle({
        id: "w-historical",
        planningBody: "legacy content",
        planningHash: null,
        phase: "enrichment",
      }),
      "utf-8",
    );

    // 3. Hash matches the body — no finding.
    const matchingBody = "Stable plan: do not change.";
    const matchingHash = computePlanningHash(`# x\n## Planning\n${matchingBody}\n\n## End\n`)!;
    await fs.writeFile(
      path.join(workDir, "w-matching.md"),
      workArticle({
        id: "w-matching",
        planningBody: matchingBody,
        planningHash: matchingHash,
        phase: "enrichment",
      }),
      "utf-8",
    );

    const res = spawnSync(
      "node",
      [binPath, "lint", "--repo", repoPath, "--registry", "planning-hash"],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );

    expect(res.status).toBe(0);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);
});
