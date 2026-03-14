import { describe, expect, it } from "vitest";
import type { CouncilSpecializationId, CouncilVerdict } from "../../../schemas/council.js";
import {
  buildConsensusPayload,
  buildGovernanceOptions,
  evaluateModelDiversity,
  evaluateReviewerIndependence,
  type AgentIdentity,
  type ConsensusGovernanceOptions,
  type NormalizedReviewVerdictRecord,
  type ReviewVerdictRecord,
} from "../../../src/tickets/consensus.js";

function makeVerdict(
  specialization: CouncilSpecializationId,
  verdict: CouncilVerdict,
  agentId = `agent-${specialization}`,
  sessionId = `session-${agentId}`,
): ReviewVerdictRecord {
  return {
    specialization,
    verdict,
    agentId,
    sessionId,
    reasoning: null,
    createdAt: new Date().toISOString(),
  };
}

function makeNormalizedVerdict(
  specialization: CouncilSpecializationId,
  verdict: CouncilVerdict,
  agentId = `agent-${specialization}`,
  sessionId = `session-${agentId}`,
): NormalizedReviewVerdictRecord {
  return {
    specialization,
    verdict,
    agentId,
    sessionId,
    reasoning: null,
    createdAt: new Date().toISOString(),
  };
}

// ─── Non-voting role filtering ────────────────────────────────

describe("governance: non-voting role exclusion", () => {
  it("excludes facilitator verdicts from quorum counting", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-facilitator"),
      makeVerdict("simplifier", "pass", "agent-dev1"),
      makeVerdict("security", "pass", "agent-dev2"),
      makeVerdict("performance", "pass", "agent-dev3"),
      makeVerdict("patterns", "pass", "agent-dev4"),
    ];

    const governance: ConsensusGovernanceOptions = {
      nonVotingAgentIds: ["agent-facilitator"],
    };

    const result = buildConsensusPayload("TKT-test", verdicts, { governance });

    // Facilitator's architect verdict is excluded; architect shows as missing
    expect(result.counts.pass).toBe(4);
    expect(result.missingSpecializations).toContain("architect");
    expect(result.governance?.nonVotingExcluded).toHaveLength(1);
    expect(result.governance!.nonVotingExcluded[0]!.agentId).toBe("agent-facilitator");
    expect(result.governance!.nonVotingExcluded[0]!.specialization).toBe("architect");
  });

  it("reaches quorum without facilitator when enough other voters pass", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-dev1"),
      makeVerdict("simplifier", "pass", "agent-dev2"),
      makeVerdict("security", "pass", "agent-dev3"),
      makeVerdict("performance", "pass", "agent-dev4"),
      makeVerdict("patterns", "pass", "agent-facilitator"),
      makeVerdict("design", "pass", "agent-dev5"),
    ];

    const governance: ConsensusGovernanceOptions = {
      nonVotingAgentIds: ["agent-facilitator"],
    };

    const result = buildConsensusPayload("TKT-test", verdicts, {
      requiredPasses: 4,
      governance,
    });

    // The governed quorum is the 5 analytical specializations; design is excluded.
    expect(result.counts.pass).toBe(4);
    expect(result.quorumMet).toBe(true);
    expect(result.advisoryReady).toBe(true);
    expect(result.councilSpecializations).toEqual([
      "architect",
      "simplifier",
      "security",
      "performance",
      "patterns",
    ]);
    expect(result.missingSpecializations).toContain("patterns");
    expect(result.missingSpecializations).not.toContain("design");
  });

  it("does not exclude non-voting when no governance is provided", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-facilitator"),
      makeVerdict("simplifier", "pass"),
      makeVerdict("security", "pass"),
      makeVerdict("performance", "pass"),
    ];

    const result = buildConsensusPayload("TKT-test", verdicts);

    // Without governance, facilitator verdicts count normally
    expect(result.counts.pass).toBe(4);
    expect(result.quorumMet).toBe(true);
    expect(result.governance).toBeUndefined();
  });

  it("empty nonVotingAgentIds has no effect", () => {
    const verdicts = [
      makeVerdict("architect", "pass"),
      makeVerdict("simplifier", "pass"),
      makeVerdict("security", "pass"),
      makeVerdict("performance", "pass"),
    ];

    const governance: ConsensusGovernanceOptions = {
      nonVotingAgentIds: [],
    };

    const result = buildConsensusPayload("TKT-test", verdicts, { governance });
    expect(result.counts.pass).toBe(4);
    expect(result.governance?.nonVotingExcluded).toHaveLength(0);
  });
});

