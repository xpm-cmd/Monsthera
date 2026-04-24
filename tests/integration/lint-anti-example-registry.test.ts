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
    throw new Error(
      `Auto-build failed. stdout: ${res.stdout ?? ""}\nstderr: ${res.stderr ?? ""}\nerror: ${res.error?.message ?? "(none)"}`,
    );
  }
}

/**
 * Seed a corpus with the exact four Hedera v1 anti-example phrases + one
 * token rule from the plan. The matcher must report a finding for every
 * one — the whole point of the feature is that this set of real-world
 * drifts gets caught automatically at write time.
 */
async function seedCorpus(root: string): Promise<void> {
  const notesDir = path.join(root, "knowledge", "notes");
  const leanDir = path.join(root, "docs", "aristotle-briefs", "results");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(leanDir, { recursive: true });

  const tokensJson = JSON.stringify([
    {
      pattern: "B1_4_kill_switch_\\w+",
      canonical_source: "docs/aristotle-briefs/results/**/*.lean",
      description: "Lean theorem name",
    },
  ]);
  const phrasesJson = JSON.stringify([
    { phrase: "22.4% bars", corrected: "22.35 bars", since_commit: "8012863" },
    { phrase: "$2,400 K_min", corrected: "$1,815 K_min", since_commit: "8012863" },
    { phrase: "$0.10/rt c_rt", corrected: "$0.010/rt c_rt", since_commit: "8012863" },
    { phrase: "$1,000 floor", corrected: "$923 floor", since_commit: "8012863" },
  ]);

  const registry = [
    "---",
    "id: k-anti-example-registry",
    'title: "Anti-Example Registry"',
    "slug: anti-example-registry",
    "category: policy",
    "tags: [policy, anti-examples]",
    "codeRefs: []",
    "references: []",
    `policy_anti_example_tokens_json: '${tokensJson}'`,
    `policy_anti_example_phrases_json: '${phrasesJson}'`,
    "createdAt: 2026-04-24T00:00:00.000Z",
    "updatedAt: 2026-04-24T00:00:00.000Z",
    "---",
    "",
    "Registry body.",
    "",
  ].join("\n");
  await fs.writeFile(path.join(notesDir, "anti-example-registry.md"), registry, "utf-8");

  const drift = [
    "---",
    "id: k-wave-2-review",
    'title: "Wave-2 review"',
    "slug: wave-2-review",
    "category: context",
    "tags: []",
    "codeRefs: []",
    "references: []",
    "createdAt: 2026-04-24T00:00:00.000Z",
    "updatedAt: 2026-04-24T00:00:00.000Z",
    "---",
    "",
    "Calibration showed 22.4% bars after the rerun.",
    "The $2,400 K_min figure from earlier reviews appears here as the threshold.",
    "The retail cost is $0.10/rt c_rt per transaction.",
    "The floor is set at $1,000 floor for this channel.",
    "",
  ].join("\n");
  await fs.writeFile(path.join(notesDir, "wave-2-review.md"), drift, "utf-8");

  // A Lean file that pins the canonical theorem name so token drift can
  // surface a concrete suggestion.
  await fs.writeFile(
    path.join(leanDir, "kill-switch.lean"),
    "theorem B1_4_kill_switch_sound : True := trivial\n",
    "utf-8",
  );
}

describe("Integration: monsthera lint — anti-example registry", () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 60_000);

  it("reports one finding per seeded Hedera v1 drift (4 phrases) over the corpus", async () => {
    const repoPath = path.join("/tmp", `monsthera-lint-ae-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedCorpus(repoPath);

    const res = spawnSync("node", [binPath, "lint", "--repo", repoPath], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(res.status).toBe(1);

    const lines = res.stdout.trim().split("\n").filter((l) => l.length > 0);
    const parsed = lines.map((l) => JSON.parse(l));

    const phraseFindings = parsed.filter(
      (f) => f.rule === "phrase_anti_example" && f.file.includes("wave-2-review.md"),
    );
    const phrases = phraseFindings.map((f) => f.phrase).sort();
    expect(phrases).toEqual([
      "$0.10/rt c_rt",
      "$1,000 floor",
      "$2,400 K_min",
      "22.4% bars",
    ]);

    // Registry article itself must not self-flag on any of the phrases.
    expect(
      parsed.find(
        (f) =>
          f.rule === "phrase_anti_example" &&
          f.file.includes("anti-example-registry.md"),
      ),
    ).toBeUndefined();

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);

  it("--registry anti-examples scopes output to anti-example rules only", async () => {
    const repoPath = path.join("/tmp", `monsthera-lint-scoped-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedCorpus(repoPath);

    const res = spawnSync(
      "node",
      [binPath, "lint", "--repo", repoPath, "--registry", "anti-examples"],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );

    expect(res.status).toBe(1);

    const lines = res.stdout.trim().split("\n").filter((l) => l.length > 0);
    const parsed = lines.map((l) => JSON.parse(l));

    const nonAntiExampleErrors = parsed.filter(
      (f) =>
        f.severity === "error" &&
        f.rule !== "phrase_anti_example" &&
        f.rule !== "token_drift",
    );
    expect(nonAntiExampleErrors).toEqual([]);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);
});
