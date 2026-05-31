import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { scanCorpus } from "../../../src/work/lint.js";
import type { ContradictionLintFinding } from "../../../src/work/lint.js";

async function emptyRoot(): Promise<string> {
  const root = path.join("/tmp", `monsthera-lint-contradiction-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  return root;
}

const finding: ContradictionLintFinding = {
  file: "notes/a.md",
  severity: "warning",
  rule: "contradiction",
  articleA: "k-a",
  articleB: "k-b",
  name: "throughput",
  valueA: "100",
  valueB: "200",
  sharedVia: "shared_tag",
  sharedKey: "perf",
};

describe("scanCorpus — contradictions registry family", () => {
  it("merges contradiction findings as warnings under registry=contradictions", async () => {
    const markdownRoot = await emptyRoot();
    const result = await scanCorpus({
      markdownRoot,
      registry: "contradictions",
      canonicalValues: [],
      contradictionFindings: [finding],
    });
    expect(result.findings).toContainEqual(finding);
    expect(result.warningCount).toBe(1);
    expect(result.errorCount).toBe(0); // contradictions are warnings — never gate the exit code
  });

  it("merges contradiction findings under registry=all", async () => {
    const markdownRoot = await emptyRoot();
    const result = await scanCorpus({
      markdownRoot,
      registry: "all",
      canonicalValues: [],
      contradictionFindings: [finding],
    });
    expect(result.findings).toContainEqual(finding);
  });

  it("does NOT merge contradiction findings under an unrelated registry family", async () => {
    const markdownRoot = await emptyRoot();
    const result = await scanCorpus({
      markdownRoot,
      registry: "tag-hygiene",
      canonicalValues: [],
      contradictionFindings: [finding],
    });
    expect(result.findings).not.toContainEqual(finding);
    expect(result.warningCount).toBe(0);
  });
});
