import { describe, it, expect } from "vitest";
import {
  TicketStatus, TicketSeverity, CreateTicketInput,
  VALID_TRANSITIONS, TRANSITION_ROLES,
} from "../../../schemas/ticket.js";

describe("TicketStatus", () => {
  it("accepts all valid statuses", () => {
    for (const s of ["backlog", "assigned", "in_progress", "in_review", "blocked", "resolved", "closed", "wont_fix"]) {
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
});

describe("VALID_TRANSITIONS", () => {
  it("has entries for all statuses", () => {
    const allStatuses = TicketStatus.options;
    for (const s of allStatuses) {
      expect(VALID_TRANSITIONS).toHaveProperty(s);
    }
  });

  it("terminal states have no transitions", () => {
    expect(VALID_TRANSITIONS.closed).toEqual([]);
    expect(VALID_TRANSITIONS.wont_fix).toEqual([]);
  });

  it("backlog can go to assigned or wont_fix", () => {
    expect(VALID_TRANSITIONS.backlog).toContain("assigned");
    expect(VALID_TRANSITIONS.backlog).toContain("wont_fix");
    expect(VALID_TRANSITIONS.backlog).not.toContain("in_progress");
  });
});

describe("TRANSITION_ROLES", () => {
  it("has admin in every transition", () => {
    for (const roles of Object.values(TRANSITION_ROLES)) {
      expect(roles).toContain("admin");
    }
  });
});