// ─── Model diversity evaluation ───────────────────────────────

describe("governance: model diversity evaluation", () => {
  it("reports full diversity when all voters have distinct provider+model", () => {
    const verdicts = [
      makeNormalizedVerdict("architect", "pass", "agent-1"),
      makeNormalizedVerdict("simplifier", "pass", "agent-2"),
      makeNormalizedVerdict("security", "pass", "agent-3"),
      makeNormalizedVerdict("performance", "pass", "agent-4"),
    ];

    const identities = new Map<string, AgentIdentity>([
      ["agent-1", { provider: "anthropic", model: "opus" }],
      ["agent-2", { provider: "anthropic", model: "sonnet" }],
      ["agent-3", { provider: "openai", model: "gpt-4" }],
      ["agent-4", { provider: "google", model: "gemini" }],
    ]);

    const result = evaluateModelDiversity(verdicts, identities);

    expect(result.diversityMet).toBe(true);
    expect(result.distinctModels).toBe(4);
    expect(result.duplicateGroups).toHaveLength(0);
    expect(result.ineligibleAgentIds).toHaveLength(0);
    expect(result.voterCapMet).toBe(true);
  });

  it("detects duplicate provider+model pairs", () => {
    const verdicts = [
      makeNormalizedVerdict("architect", "pass", "agent-1"),
      makeNormalizedVerdict("simplifier", "pass", "agent-2"),
      makeNormalizedVerdict("security", "pass", "agent-3"),
    ];

    const identities = new Map<string, AgentIdentity>([
      ["agent-1", { provider: "anthropic", model: "opus" }],
      ["agent-2", { provider: "anthropic", model: "opus" }],
      ["agent-3", { provider: "openai", model: "gpt-4" }],
    ]);

    const result = evaluateModelDiversity(verdicts, identities);

    expect(result.diversityMet).toBe(false);
    expect(result.distinctModels).toBe(2);
    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.duplicateGroups[0]!.provider).toBe("anthropic");
    expect(result.duplicateGroups[0]!.model).toBe("opus");
    expect(result.duplicateGroups[0]!.specializations).toEqual(
      expect.arrayContaining(["architect", "simplifier"]),
    );
  });

  it("marks agents missing provider or model as ineligible", () => {
    const verdicts = [
      makeNormalizedVerdict("architect", "pass", "agent-1"),
      makeNormalizedVerdict("simplifier", "pass", "agent-2"),
      makeNormalizedVerdict("security", "pass", "agent-3"),
    ];

    const identities = new Map<string, AgentIdentity>([
      ["agent-1", { provider: "anthropic", model: "opus" }],
      ["agent-2", { provider: null, model: "unknown" }],
      ["agent-3", { provider: "openai", model: null }],
    ]);

    const result = evaluateModelDiversity(verdicts, identities);

    expect(result.diversityMet).toBe(false);
    expect(result.ineligibleAgentIds).toEqual(
      expect.arrayContaining(["agent-2", "agent-3"]),
    );
    expect(result.diversityEligible).toBe(1);
  });

  it("only evaluates passing verdicts for diversity", () => {
    const verdicts = [
      makeNormalizedVerdict("architect", "pass", "agent-1"),
      makeNormalizedVerdict("simplifier", "fail", "agent-2"),
      makeNormalizedVerdict("security", "abstain", "agent-3"),
    ];

    const identities = new Map<string, AgentIdentity>([
      ["agent-1", { provider: "anthropic", model: "opus" }],
      ["agent-2", { provider: "anthropic", model: "opus" }],
      ["agent-3", { provider: "anthropic", model: "opus" }],
    ]);

    const result = evaluateModelDiversity(verdicts, identities);

    // Only agent-1 passed — one distinct model, no duplicates
    expect(result.diversityMet).toBe(true);
    expect(result.totalVoters).toBe(1);
    expect(result.distinctModels).toBe(1);
  });

  it("detects when more than three council voters share the same model", () => {
    const verdicts = [
      makeNormalizedVerdict("architect", "pass", "agent-1"),
      makeNormalizedVerdict("simplifier", "pass", "agent-2"),
      makeNormalizedVerdict("security", "pass", "agent-3"),
      makeNormalizedVerdict("performance", "fail", "agent-4"),
    ];

    const identities = new Map<string, AgentIdentity>([
      ["agent-1", { provider: "openai", model: "gpt-5" }],
      ["agent-2", { provider: "openai", model: "gpt-5" }],
      ["agent-3", { provider: "openai", model: "gpt-5" }],
      ["agent-4", { provider: "openai", model: "gpt-5" }],
    ]);

    const result = evaluateModelDiversity(verdicts, identities, { maxVotersPerModel: 3 });

    expect(result.voterCapMet).toBe(false);
    expect(result.maxVotersPerModel).toBe(3);
    expect(result.overSubscribedGroups).toEqual([
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5",
        totalVoters: 4,
        maxVoters: 3,
      }),
    ]);
    expect(result.diversityMet).toBe(false);
  });
});

