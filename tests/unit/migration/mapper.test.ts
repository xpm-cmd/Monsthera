import { describe, it, expect } from "vitest";
import { mapTicketToArticle, mapKnowledgeToArticle, mapNoteToArticle, computeMigrationHash } from "../../../src/migration/mapper.js";
import type { V2Ticket, V2Verdict, V2CouncilAssignment, V2KnowledgeRecord, V2NoteRecord } from "../../../src/migration/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTicket(overrides?: Partial<V2Ticket>): V2Ticket {
  return {
    id: "T-1001",
    title: "Add user dashboard",
    body: "Build a dashboard for users to view their stats.",
    status: "open",
    priority: "p1",
    assignee: "alice",
    tags: ["frontend", "ux"],
    codeRefs: ["src/dashboard.ts"],
    acceptance_criteria: "Dashboard shows user stats.",
    created_at: "2025-01-15T10:00:00Z",
    updated_at: "2025-01-16T12:00:00Z",
    resolved_at: null,
    ...overrides,
  };
}

function makeKnowledge(overrides?: Partial<V2KnowledgeRecord>): V2KnowledgeRecord {
  return {
    key: "context:architecture-overview",
    type: "context",
    scope: "repo",
    title: "Architecture Overview",
    content: "System architecture summary.",
    tags: ["architecture"],
    created_at: "2025-01-10T10:00:00Z",
    updated_at: "2025-01-11T12:00:00Z",
    ...overrides,
  };
}

function makeNote(overrides?: Partial<V2NoteRecord>): V2NoteRecord {
  return {
    key: "runbook:def544c78b44",
    type: "runbook",
    content: "Post-Commit Agora Maintenance\n\nRun indexing after every commit.",
    tags: ["topic:maintenance"],
    codeRefs: ["src/index.ts"],
    created_at: "2025-01-12T10:00:00Z",
    updated_at: "2025-01-12T12:00:00Z",
    ...overrides,
  };
}

function makeVerdict(overrides?: Partial<V2Verdict>): V2Verdict {
  return {
    ticket_id: "T-1001",
    council_member: "security-bot",
    outcome: "approved",
    reasoning: "No security concerns with this feature.",
    created_at: "2025-01-15T11:00:00Z",
    ...overrides,
  };
}

