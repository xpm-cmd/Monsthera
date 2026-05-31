import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanCorpus } from "../../../src/work/lint.js";
import type { CustomFrontmatterFinding } from "../../../src/work/lint.js";
import type { CustomFrontmatterRule } from "../../../src/work/policy-loader.js";

// PR-14b (ADR-020 P3): a `custom-frontmatter` lint family validates an article's
// custom frontmatter against per-category policy rules (required / type / scalar
// range). Warning by default; a rule may raise to error. Tested via scanCorpus
// over a temp corpus, mirroring the other lint families.

function writeArticle(dir: string, slug: string, category: string, extraLines: string[]): Promise<void> {
  const content = [
    "---",
    `id: k-${slug}`,
    `title: "${slug}"`,
    `slug: ${slug}`,
    `category: ${category}`,
    "tags: []",
    "codeRefs: []",
    "references: []",
    ...extraLines,
    "createdAt: 2026-04-24T00:00:00.000Z",
    "updatedAt: 2026-04-24T00:00:00.000Z",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");
  return fs.writeFile(path.join(dir, `${slug}.md`), content, "utf-8");
}

const customFindings = (findings: readonly { rule: string }[]): CustomFrontmatterFinding[] =>
  findings.filter((f) => f.rule === "custom_frontmatter_violation") as CustomFrontmatterFinding[];

const scoreRule: CustomFrontmatterRule = {
  category: "spike",
  key: "replicability_score",
  required: true,
  type: "number",
  min: 0,
  max: 0.8,
  severity: "warning",
};

describe("scanCorpus — custom-frontmatter registry family (PR-14b)", () => {
  let root: string;
  let notesDir: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `monsthera-lint-cf-${randomUUID()}`);
    notesDir = path.join(root, "notes");
    await fs.mkdir(notesDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const scan = (rules: CustomFrontmatterRule[], registry: "custom-frontmatter" | "tag-hygiene" = "custom-frontmatter") =>
    scanCorpus({ markdownRoot: root, canonicalValues: [], registry, customFrontmatterRules: rules });

  it("flags a missing required field", async () => {
    await writeArticle(notesDir, "no-score", "spike", []);
    const found = customFindings((await scan([scoreRule])).findings);
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toBe("missing_required");
    expect(found[0]!.key).toBe("replicability_score");
    expect(found[0]!.severity).toBe("warning");
  });

  it("flags a wrong-type value", async () => {
    await writeArticle(notesDir, "bad-type", "spike", ["replicability_score: high"]);
    const found = customFindings((await scan([scoreRule])).findings);
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toBe("wrong_type");
  });

  it("flags an out-of-range numeric value", async () => {
    await writeArticle(notesDir, "too-high", "spike", ["replicability_score: 0.95"]);
    const found = customFindings((await scan([scoreRule])).findings);
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toBe("out_of_range");
  });

  it("passes a valid in-range value", async () => {
    await writeArticle(notesDir, "ok", "spike", ["replicability_score: 0.5"]);
    expect(customFindings((await scan([scoreRule])).findings)).toHaveLength(0);
  });

  it("does not apply a rule to a different category", async () => {
    await writeArticle(notesDir, "other-cat", "context", []); // missing score, but rule targets spike
    expect(customFindings((await scan([scoreRule])).findings)).toHaveLength(0);
  });

  it("honors a per-rule error severity (raises errorCount)", async () => {
    const errRule: CustomFrontmatterRule = { ...scoreRule, severity: "error" };
    await writeArticle(notesDir, "no-score-err", "spike", []);
    const res = await scan([errRule]);
    const found = customFindings(res.findings);
    expect(found[0]!.severity).toBe("error");
    expect(res.errorCount).toBeGreaterThanOrEqual(1);
  });

  it("does not run under a different registry family", async () => {
    await writeArticle(notesDir, "no-score-gate", "spike", []);
    expect(customFindings((await scan([scoreRule], "tag-hygiene")).findings)).toHaveLength(0);
  });
});