// ─── Strict diversity + quorum interaction ────────────────────

describe("governance: strict diversity enforcement", () => {
  it("deduplicates pass count when strict diversity is enabled", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-1"),
      makeVerdict("simplifier", "pass", "agent-2"),
      makeVerdict("security", "pass", "agent-3"),
      makeVerdict("performance", "pass", "agent-4"),
    ];

    const identities = new Map<string, AgentIdentity>([
      ["agent-1", { provider: "anthropic", model: "opus" }],
      ["agent-2", { provider: "anthropic", model: "opus" }],
      ["agent-3", { provider: "anthropic", model: "opus" }],
      ["agent-4", { provider: "openai", model: "gpt-4" }],
    ]);

    const result = buildConsensusPayload("TKT-test", verdicts, {
      requiredPasses: 4,
      governance: {
        agentIdentities: identities,
        strictDiversity: true,
      },
    });

    // 3 agents share anthropic::opus → only 1 counts, plus 1 for gpt-4 = 2 effective passes
    expect(result.counts.pass).toBe(2);
    expect(result.quorumMet).toBe(false);
    expect(result.advisoryReady).toBe(false);
    expect(result.governance?.modelDiversity?.diversityMet).toBe(false);
  });

  it("does not deduplicate when strict diversity is disabled", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-1"),
      makeVerdict("simplifier", "pass", "agent-2"),
      makeVerdict("security", "pass", "agent-3"),
      makeVerdict("performance", "pass", "agent-4"),
    ];

    const identities = new Map<string, AgentIdentity>([
      ["agent-1", { provider: "anthropic", model: "opus" }],
      ["agent-2", { provider: "anthropic", model: "opus" }],
      ["agent-3", { provider: "anthropic", model: "opus" }],
      ["agent-4", { provider: "openai", model: "gpt-4" }],
    ]);

    const result = buildConsensusPayload("TKT-test", verdicts, {
      requiredPasses: 4,
      governance: {
        agentIdentities: identities,
        strictDiversity: false,
      },
    });

    // Without strict, all 4 passes count
    expect(result.counts.pass).toBe(4);
    expect(result.quorumMet).toBe(true);
    // diversityMet is false (duplicates exist) but advisoryReady is true because strict is off
    expect(result.governance?.modelDiversity?.diversityMet).toBe(false);
    expect(result.advisoryReady).toBe(true);
  });

  it("advisoryReady is false when strict diversity fails even if quorum met", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-1"),
      makeVerdict("simplifier", "pass", "agent-2"),
      makeVerdict("security", "pass", "agent-3"),
      makeVerdict("performance", "pass", "agent-4"),
      makeVerdict("patterns", "pass", "agent-5"),
      makeVerdict("design", "pass", "agent-6"),
    ];

    const identities = new Map<string, AgentIdentity>([
      ["agent-1", { provider: "anthropic", model: "opus" }],
      ["agent-2", { provider: "google", model: "gemini" }],
      ["agent-3", { provider: "openai", model: "gpt-4" }],
      ["agent-4", { provider: "anthropic", model: "opus" }],
      ["agent-5", { provider: "meta", model: "llama" }],
      ["agent-6", { provider: "mistral", model: "large" }],
    ]);

    const result = buildConsensusPayload("TKT-test", verdicts, {
      requiredPasses: 4,
      governance: {
        agentIdentities: identities,
        strictDiversity: true,
      },
    });

    // Governed quorum excludes design; among the 5 analytical specializations,
    // duplicates collapse to 4 effective passes, which still meets quorum.
    expect(result.counts.pass).toBe(4);
    expect(result.quorumMet).toBe(true);
    // But diversity not fully met (duplicates exist) → advisoryReady blocked
    expect(result.governance?.modelDiversity?.diversityMet).toBe(false);
    expect(result.advisoryReady).toBe(false);
  });

  it("does not count pass votes missing provider or model when strict diversity is enabled", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-1"),
      makeVerdict("simplifier", "pass", "agent-2"),
      makeVerdict("security", "pass", "agent-3"),
      makeVerdict("performance", "pass", "agent-4"),
    ];

    const identities = new Map<string, AgentIdentity>([
      ["agent-1", { provider: "anthropic", model: "opus" }],
      ["agent-2", { provider: "openai", model: "gpt-4" }],
      ["agent-3", { provider: null, model: "unknown" }],
      ["agent-4", { provider: "google", model: null }],
    ]);

    const result = buildConsensusPayload("TKT-test", verdicts, {
      requiredPasses: 4,
      governance: {
        agentIdentities: identities,
        strictDiversity: true,
      },
    });

    expect(result.counts.pass).toBe(2);
    expect(result.quorumMet).toBe(false);
    expect(result.governance?.modelDiversity?.ineligibleAgentIds).toEqual(
      expect.arrayContaining(["agent-3", "agent-4"]),
    );
    expect(result.advisoryReady).toBe(false);
  });

  it("blocks advisory readiness when the same model sends more than three voters, even if strict diversity is relaxed", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-1"),
      makeVerdict("simplifier", "pass", "agent-2"),
      makeVerdict("security", "pass", "agent-3"),
      makeVerdict("performance", "pass", "agent-4"),
      makeVerdict("patterns", "pass", "agent-5"),
    ];

    const identities = new Map<string, AgentIdentity>([
      ["agent-1", { provider: "openai", model: "gpt-5" }],
      ["agent-2", { provider: "openai", model: "gpt-5" }],
      ["agent-3", { provider: "openai", model: "gpt-5" }],
      ["agent-4", { provider: "openai", model: "gpt-5" }],
      ["agent-5", { provider: "anthropic", model: "opus" }],
    ]);

    const result = buildConsensusPayload("TKT-test", verdicts, {
      requiredPasses: 4,
      governance: {
        agentIdentities: identities,
        strictDiversity: false,
        maxVotersPerModel: 3,
      },
    });

    expect(result.counts.pass).toBe(4);
    expect(result.quorumMet).toBe(true);
    expect(result.governance?.modelDiversity?.voterCapMet).toBe(false);
    expect(result.advisoryReady).toBe(false);
  });
});

