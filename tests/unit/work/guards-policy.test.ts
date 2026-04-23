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
import { policy_requirements_met, getPolicyViolations } from "../../../src/work/guards.js";
import type { Policy } from "../../../src/work/policy-loader.js";

function makeArticle(overrides: Partial<WorkArticle> = {}): WorkArticle {
  return {
    id: workId("w-test0001"),
    title: "Test Work",
    template: WorkTemplate.FEATURE,
    phase: WorkPhase.ENRICHMENT,
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
    content: "",
    createdAt: timestamp(),
    updatedAt: timestamp(),
    ...overrides,
  };
}

function securityPolicy(overrides?: Partial<Policy>): Policy {
  return {
    id: "k-policy-sec",
    slug: "policy-feature-auth-security",
    title: "Policy: security must review auth features",
    appliesTo: {
      templates: [WorkTemplate.FEATURE],
      phaseTransition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
    },
    requires: {
      enrichmentRoles: ["security"],
      referencedArticles: [],
    },
    rationale: "",
    ...overrides,
  };
}

describe("policy_requirements_met", () => {
  it("returns true when no policies are supplied (nothing to enforce)", () => {
    const article = makeArticle();
    expect(policy_requirements_met(article, { policies: [] })).toBe(true);
  });

  it("returns true when required role has contributed", () => {
    const article = makeArticle({
      enrichmentRoles: [
        {
          role: "security",
          agentId: agentId("agent-sec"),
          status: "contributed",
          contributedAt: timestamp(),
        },
      ],
    });
    expect(policy_requirements_met(article, { policies: [securityPolicy()] })).toBe(true);
  });

  it("returns true when required role is explicitly skipped", () => {
    const article = makeArticle({
      enrichmentRoles: [
        {
          role: "security",
          agentId: agentId("agent-sec"),
          status: "skipped",
          contributedAt: timestamp(),
        },
      ],
    });
    expect(policy_requirements_met(article, { policies: [securityPolicy()] })).toBe(true);
  });

  it("returns false when required role is still pending", () => {
    const article = makeArticle({
      enrichmentRoles: [
        { role: "security", agentId: agentId("agent-sec"), status: "pending" },
      ],
    });
    expect(policy_requirements_met(article, { policies: [securityPolicy()] })).toBe(false);
  });

  it("returns false when required role is missing entirely", () => {
    const article = makeArticle({ enrichmentRoles: [] });
    expect(policy_requirements_met(article, { policies: [securityPolicy()] })).toBe(false);
  });

  it("returns false when referenced_articles requirement is unmet", () => {
    const policy = securityPolicy({
      requires: { enrichmentRoles: [], referencedArticles: ["k-threat-model"] },
    });
    const article = makeArticle({ references: ["k-other"] });
    expect(policy_requirements_met(article, { policies: [policy] })).toBe(false);
  });

  it("returns true when every required referenced_article is present", () => {
    const policy = securityPolicy({
      requires: { enrichmentRoles: [], referencedArticles: ["k-threat-model"] },
    });
    const article = makeArticle({ references: ["k-threat-model", "k-other"] });
    expect(policy_requirements_met(article, { policies: [policy] })).toBe(true);
  });

  it("all policies must pass (AND semantics)", () => {
    const archPolicy = securityPolicy({
      slug: "policy-arch",
      requires: { enrichmentRoles: ["architecture"], referencedArticles: [] },
    });
    const secPolicy = securityPolicy();
    const article = makeArticle({
      enrichmentRoles: [
        {
          role: "security",
          agentId: agentId("agent-sec"),
          status: "contributed",
          contributedAt: timestamp(),
        },
      ],
    });
    expect(policy_requirements_met(article, { policies: [archPolicy, secPolicy] })).toBe(false);
  });
});

describe("getPolicyViolations", () => {
  it("reports the specific policy slug and what is missing", () => {
    const article = makeArticle();
    const policy = securityPolicy();
    const violations = getPolicyViolations(article, [policy]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.policySlug).toBe("policy-feature-auth-security");
    expect(violations[0]?.missing.enrichmentRoles).toEqual(["security"]);
    expect(violations[0]?.missing.referencedArticles).toBeUndefined();
  });

  it("returns an empty list when every policy is satisfied", () => {
    const article = makeArticle({
      enrichmentRoles: [
        {
          role: "security",
          agentId: agentId("agent-sec"),
          status: "contributed",
          contributedAt: timestamp(),
        },
      ],
    });
    expect(getPolicyViolations(article, [securityPolicy()])).toEqual([]);
  });

  it("includes both missing roles and references in a single violation entry", () => {
    const policy = securityPolicy({
      requires: {
        enrichmentRoles: ["security", "architecture"],
        referencedArticles: ["k-threat-model"],
      },
    });
    const article = makeArticle({
      enrichmentRoles: [
        {
          role: "security",
          agentId: agentId("agent-sec"),
          status: "contributed",
          contributedAt: timestamp(),
        },
      ],
    });
    const violations = getPolicyViolations(article, [policy]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.missing.enrichmentRoles).toEqual(["architecture"]);
    expect(violations[0]?.missing.referencedArticles).toEqual(["k-threat-model"]);
  });
});
