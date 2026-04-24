import { describe, it, expect } from "vitest";
import {
  agentId,
  timestamp,
  workId,
  WorkPhase,
  WorkTemplate,
  Priority,
} from "../../../src/core/types.js";
import type { WorkArticle } from "../../../src/work/repository.js";
import type { CanonicalValue } from "../../../src/work/policy-loader.js";
import {
  content_matches_canonical_values,
  getCanonicalValueViolations,
} from "../../../src/work/guards.js";

function makeArticle(content: string): WorkArticle {
  return {
    id: workId("w-test0001"),
    title: "Test Work",
    template: WorkTemplate.FEATURE,
    phase: WorkPhase.IMPLEMENTATION,
    priority: Priority.MEDIUM,
    author: agentId("agent-1"),
    enrichmentRoles: [],
    reviewers: [],
    phaseHistory: [{ phase: WorkPhase.PLANNING, enteredAt: timestamp() }],
    tags: [],
    references: [],
    codeRefs: [],
    dependencies: [],
    blockedBy: [],
    content,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
}

const cv_rt: CanonicalValue = { name: "c_rt", value: "$0.010", unit: "per_rt" };
const K_min: CanonicalValue = { name: "K_min", value: "$1,815", unit: "usd" };
const ws11: CanonicalValue = { name: "ws11_bars", value: "22.35", unit: "count" };

describe("getCanonicalValueViolations", () => {
  it("returns [] when no canonical values are registered", () => {
    const article = makeArticle("anything");
    expect(getCanonicalValueViolations(article, [])).toEqual([]);
  });

  it("returns [] when the article never mentions a canonical name", () => {
    const article = makeArticle("This is about something unrelated entirely.");
    expect(getCanonicalValueViolations(article, [cv_rt, K_min])).toEqual([]);
  });

  it("returns [] when a mentioned name is followed by the expected value", () => {
    const article = makeArticle("The per-RT cost c_rt = $0.010 per transaction.");
    expect(getCanonicalValueViolations(article, [cv_rt])).toEqual([]);
  });

  it("flags drift when the nearby number differs", () => {
    const article = makeArticle("The per-RT cost c_rt = $0.10 per transaction.");
    const violations = getCanonicalValueViolations(article, [cv_rt]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.name).toBe("c_rt");
    expect(violations[0]?.expected).toBe("$0.010");
    expect(violations[0]?.found).toBe("$0.10");
    expect(violations[0]?.lineHint).toContain("c_rt = $0.10");
  });

  it("normalises commas and $ signs — $1,815 matches 1815", () => {
    const article = makeArticle("K_min floor is 1815 USD");
    expect(getCanonicalValueViolations(article, [K_min])).toEqual([]);
  });

  it("distinguishes trailing-zero precision (0.010 vs 0.01) as drift", () => {
    const article = makeArticle("c_rt is 0.01 per rt");
    const violations = getCanonicalValueViolations(article, [cv_rt]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.found).toBe("0.01");
  });

  it("is silent on descriptive mentions with no nearby number", () => {
    const article = makeArticle(
      "Several paragraphs discuss c_rt conceptually without pinning a value here.",
    );
    expect(getCanonicalValueViolations(article, [cv_rt])).toEqual([]);
  });

  it("does not match partial names (c_rt should not match src_rt)", () => {
    const article = makeArticle("The src_rt metric sits at 99.99");
    expect(getCanonicalValueViolations(article, [cv_rt])).toEqual([]);
  });

  it("catches multiple mismatches across several canonical values", () => {
    const article = makeArticle(
      "Summary:\n- c_rt = $0.10\n- ws11_bars = 21.0\n- K_min = $1,815 (fine)\n",
    );
    const violations = getCanonicalValueViolations(article, [cv_rt, ws11, K_min]);
    expect(violations.map((v) => v.name).sort()).toEqual(["c_rt", "ws11_bars"]);
  });

  it("does not flag the same occurrence twice", () => {
    const article = makeArticle("c_rt = $0.10\nc_rt is drifted to $0.10 again.");
    const violations = getCanonicalValueViolations(article, [cv_rt]);
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.name === "c_rt" && v.found === "$0.10")).toBe(true);
  });
});

describe("content_matches_canonical_values guard", () => {
  it("returns true when no violations exist", () => {
    const article = makeArticle("c_rt = $0.010");
    expect(content_matches_canonical_values(article, { canonicalValues: [cv_rt] })).toBe(true);
  });

  it("returns true when canonical values list is empty", () => {
    const article = makeArticle("c_rt = $0.10");
    expect(content_matches_canonical_values(article, { canonicalValues: [] })).toBe(true);
  });

  it("returns false when a violation exists", () => {
    const article = makeArticle("c_rt = $0.10");
    expect(content_matches_canonical_values(article, { canonicalValues: [cv_rt] })).toBe(false);
  });
});