describe("governance: reviewer independence", () => {
  it("deduplicates counted passes when the same agent covers multiple specializations", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-review"),
      makeVerdict("simplifier", "pass", "agent-review"),
      makeVerdict("security", "pass", "agent-review"),
      makeVerdict("performance", "pass", "agent-review"),
    ];

    const result = buildConsensusPayload("TKT-test", verdicts, {
      requiredPasses: 4,
      governance: {
        strictReviewerIndependence: true,
        reviewerIdentityKey: "agent",
      },
    });

    expect(result.counts.pass).toBe(1);
    expect(result.quorumMet).toBe(false);
    expect(result.advisoryReady).toBe(false);
    expect(result.governance?.reviewerIndependence).toMatchObject({
      identityKey: "agent",
      distinctReviewers: 1,
      totalVoters: 4,
      independenceMet: false,
    });
    expect(result.governance?.reviewerIndependence?.duplicateGroups).toEqual([
      expect.objectContaining({
        reviewerKey: "agent-review",
        specializations: ["architect", "simplifier", "security", "performance"],
      }),
    ]);
  });

  it("treats same-agent multi-session verdicts as non-independent in agent mode", () => {
    const verdicts = [
      makeNormalizedVerdict("architect", "pass", "agent-review", "session-a"),
      makeNormalizedVerdict("security", "pass", "agent-review", "session-b"),
    ];

    const result = evaluateReviewerIndependence(verdicts, "agent");

    expect(result.independenceMet).toBe(false);
    expect(result.duplicateGroups).toEqual([
      expect.objectContaining({
        reviewerKey: "agent-review",
        sessionIds: ["session-a", "session-b"],
        specializations: ["architect", "security"],
      }),
    ]);
  });

  it("allows duplicate reviewer identities when strict independence is disabled", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-review"),
      makeVerdict("simplifier", "pass", "agent-review"),
      makeVerdict("security", "pass", "agent-other"),
      makeVerdict("performance", "pass", "agent-third"),
    ];

    const result = buildConsensusPayload("TKT-test", verdicts, {
      requiredPasses: 4,
      governance: {
        strictReviewerIndependence: false,
        reviewerIdentityKey: "agent",
      },
    });

    expect(result.counts.pass).toBe(4);
    expect(result.quorumMet).toBe(true);
    expect(result.advisoryReady).toBe(true);
  });
});

