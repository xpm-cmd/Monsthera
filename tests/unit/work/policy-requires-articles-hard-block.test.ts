import { describe, expect, it } from "vitest";
import { getPolicyViolations } from "../../../src/work/guards.js";
import type { Policy } from "../../../src/work/policy-loader.js";
import type { WorkArticle } from "../../../src/work/repository.js";
import type { WorkPhase } from "../../../src/core/types.js";
import { agentId, workId } from "../../../src/core/types.js";

/**
 * `policy_requires_articles` hard-block (ADR-009): when a referenced
 * article is present in `article.references` but its current phase is
 * not `done`, the violation surfaces as `referencedArticlesNotDone`.
 * Knowledge-article references (absent from the phase map) stay exempt.
 */
describe("policy_requires_articles hard block", () => {
  function makeArticle(references: readonly string[]): WorkArticle {
    return {
      id: workId("w-a"),
      title: "A",
      template: "feature",
      phase: "enrichment",
      priority: "medium",
      author: agentId("agent-1"),
      enrichmentRoles: [],
      reviewers: [],
      phaseHistory: [],
      tags: [],
      references,
      codeRefs: [],
      dependencies: [],
      blockedBy: [],
      content: "",
      createdAt: "2026-04-25T00:00:00.000Z" as ReturnType<typeof workId> & string,
      updatedAt: "2026-04-25T00:00:00.000Z" as ReturnType<typeof workId> & string,
    } as unknown as WorkArticle;
  }

  function makePolicy(referencedArticles: readonly string[]): Policy {
    return {
      id: "k-policy-1",
      slug: "test-policy",
      title: "Test policy",
      appliesTo: {},
      requires: {
        enrichmentRoles: [],
        referencedArticles,
      },
      rationale: "",
    };
  }

  it("passes when the referenced work article is in done", () => {
    const article = makeArticle(["w-b"]);
    const policy = makePolicy(["w-b"]);
    const phases = new Map<string, WorkPhase>([["w-b", "done"]]);
    const violations = getPolicyViolations(article, [policy], phases);
    expect(violations).toEqual([]);
  });

  it("fails with referencedArticlesNotDone when the work article is not done", () => {
    const article = makeArticle(["w-b"]);
    const policy = makePolicy(["w-b"]);
    const phases = new Map<string, WorkPhase>([["w-b", "enrichment"]]);
    const violations = getPolicyViolations(article, [policy], phases);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.policySlug).toBe("test-policy");
    expect(violations[0]!.missing.referencedArticlesNotDone).toEqual([
      { id: "w-b", currentPhase: "enrichment" },
    ]);
    expect(violations[0]!.missing.referencedArticles).toBeUndefined();
  });

  it("treats knowledge references as exempt (absent from phase map)", () => {
    const article = makeArticle(["k-foo"]);
    const policy = makePolicy(["k-foo"]);
    // k-foo not in the map → silently exempt from phase check.
    const phases = new Map<string, WorkPhase>();
    const violations = getPolicyViolations(article, [policy], phases);
    expect(violations).toEqual([]);
  });

  it("surfaces missing-reference and not-done independently", () => {
    // Policy requires both w-b and w-c. Article references only w-b
    // (which is in enrichment). w-c is missing entirely.
    const article = makeArticle(["w-b"]);
    const policy = makePolicy(["w-b", "w-c"]);
    const phases = new Map<string, WorkPhase>([["w-b", "enrichment"]]);
    const violations = getPolicyViolations(article, [policy], phases);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.missing.referencedArticles).toEqual(["w-c"]);
    expect(violations[0]!.missing.referencedArticlesNotDone).toEqual([
      { id: "w-b", currentPhase: "enrichment" },
    ]);
  });

  it("preserves legacy presence-only behavior when phase map is omitted", () => {
    const article = makeArticle(["w-b"]);
    const policy = makePolicy(["w-b"]);
    // No phase map → phase check skipped. w-b is present, so policy passes.
    const violations = getPolicyViolations(article, [policy]);
    expect(violations).toEqual([]);
  });

  it("missing references suppress the not-done check for that ref", () => {
    // w-b is required AND would-be-blocked-by-phase, but it isn't in
    // article.references, so it surfaces as missingRefs only — not in both.
    const article = makeArticle([]);
    const policy = makePolicy(["w-b"]);
    const phases = new Map<string, WorkPhase>([["w-b", "enrichment"]]);
    const violations = getPolicyViolations(article, [policy], phases);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.missing.referencedArticles).toEqual(["w-b"]);
    expect(violations[0]!.missing.referencedArticlesNotDone).toBeUndefined();
  });
});
