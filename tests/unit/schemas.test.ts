import { describe, it, expect } from "vitest";
import { EvidenceBundle, TrustTier, Candidate, ExpandedCandidate } from "../../schemas/evidence-bundle.js";
import { Note, NoteType, ProposeNoteInput } from "../../schemas/notes.js";
import { PatchProposal, ProposePatchInput, PatchState } from "../../schemas/patch.js";
import { Agent, RegisterAgentInput, RoleId, BUILT_IN_ROLES } from "../../schemas/agent.js";
import { CouncilSpecializationId } from "../../schemas/council.js";
import { EventLog, EventStatus } from "../../schemas/interaction-log.js";
import { CoordinationMessage, BroadcastInput } from "../../schemas/coordination.js";

describe("Evidence Bundle schema", () => {
  const validBundle: unknown = {
    bundleId: "abc123",
    repoId: "repo-1",
    commit: "deadbeef",
    query: "find auth handler",
    timestamp: "2026-03-07T10:00:00Z",
    trustTier: "A",
    redactionPolicy: "none",
    searchBackend: "zoekt",
    latencyMs: 42,
    candidates: [
      {
        path: "src/auth/handler.ts",
        language: "typescript",
        relevanceScore: 0.95,
        summary: "Auth handler with JWT validation",
        symbols: [{ name: "handleAuth", kind: "function", line: 10 }],
        provenance: "search_hit",
      },
    ],
  };

  it("accepts a valid Evidence Bundle", () => {
    const result = EvidenceBundle.safeParse(validBundle);
    expect(result.success).toBe(true);
  });

  it("rejects bundle without bundleId", () => {
    const { bundleId, ...rest } = validBundle as Record<string, unknown>;
    const result = EvidenceBundle.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects bundle with more than 5 candidates", () => {
    const bundle = {
      ...validBundle as Record<string, unknown>,
      candidates: Array(6).fill({
        path: "a.ts",
        language: "typescript",
        relevanceScore: 0.5,
        summary: "x",
        provenance: "search_hit",
      }),
    };
    const result = EvidenceBundle.safeParse(bundle);
    expect(result.success).toBe(false);
  });

  it("rejects invalid trust tier", () => {
    const result = TrustTier.safeParse("C");
    expect(result.success).toBe(false);
  });

  it("accepts valid trust tiers", () => {
    expect(TrustTier.safeParse("A").success).toBe(true);
    expect(TrustTier.safeParse("B").success).toBe(true);
  });

  it("rejects expanded with more than 3 items", () => {
    const bundle = {
      ...validBundle as Record<string, unknown>,
      expanded: Array(4).fill({
        path: "a.ts",
        language: "typescript",
        relevanceScore: 0.5,
        summary: "x",
        provenance: "search_hit",
        codeSpan: null,
        spanLines: null,
      }),
    };
    const result = EvidenceBundle.safeParse(bundle);
    expect(result.success).toBe(false);
  });
});

describe("Note schema", () => {
  it("accepts all valid note types", () => {
    const types = ["issue", "decision", "change_note", "gotcha", "runbook", "repo_map", "module_map", "file_summary"];
    for (const type of types) {
      expect(NoteType.safeParse(type).success).toBe(true);
    }
  });

  it("rejects unknown note types", () => {
    expect(NoteType.safeParse("unknown_type").success).toBe(false);
  });

  it("validates ProposeNoteInput", () => {
    const valid = { type: "issue", content: "Bug in auth" };
    expect(ProposeNoteInput.safeParse(valid).success).toBe(true);
  });

  it("rejects empty content", () => {
    const invalid = { type: "issue", content: "" };
    expect(ProposeNoteInput.safeParse(invalid).success).toBe(false);
  });
});

describe("Patch schema", () => {
  it("validates ProposePatchInput with baseCommit", () => {
    const valid = {
      diff: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
      message: "Fix auth bug",
      baseCommit: "abc1234",
    };
    expect(ProposePatchInput.safeParse(valid).success).toBe(true);
  });

  it("rejects patch without baseCommit (invariant 2)", () => {
    const invalid = {
      diff: "some diff",
      message: "Fix",
    };
    expect(ProposePatchInput.safeParse(invalid).success).toBe(false);
  });

  it("rejects baseCommit shorter than 7 chars", () => {
    const invalid = {
      diff: "some diff",
      message: "Fix",
      baseCommit: "abc",
    };
    expect(ProposePatchInput.safeParse(invalid).success).toBe(false);
  });

  it("accepts all valid patch states", () => {
    for (const state of ["proposed", "validated", "applied", "committed", "stale", "failed"]) {
      expect(PatchState.safeParse(state).success).toBe(true);
    }
  });
});

describe("Agent schema", () => {
  it("validates RegisterAgentInput", () => {
    const valid = {
      name: "claude-code-1",
      type: "claude-code",
      provider: "anthropic",
      model: "claude-3.7-sonnet",
      identitySource: "self_declared",
      desiredRole: "developer",
      authToken: "dev-secret",
    };
    expect(RegisterAgentInput.safeParse(valid).success).toBe(true);
  });

  it("defaults to observer role", () => {
    const input = { name: "test-agent" };
    const result = RegisterAgentInput.parse(input);
    expect(result.desiredRole).toBe("observer");
  });

  it("rejects invalid role", () => {
    const invalid = { name: "test", desiredRole: "superadmin" };
    expect(RegisterAgentInput.safeParse(invalid).success).toBe(false);
  });

  it("rejects empty authToken", () => {
    const invalid = { name: "test", desiredRole: "developer", authToken: "" };
    expect(RegisterAgentInput.safeParse(invalid).success).toBe(false);
  });

  it("defaults missing stored identity fields to null", () => {
    const result = Agent.parse({
      id: "agent-1",
      name: "Agent",
      type: "codex",
      roleId: "developer",
      trustTier: "A",
      registeredAt: "2026-03-07T10:00:00Z",
    });

    expect(result.provider).toBeNull();
    expect(result.model).toBeNull();
    expect(result.identitySource).toBeNull();
  });

  it("accepts only the agreed council specialization taxonomy", () => {
    expect(CouncilSpecializationId.safeParse("architect").success).toBe(true);
    expect(CouncilSpecializationId.safeParse("patterns").success).toBe(true);
    expect(CouncilSpecializationId.safeParse("design").success).toBe(true);
    expect(CouncilSpecializationId.safeParse("dx").success).toBe(false);
    expect(CouncilSpecializationId.safeParse("simplicity").success).toBe(false);
  });

  it("has correct built-in role permissions", () => {
    // Developer can propose patches
    expect(BUILT_IN_ROLES.developer.permissions.canProposePatch).toBe(true);
    // Reviewer cannot
    expect(BUILT_IN_ROLES.reviewer.permissions.canProposePatch).toBe(false);
    // Observer has Tier B
    expect(BUILT_IN_ROLES.observer.permissions.trustTier).toBe("B");
    // Admin has wildcard
    expect(BUILT_IN_ROLES.admin.permissions.allowedTools).toContain("*");
  });
});

describe("EventLog schema", () => {
  it("accepts valid event statuses", () => {
    for (const status of ["success", "error", "denied", "stale"]) {
      expect(EventStatus.safeParse(status).success).toBe(true);
    }
  });
});

describe("Coordination schema", () => {
  it("validates BroadcastInput", () => {
    const valid = { message: "Starting work on auth module" };
    expect(BroadcastInput.safeParse(valid).success).toBe(true);
  });

  it("rejects empty broadcast message", () => {
    const invalid = { message: "" };
    expect(BroadcastInput.safeParse(invalid).success).toBe(false);
  });
});