// ─── buildGovernanceOptions helper ────────────────────────────

describe("buildGovernanceOptions", () => {
  it("identifies facilitator agents as non-voting", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-fac"),
      makeVerdict("simplifier", "pass", "agent-dev"),
    ];

    const agentDb: Record<string, { roleId: string; provider: string | null; model: string | null }> = {
      "agent-fac": { roleId: "facilitator", provider: "anthropic", model: "opus" },
      "agent-dev": { roleId: "developer", provider: "openai", model: "gpt-4" },
    };

    const opts = buildGovernanceOptions(
      {
        nonVotingRoles: ["facilitator"],
        modelDiversity: { strict: true, maxVotersPerModel: 3 },
        reviewerIndependence: { strict: true, identityKey: "agent" },
        backlogPlanningGate: { enforce: true, minIterations: 3, requiredDistinctModels: 2 },
        requireBinding: false,
        autoAdvance: true,
        autoAdvanceExcludedTags: [],
      },
      verdicts,
      (id) => agentDb[id],
    );

    expect(opts).toBeDefined();
    expect(opts!.nonVotingAgentIds).toEqual(["agent-fac"]);
    expect(opts!.agentIdentities?.get("agent-dev")).toEqual({ provider: "openai", model: "gpt-4" });
    expect(opts!.strictDiversity).toBe(true);
    expect(opts!.maxVotersPerModel).toBe(3);
    expect(opts!.strictReviewerIndependence).toBe(true);
    expect(opts!.reviewerIdentityKey).toBe("agent");
  });

  it("returns undefined when no governance config is provided", () => {
    const opts = buildGovernanceOptions(undefined, [], () => undefined);
    expect(opts).toBeUndefined();
  });

  it("handles agents not found in the lookup", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-unknown"),
    ];

    const opts = buildGovernanceOptions(
      {
        nonVotingRoles: ["facilitator"],
        modelDiversity: { strict: true, maxVotersPerModel: 3 },
        reviewerIndependence: { strict: true, identityKey: "agent" },
        backlogPlanningGate: { enforce: true, minIterations: 3, requiredDistinctModels: 2 },
        requireBinding: false,
        autoAdvance: true,
        autoAdvanceExcludedTags: [],
      },
      verdicts,
      () => undefined,
    );

    expect(opts).toBeDefined();
    expect(opts!.nonVotingAgentIds).toEqual([]);
    expect(opts!.agentIdentities?.size).toBe(0);
  });

  it("waives strict model diversity for critical tickets only", () => {
    const verdicts = [
      makeVerdict("architect", "pass", "agent-a"),
      makeVerdict("security", "pass", "agent-b"),
    ];
    const agentDb: Record<string, { roleId: string; provider: string | null; model: string | null }> = {
      "agent-a": { roleId: "reviewer", provider: "openai", model: "gpt-5" },
      "agent-b": { roleId: "reviewer", provider: "openai", model: "gpt-5" },
    };

    const normal = buildGovernanceOptions(
      {
        nonVotingRoles: ["facilitator"],
        modelDiversity: { strict: true, maxVotersPerModel: 3 },
        reviewerIndependence: { strict: true, identityKey: "agent" },
        backlogPlanningGate: { enforce: true, minIterations: 3, requiredDistinctModels: 2 },
        requireBinding: false,
        autoAdvance: true,
        autoAdvanceExcludedTags: [],
      },
      verdicts,
      (id) => agentDb[id],
      "high",
    );
    const critical = buildGovernanceOptions(
      {
        nonVotingRoles: ["facilitator"],
        modelDiversity: { strict: true, maxVotersPerModel: 3 },
        reviewerIndependence: { strict: true, identityKey: "agent" },
        backlogPlanningGate: { enforce: true, minIterations: 3, requiredDistinctModels: 2 },
        requireBinding: false,
        autoAdvance: true,
        autoAdvanceExcludedTags: [],
      },
      verdicts,
      (id) => agentDb[id],
      "critical",
    );

    expect(normal?.strictDiversity).toBe(true);
    expect(critical?.strictDiversity).toBe(false);
  });
});