function makeAssignment(overrides?: Partial<V2CouncilAssignment>): V2CouncilAssignment {
  return {
    ticket_id: "T-1001",
    council_member: "arch-bot",
    role: "architecture",
    assigned_at: "2025-01-15T10:30:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// mapTicketToArticle
// ---------------------------------------------------------------------------

describe("mapTicketToArticle", () => {
  it("maps a basic ticket to a work article", () => {
    const result = mapTicketToArticle(makeTicket(), [], []);

    expect(result.v2Id).toBe("T-1001");
    expect(result.title).toBe("Add user dashboard");
    expect(result.template).toBe("feature");
    expect(result.priority).toBe("high");
    expect(result.aliases).toEqual(["T-1001"]);
    expect(result.tags).toEqual(["frontend", "ux"]);
    expect(result.codeRefs).toEqual(["src/dashboard.ts"]);
    expect(result.phase).toBe("planning");
    expect(result.content).toContain("Build a dashboard");
  });

  it("preserves the v2 ID as an alias", () => {
    const result = mapTicketToArticle(makeTicket({ id: "T-9999" }), [], []);
    expect(result.aliases).toEqual(["T-9999"]);
  });

  it("maps v2 priorities to v3 priorities", () => {
    expect(mapTicketToArticle(makeTicket({ priority: "p0" }), [], []).priority).toBe("critical");
    expect(mapTicketToArticle(makeTicket({ priority: "p1" }), [], []).priority).toBe("high");
    expect(mapTicketToArticle(makeTicket({ priority: "p2" }), [], []).priority).toBe("medium");
    expect(mapTicketToArticle(makeTicket({ priority: "p3" }), [], []).priority).toBe("low");
  });

  it("infers bugfix template from tags", () => {
    const result = mapTicketToArticle(makeTicket({ tags: ["bug"] }), [], []);
    expect(result.template).toBe("bugfix");
  });

  it("infers bugfix template from title prefix", () => {
    const result = mapTicketToArticle(makeTicket({ title: "Fix login crash" }), [], []);
    expect(result.template).toBe("bugfix");
  });

  it("infers refactor template from tags", () => {
    const result = mapTicketToArticle(makeTicket({ tags: ["refactor"] }), [], []);
    expect(result.template).toBe("refactor");
  });

  it("infers spike template from tags", () => {
    const result = mapTicketToArticle(makeTicket({ tags: ["spike"] }), [], []);
    expect(result.template).toBe("spike");
  });

  it("defaults to feature template", () => {
    const result = mapTicketToArticle(makeTicket({ tags: [], title: "Add analytics" }), [], []);
    expect(result.template).toBe("feature");
  });

  it("includes verdicts as enrichment sections in content", () => {
    const verdict = makeVerdict({ council_member: "perf-bot", outcome: "approved", reasoning: "Looks good." });
    const result = mapTicketToArticle(makeTicket(), [verdict], []);

    expect(result.content).toContain("## Verdict: perf-bot");
    expect(result.content).toContain("<!-- status: approved -->");
    expect(result.content).toContain("Looks good.");
  });

  it("includes council assignments in content", () => {
    const assignment = makeAssignment({ council_member: "arch-bot", role: "architecture" });
    const result = mapTicketToArticle(makeTicket(), [], [assignment]);

    expect(result.content).toContain("## Council Assignments");
    expect(result.content).toContain("**arch-bot** as architecture");
  });

  it("handles empty body gracefully", () => {
    const result = mapTicketToArticle(makeTicket({ body: "" }), [], []);
    expect(result.content).not.toMatch(/^\s*---/);
  });

  it("handles multiple verdicts", () => {
    const v1 = makeVerdict({ council_member: "security-bot", outcome: "approved", reasoning: "OK" });
    const v2 = makeVerdict({ council_member: "perf-bot", outcome: "rejected", reasoning: "Too slow" });
    const result = mapTicketToArticle(makeTicket(), [v1, v2], []);

    expect(result.content).toContain("## Verdict: security-bot");
    expect(result.content).toContain("## Verdict: perf-bot");
    expect(result.content).toContain("<!-- status: rejected -->");
  });

  it("maps implementation and terminal phases from the source status", () => {
    expect(mapTicketToArticle(makeTicket({ status: "in-progress" }), [], []).phase).toBe("implementation");
    expect(mapTicketToArticle(makeTicket({ status: "resolved" }), [], []).phase).toBe("done");
    expect(mapTicketToArticle(makeTicket({ status: "wontfix" }), [], []).phase).toBe("cancelled");
  });

  it("includes acceptance criteria when present", () => {
    const result = mapTicketToArticle(makeTicket(), [], []);
    expect(result.content).toContain("## Acceptance Criteria");
    expect(result.content).toContain("Dashboard shows user stats.");
  });
});

describe("knowledge mapping", () => {
  it("maps knowledge rows to v3 knowledge articles", () => {
    const result = mapKnowledgeToArticle(makeKnowledge());
    expect(result.scope).toBe("knowledge");
    expect(result.sourceKind).toBe("knowledge");
    expect(result.category).toBe("context");
    expect(result.tags).toContain("scope:repo");
    expect(result.tags).toContain("source-key:context:architecture-overview");
  });

  it("maps notes to runbook-style knowledge with code refs", () => {
    const result = mapNoteToArticle(makeNote());
    expect(result.scope).toBe("knowledge");
    expect(result.sourceKind).toBe("note");
    expect(result.title).toBe("Post-Commit Agora Maintenance");
    expect(result.codeRefs).toEqual(["src/index.ts"]);
    expect(result.tags).toContain("topic:maintenance");
  });
});

// ---------------------------------------------------------------------------
// computeMigrationHash
// ---------------------------------------------------------------------------

describe("computeMigrationHash", () => {
  it("produces a deterministic hex hash", () => {
    const hash1 = computeMigrationHash("T-1001");
    const hash2 = computeMigrationHash("T-1001");
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different IDs", () => {
    expect(computeMigrationHash("T-1001")).not.toBe(computeMigrationHash("T-1002"));
  });
});
