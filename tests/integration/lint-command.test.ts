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

async function seedCorpus(repoPath: string): Promise<void> {
  const notesDir = path.join(repoPath, "knowledge", "notes");
  await fs.mkdir(notesDir, { recursive: true });

  const registryJson = JSON.stringify([
    { name: "c_rt", value: "$0.010", unit: "per_rt", valid_since_commit: "abc1234" },
    { name: "K_min", value: "$1,815", unit: "usd" },
  ]);

  const registry = [
    "---",
    "id: k-canonical-values",
    'title: "Canonical Values"',
    "slug: canonical-values",
    "category: policy",
    "tags: [policy, canonical-values]",
    "codeRefs: []",
    "references: []",
    `policy_canonical_values_json: '${registryJson}'`,
    "createdAt: 2026-04-24T00:00:00.000Z",
    "updatedAt: 2026-04-24T00:00:00.000Z",
    "---",
    "",
    "Registry body.",
    "",
  ].join("\n");

  const clean = [
    "---",
    "id: k-clean-article",
    'title: "Clean Article"',
    "slug: clean-article",
    "category: context",
    "tags: []",
    "codeRefs: []",
    "references: []",
    "createdAt: 2026-04-24T00:00:00.000Z",
    "updatedAt: 2026-04-24T00:00:00.000Z",
    "---",
    "",
    "The per-RT cost is c_rt = $0.010 and the floor K_min = $1,815.",
    "",
  ].join("\n");

  const drifted = [
    "---",
    "id: k-drifted-article",
    'title: "Drifted Article"',
    "slug: drifted-article",
    "category: context",
    "tags: []",
    "codeRefs: []",
    "references: []",
    "createdAt: 2026-04-24T00:00:00.000Z",
    "updatedAt: 2026-04-24T00:00:00.000Z",
    "---",
    "",
    "The per-RT cost c_rt = $0.10 per transaction.",
    "",
  ].join("\n");

  await fs.writeFile(path.join(notesDir, "canonical-values.md"), registry, "utf-8");
  await fs.writeFile(path.join(notesDir, "clean-article.md"), clean, "utf-8");
  await fs.writeFile(path.join(notesDir, "drifted-article.md"), drifted, "utf-8");
}

async function seedCustomFrontmatterCorpus(repoPath: string): Promise<void> {
  const notesDir = path.join(repoPath, "knowledge", "notes");
  await fs.mkdir(notesDir, { recursive: true });

  const rulesJson = JSON.stringify([
    { category: "experiment", key: "replicability_score", required: true, type: "number", min: 0, max: 0.8 },
  ]);

  const policy = [
    "---",
    "id: k-cf-policy",
    'title: "Custom Frontmatter Policy"',
    "slug: cf-policy",
    "category: policy",
    "tags: [policy]",
    "codeRefs: []",
    "references: []",
    `policy_custom_frontmatter_json: '${rulesJson}'`,
    "createdAt: 2026-04-24T00:00:00.000Z",
    "updatedAt: 2026-04-24T00:00:00.000Z",
    "---",
    "",
    "Policy body.",
    "",
  ].join("\n");

  // experiment article missing the required replicability_score → violation.
  const missing = [
    "---",
    "id: k-exp-missing",
    'title: "Experiment Missing Score"',
    "slug: exp-missing",
    "category: experiment",
    "tags: []",
    "codeRefs: []",
    "references: []",
    "createdAt: 2026-04-24T00:00:00.000Z",
    "updatedAt: 2026-04-24T00:00:00.000Z",
    "---",
    "",
    "No score here.",
    "",
  ].join("\n");

  // experiment article with a valid in-range score → no violation.
  const valid = [
    "---",
    "id: k-exp-valid",
    'title: "Experiment Valid"',
    "slug: exp-valid",
    "category: experiment",
    "tags: []",
    "codeRefs: []",
    "references: []",
    "replicability_score: 0.5",
    "createdAt: 2026-04-24T00:00:00.000Z",
    "updatedAt: 2026-04-24T00:00:00.000Z",
    "---",
    "",
    "Has a valid score.",
    "",
  ].join("\n");

  await fs.writeFile(path.join(notesDir, "cf-policy.md"), policy, "utf-8");
  await fs.writeFile(path.join(notesDir, "exp-missing.md"), missing, "utf-8");
  await fs.writeFile(path.join(notesDir, "exp-valid.md"), valid, "utf-8");
}

