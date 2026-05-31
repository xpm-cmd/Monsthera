import { describe, it, expect } from "vitest";
import {
  distilledSlug,
  deriveDistilledCategory,
  buildDistilledTitle,
  buildDistilledBody,
} from "../../../src/work/distillation.js";
import type { WorkArticle } from "../../../src/work/repository.js";

function mkWork(over: Record<string, unknown> = {}): WorkArticle {
  return {
    id: "w-123",
    title: "Fix login",
    template: "bugfix",
    phase: "done",
    priority: "medium",
    author: "agent-1",
    enrichmentRoles: [],
    reviewers: [],
    phaseHistory: [],
    tags: ["auth"],
    references: [],
    codeRefs: ["src/auth/login.ts"],
    dependencies: [],
    blockedBy: [],
    content: "## Objective\nFix the redirect.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  } as unknown as WorkArticle;
}

describe("distilledSlug", () => {
  it("is deterministic per work id (basis for idempotency)", () => {
    expect(distilledSlug("w-123")).toBe("distilled-w-123");
  });
});

describe("deriveDistilledCategory", () => {
  it("is solution for feature/bugfix/refactor without verdicts", () => {
    expect(deriveDistilledCategory(mkWork({ template: "bugfix" }))).toBe("solution");
  });
  it("is decision when the last phase carries verdicts", () => {
    const w = mkWork({ phaseHistory: [{ phase: "done", enteredAt: "t", metadata: { verdicts: ["adopt-v1"] } }] });
    expect(deriveDistilledCategory(w)).toBe("decision");
  });
  it("is decision for spike", () => {
    expect(deriveDistilledCategory(mkWork({ template: "spike" }))).toBe("decision");
  });
});

describe("buildDistilledTitle", () => {
  it("labels by category", () => {
    expect(buildDistilledTitle(mkWork({ title: "X" }), "solution")).toBe("Solution: X");
    expect(buildDistilledTitle(mkWork({ title: "X" }), "decision")).toBe("Decision: X");
  });
});

describe("buildDistilledBody", () => {
  it("includes the work content, a back-ref note, code refs and outcome metadata", () => {
    const w = mkWork({
      content: "## Objective\nFix it.",
      codeRefs: ["src/a.ts"],
      phaseHistory: [{ phase: "done", enteredAt: "t", metadata: { success_test: "Y", blockers: 0, verdicts: ["ship"] } }],
    });
    const body = buildDistilledBody(w);
    expect(body).toContain("Distilled from work [w-123]");
    expect(body).toContain("## Objective");
    expect(body).toContain("## Outcome");
    expect(body).toContain("Success test");
    expect(body).toContain("Verdicts");
    expect(body).toContain("- `src/a.ts`");
  });
  it("omits the Outcome section when no phase metadata exists", () => {
    expect(buildDistilledBody(mkWork({ phaseHistory: [] }))).not.toContain("## Outcome");
  });
});
