import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanCorpus } from "../../../src/work/lint.js";
import type { VerifyDensityFinding } from "../../../src/work/lint.js";

function writeArticle(dir: string, slug: string, body: string): Promise<void> {
  const content = [
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
  return fs.writeFile(path.join(dir, `${slug}.md`), content, "utf-8");
}

describe("scanCorpus — verify density", () => {
  let root: string;
  let notesDir: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `monsthera-lint-density-${randomUUID()}`);
    notesDir = path.join(root, "notes");
    await fs.mkdir(notesDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not emit a finding when the threshold is undefined", async () => {
    await writeArticle(
      notesDir,
      "many-verifies",
      "Cites k-target [verify] and [[slug]] [verify] only two refs.",
    );
    const res = await scanCorpus({ markdownRoot: root, canonicalValues: [] });
    expect(res.findings.filter((f) => f.rule === "verify_density_exceeded")).toHaveLength(0);
  });

  it("emits a warning when density exceeds the threshold", async () => {
    await writeArticle(
      notesDir,
      "over-threshold",
      "Cites k-a and k-b once each; markers: [verify] [verify] [verify].",
    );

    const res = await scanCorpus({
      markdownRoot: root,
      canonicalValues: [],
      verifyDensityThreshold: 0.5,
    });

    const finding = res.findings.find(
      (f): f is VerifyDensityFinding => f.rule === "verify_density_exceeded",
    );
    expect(finding).toBeDefined();
    expect(finding?.citationCount).toBe(2);
    expect(finding?.verifyCount).toBe(3);
    expect(finding?.threshold).toBe(0.5);
    expect(finding?.oldestMarker?.line).toContain("[verify]");
    expect(res.warningCount).toBe(1);
  });

  it("does not emit a finding at or below the threshold", async () => {
    await writeArticle(
      notesDir,
      "at-threshold",
      "Cites k-a, k-b, k-c, k-d, k-e (5 citations); marker [verify] once (density 20%).",
    );

    const res = await scanCorpus({
      markdownRoot: root,
      canonicalValues: [],
      verifyDensityThreshold: 0.2,
    });

    expect(res.findings.filter((f) => f.rule === "verify_density_exceeded")).toHaveLength(0);
  });

  it("skips articles that have no citations at all (no density to measure)", async () => {
    await writeArticle(notesDir, "no-citations", "No citations here, only [verify] markers.");

    const res = await scanCorpus({
      markdownRoot: root,
      canonicalValues: [],
      verifyDensityThreshold: 0.05,
    });

    expect(res.findings.filter((f) => f.rule === "verify_density_exceeded")).toHaveLength(0);
  });

  it("recognises [verify at <gate>] and [verify-deferred-to-<gate>] variants", async () => {
    await writeArticle(
      notesDir,
      "variants",
      "Cites k-a. Marker forms: [verify at wave-3] and [verify-deferred-to-final].",
    );

    const res = await scanCorpus({
      markdownRoot: root,
      canonicalValues: [],
      verifyDensityThreshold: 0.5,
    });

    const finding = res.findings.find(
      (f): f is VerifyDensityFinding => f.rule === "verify_density_exceeded",
    );
    expect(finding?.verifyCount).toBe(2);
    expect(finding?.citationCount).toBe(1);
  });

  it("ignores citations and markers inside fenced code blocks", async () => {
    // Real prose: 3 citations, 1 marker → density ≈ 33%. Fence contains
    // content that would push density over 50% if counted — it must be
    // ignored so density stays under the 50% threshold.
    await writeArticle(
      notesDir,
      "fenced",
      [
        "Prose cites k-a and k-b and [[slug-c]]; one marker [verify] only.",
        "```",
        "k-sample [verify] [verify] k-sample2 [verify-deferred-to-later]",
        "```",
      ].join("\n"),
    );

    const res = await scanCorpus({
      markdownRoot: root,
      canonicalValues: [],
      verifyDensityThreshold: 0.5,
    });

    const finding = res.findings.find(
      (f): f is VerifyDensityFinding => f.rule === "verify_density_exceeded",
    );
    expect(finding).toBeUndefined();
  });
});
