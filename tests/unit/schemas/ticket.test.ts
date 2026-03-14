import { describe, it, expect } from "vitest";
import {
  TicketStatus, TicketSeverity, CreateTicketInput,
  VALID_TRANSITIONS, TRANSITION_ROLES,
} from "../../../schemas/ticket.js";
import { MAX_TICKET_LONG_TEXT_LENGTH } from "../../../src/core/input-hardening.js";

describe("TicketStatus", () => {
  it("accepts all valid statuses", () => {
    for (const s of ["backlog", "technical_analysis", "approved", "in_progress", "in_review", "ready_for_commit", "blocked", "resolved", "closed", "wont_fix"]) {
      expect(TicketStatus.parse(s)).toBe(s);
    }
  });

  it("rejects invalid status", () => {
    expect(() => TicketStatus.parse("invalid")).toThrow();
  });
});

describe("TicketSeverity", () => {
  it("accepts all valid severities", () => {
    for (const s of ["critical", "high", "medium", "low"]) {
      expect(TicketSeverity.parse(s)).toBe(s);
    }
  });

  it("rejects invalid severity", () => {
    expect(() => TicketSeverity.parse("urgent")).toThrow();
  });
});

describe("CreateTicketInput", () => {
  it("accepts valid input with defaults", () => {
    const result = CreateTicketInput.parse({ title: "Bug", description: "Something broke" });
    expect(result.severity).toBe("medium");
    expect(result.priority).toBe(5);
    expect(result.tags).toEqual([]);
    expect(result.affectedPaths).toEqual([]);
  });

  it("rejects empty title", () => {
    expect(() => CreateTicketInput.parse({ title: "", description: "x" })).toThrow();
  });

  it("rejects priority out of range", () => {
    expect(() => CreateTicketInput.parse({ title: "t", description: "d", priority: 11 })).toThrow();
  });

  it("accepts acceptanceCriteria up to the shared long-text limit", () => {
    const text = "x".repeat(MAX_TICKET_LONG_TEXT_LENGTH);
    expect(CreateTicketInput.parse({ title: "Bug", description: "Something broke", acceptanceCriteria: text }).acceptanceCriteria).toBe(text);
  });

  it("rejects acceptanceCriteria above the shared long-text limit", () => {
    const text = "x".repeat(MAX_TICKET_LONG_TEXT_LENGTH + 1);
    expect(() => CreateTicketInput.parse({ title: "Bug", description: "Something broke", acceptanceCriteria: text })).toThrow();
  });
});

describe("VALID_TRANSITIONS", () => {
  it("has entries for all statuses", () => {
    const allStatuses = TicketStatus.options;
    for (const s of allStatuses) {
      expect(VALID_TRANSITIONS).toHaveProperty(s);
    }
  });

  it("done states keep explicit recovery and closure paths", () => {
    expect(VALID_TRANSITIONS.resolved).toContain("closed");
    expect(VALID_TRANSITIONS.resolved).toContain("in_progress");
    expect(VALID_TRANSITIONS.closed).toContain("backlog");
    expect(VALID_TRANSITIONS.wont_fix).toContain("backlog");
  });

  it("backlog can go to technical_analysis or wont_fix", () => {
    expect(VALID_TRANSITIONS.backlog).toContain("technical_analysis");
    expect(VALID_TRANSITIONS.backlog).toContain("wont_fix");
    expect(VALID_TRANSITIONS.backlog).not.toContain("in_progress");
  });

  it("includes the agreed recovery and non-implementation transitions", () => {
    expect(VALID_TRANSITIONS.technical_analysis).toContain("resolved");
    expect(VALID_TRANSITIONS.approved).toContain("technical_analysis");
    expect(VALID_TRANSITIONS.approved).toContain("in_review");
    expect(VALID_TRANSITIONS.in_progress).toContain("approved");
    expect(VALID_TRANSITIONS.blocked).toContain("wont_fix");
    expect(VALID_TRANSITIONS.closed).toContain("backlog");
    expect(VALID_TRANSITIONS.wont_fix).toContain("backlog");
    expect(VALID_TRANSITIONS.in_progress).not.toContain("ready_for_commit");
  });
});

describe("TRANSITION_ROLES", () => {
  it("has admin in every transition", () => {
    for (const roles of Object.values(TRANSITION_ROLES)) {
      expect(roles).toContain("admin");
    }
  });

  it("assigns the agreed advisory roles for the new transitions", () => {
    expect(TRANSITION_ROLES["technical_analysis→resolved"]).toEqual(["reviewer", "facilitator", "admin"]);
    expect(TRANSITION_ROLES["approved→technical_analysis"]).toEqual(["reviewer", "facilitator", "admin"]);
    expect(TRANSITION_ROLES["approved→in_review"]).toEqual(["developer", "admin"]);
    expect(TRANSITION_ROLES["in_progress→approved"]).toEqual(["reviewer", "facilitator", "admin"]);
    expect(TRANSITION_ROLES["blocked→wont_fix"]).toEqual(["reviewer", "facilitator", "admin"]);
    expect(TRANSITION_ROLES["closed→backlog"]).toEqual(["admin"]);
    expect(TRANSITION_ROLES["wont_fix→backlog"]).toEqual(["admin"]);
  });

  it("includes facilitator in TA governance transitions", () => {
    expect(TRANSITION_ROLES["backlog→technical_analysis"]).toContain("facilitator");
    expect(TRANSITION_ROLES["technical_analysis→approved"]).toContain("facilitator");
    expect(TRANSITION_ROLES["technical_analysis→resolved"]).toContain("facilitator");
    expect(TRANSITION_ROLES["in_review→ready_for_commit"]).toContain("facilitator");
    expect(TRANSITION_ROLES["ready_for_commit→resolved"]).toContain("facilitator");
    expect(TRANSITION_ROLES["resolved→closed"]).toContain("facilitator");
  });
});