describe("Integration: monsthera lint", () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 60_000);

  it("emits NDJSON findings on stdout and exits 1 when drift exists", async () => {
    const repoPath = path.join("/tmp", `monsthera-lint-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedCorpus(repoPath);

    const res = spawnSync("node", [binPath, "lint", "--repo", repoPath], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(res.status).toBe(1);

    const lines = res.stdout.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);

    const parsed = lines.map((l) => JSON.parse(l));
    const drift = parsed.find(
      (f) => f.rule === "canonical_value_mismatch" && f.file.includes("drifted-article.md"),
    );
    expect(drift).toBeDefined();
    expect(drift.name).toBe("c_rt");
    expect(drift.expected).toBe("$0.010");
    expect(drift.found).toBe("$0.10");
    expect(drift.sinceCommit).toBe("abc1234");

    // Clean article produced no finding.
    expect(parsed.find((f) => f.file.includes("clean-article.md"))).toBeUndefined();

    // Logs went to stderr, not stdout.
    expect(res.stdout).not.toMatch(/"level"\s*:\s*"(info|warn|debug)"/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);

  it("reports a custom-frontmatter required-field violation as a warning (PR-14b)", async () => {
    const repoPath = path.join("/tmp", `monsthera-lint-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedCustomFrontmatterCorpus(repoPath);

    const res = spawnSync(
      "node",
      [binPath, "lint", "--repo", repoPath, "--registry", "custom-frontmatter"],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );

    // Warning severity must not gate the exit code.
    expect(res.status).toBe(0);

    const parsed = res.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

    const violation = parsed.find(
      (f) => f.rule === "custom_frontmatter_violation" && f.file.includes("exp-missing.md"),
    );
    expect(violation).toBeDefined();
    expect(violation.problem).toBe("missing_required");
    expect(violation.key).toBe("replicability_score");
    expect(violation.severity).toBe("warning");

    // The valid experiment article and the policy article produced no violation.
    expect(parsed.find((f) => f.file.includes("exp-valid.md"))).toBeUndefined();

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);

  it("exits 0 on a clean corpus with no registry", async () => {
    const repoPath = path.join("/tmp", `monsthera-lint-${randomUUID()}`);
    await fs.mkdir(path.join(repoPath, "knowledge", "notes"), { recursive: true });

    const res = spawnSync("node", [binPath, "lint", "--repo", repoPath], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);

  it("--format text produces human-readable output on stdout", async () => {
    const repoPath = path.join("/tmp", `monsthera-lint-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedCorpus(repoPath);

    const res = spawnSync(
      "node",
      [binPath, "lint", "--repo", repoPath, "--format", "text"],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );

    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/ERROR .*drifted-article\.md.*c_rt.*\$0\.010.*\$0\.10/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);

  it("reports orphan citations as warnings without affecting exit code", async () => {
    const repoPath = path.join("/tmp", `monsthera-lint-${randomUUID()}`);
    const notesDir = path.join(repoPath, "knowledge", "notes");
    await fs.mkdir(notesDir, { recursive: true });

    const orphanSource = [
      "---",
      "id: k-orphan-source",
      'title: "Has an orphan citation"',
      "slug: orphan-source",
      "category: context",
      "tags: []",
      "codeRefs: []",
      "references: []",
      "createdAt: 2026-04-24T00:00:00.000Z",
      "updatedAt: 2026-04-24T00:00:00.000Z",
      "---",
      "",
      "I mention k-does-not-exist in prose; lint should flag it as a warning.",
      "",
    ].join("\n");

    await fs.writeFile(
      path.join(notesDir, "orphan-source.md"),
      orphanSource,
      "utf-8",
    );

    const res = spawnSync("node", [binPath, "lint", "--repo", repoPath], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });

    // No canonical_value_mismatch here, so exit code should stay 0 even
    // though warnings are present — warnings must not break pipelines.
    expect(res.status).toBe(0);

    const lines = res.stdout.trim().split("\n").filter((l) => l.length > 0);
    const parsed = lines.map((l) => JSON.parse(l));
    const orphan = parsed.find(
      (f) => f.rule === "orphan_citation" && f.missingRefId === "k-does-not-exist",
    );
    expect(orphan).toBeDefined();
    expect(orphan.severity).toBe("warning");
    expect(orphan.sourceArticleId).toBe("k-orphan-source");

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);
});
