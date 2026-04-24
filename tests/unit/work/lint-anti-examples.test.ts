import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanCorpus } from "../../../src/work/lint.js";
import type {
  PhraseAntiExampleFinding,
  TokenDriftFinding,
} from "../../../src/work/lint.js";
import type {
  AntiExamplePhrase,
  AntiExampleToken,
} from "../../../src/work/policy-loader.js";

function writeArticle(dir: string, slug: string, body: string): Promise<void> {
  const frontmatter = [
    "---",
    `id: k-${slug}`,
    `title: "${slug}"`,
    `slug: ${slug}`,
    "category: context",
    "tags: []",
    "codeRefs: []",
    "references: []",
    "createdAt: 2026-04-24T00:00:00.000Z",
    "updatedAt: 2026-04-24T00:00:00.000Z",
    "---",
    "",
    body,
    "",
  ].join("\n");
  return fs.writeFile(path.join(dir, `${slug}.md`), frontmatter, "utf-8");
}

describe("scanCorpus — phrase anti-examples", () => {
  let root: string;
  let notesDir: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `monsthera-lint-ae-${randomUUID()}`);
    notesDir = path.join(root, "notes");
    await fs.mkdir(notesDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const phrases: AntiExamplePhrase[] = [
    {
      phrase: "22.4% bars",
      corrected: "22.35 bars",
      sinceCommit: "abc1234",
    },
    {
      phrase: "$0.10/rt c_rt",
      corrected: "$0.010/rt c_rt",
    },
  ];

  it("flags a bare occurrence of a registered wrong-form phrase", async () => {
    await writeArticle(notesDir, "drift", "The calibration showed 22.4% bars in wave-2.");

    const res = await scanCorpus({
      markdownRoot: root,
      canonicalValues: [],
      antiExamplePhrases: phrases,
    });

    const phrase = res.findings.find(
      (f): f is PhraseAntiExampleFinding => f.rule === "phrase_anti_example",
    );
    expect(phrase).toBeDefined();
    expect(phrase?.phrase).toBe("22.4% bars");
    expect(phrase?.corrected).toBe("22.35 bars");
    expect(phrase?.sinceCommit).toBe("abc1234");
    expect(phrase?.file).toContain("drift.md");
    expect(res.errorCount).toBe(1);
  });

  it("skips lines carrying forward-guard markers (do NOT, anti-example, stale, HTML comment)", async () => {
    await writeArticle(
      notesDir,
      "guarded",
      [
        'Registry note: do NOT use the phrase "22.4% bars".',
        "Historical context (anti-example): `$0.10/rt c_rt` — this is stale and corrected.",
        "<!-- anti-example --> 22.4% bars lives here as a documentation sample.",
      ].join("\n"),
    );

    const res = await scanCorpus({
      markdownRoot: root,
      canonicalValues: [],
      antiExamplePhrases: phrases,
    });

    expect(res.findings.filter((f) => f.rule === "phrase_anti_example")).toHaveLength(0);
  });

  it("is case-insensitive on the phrase match", async () => {
    await writeArticle(notesDir, "case", "The bucket was 22.4% BARS after calibration.");

    const res = await scanCorpus({
      markdownRoot: root,
      canonicalValues: [],
      antiExamplePhrases: phrases,
    });

    expect(res.findings.some((f) => f.rule === "phrase_anti_example")).toBe(true);
  });

  it("does not skip the registry family when `registry: canonical-values`", async () => {
    await writeArticle(notesDir, "drift", "22.4% bars in review.");

    const res = await scanCorpus({
      markdownRoot: root,
      registry: "canonical-values",
      canonicalValues: [],
      antiExamplePhrases: phrases,
    });

    expect(res.findings.filter((f) => f.rule === "phrase_anti_example")).toHaveLength(0);
  });
});

describe("scanCorpus — token drift", () => {
  let root: string;
  let notesDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `monsthera-lint-token-${randomUUID()}`);
    notesDir = path.join(root, "notes");
    sourceDir = path.join(root, "lean-sources");
    await fs.mkdir(notesDir, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const tokens: AntiExampleToken[] = [
    {
      pattern: "B1_4_kill_switch_\\w+",
      canonicalSource: "lean-sources/**/*.lean",
      description: "Lean theorem name",
    },
  ];

  it("flags a prose token that does not appear in any canonical-source file", async () => {
    await fs.writeFile(
      path.join(sourceDir, "canon.lean"),
      "theorem B1_4_kill_switch_sound : True := trivial",
      "utf-8",
    );

    await writeArticle(
      notesDir,
      "drift",
      "Mentions B1_4_kill_switch_soundness which is not the canonical name.",
    );

    const res = await scanCorpus({
      markdownRoot: root,
      repoRoot: root,
      canonicalValues: [],
      antiExampleTokens: tokens,
    });

    const drift = res.findings.find(
      (f): f is TokenDriftFinding => f.rule === "token_drift",
    );
    expect(drift).toBeDefined();
    expect(drift?.token).toBe("B1_4_kill_switch_soundness");
    expect(drift?.suggestion).toBe("B1_4_kill_switch_sound");
    expect(res.errorCount).toBe(1);
  });

  it("does not flag a token that IS one of the canonical names", async () => {
    await fs.writeFile(
      path.join(sourceDir, "canon.lean"),
      "theorem B1_4_kill_switch_sound : True := trivial",
      "utf-8",
    );

    await writeArticle(notesDir, "clean", "See B1_4_kill_switch_sound in the brief.");

    const res = await scanCorpus({
      markdownRoot: root,
      repoRoot: root,
      canonicalValues: [],
      antiExampleTokens: tokens,
    });

    expect(res.findings.filter((f) => f.rule === "token_drift")).toHaveLength(0);
  });

  it("skips the token rule silently when repoRoot is not supplied", async () => {
    await writeArticle(
      notesDir,
      "drift",
      "Mentions B1_4_kill_switch_soundness without any repo wiring.",
    );

    const res = await scanCorpus({
      markdownRoot: root,
      canonicalValues: [],
      antiExampleTokens: tokens,
    });

    expect(res.findings.filter((f) => f.rule === "token_drift")).toHaveLength(0);
  });
});
