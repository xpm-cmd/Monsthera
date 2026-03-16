import { describe, it, expect } from "vitest";
import {
  JOB_SLOT_TRANSITIONS,
  LOOP_TEMPLATES,
  LOOP_TEMPLATE_NAMES,
  JobSlotStatusSchema,
  JOB_SLOT_STATUSES,
} from "../../../schemas/job.js";

describe("JOB_SLOT_TRANSITIONS", () => {
  it("open can only go to claimed", () => {
    expect(JOB_SLOT_TRANSITIONS.open).toEqual(["claimed"]);
  });

  it("claimed can go to active, abandoned, open", () => {
    expect(JOB_SLOT_TRANSITIONS.claimed).toEqual(["active", "abandoned", "open"]);
  });

  it("active can go to active (heartbeat), completed, abandoned, open", () => {
    expect(JOB_SLOT_TRANSITIONS.active).toEqual(["active", "completed", "abandoned", "open"]);
  });

  it("completed is terminal (no transitions)", () => {
    expect(JOB_SLOT_TRANSITIONS.completed).toEqual([]);
  });

  it("abandoned can go to open", () => {
    expect(JOB_SLOT_TRANSITIONS.abandoned).toEqual(["open"]);
  });

  it("covers all statuses", () => {
    const keys = Object.keys(JOB_SLOT_TRANSITIONS).sort();
    expect(keys).toEqual([...JOB_SLOT_STATUSES].sort());
  });
});

describe("LOOP_TEMPLATES", () => {
  describe("full-team", () => {
    const template = LOOP_TEMPLATES["full-team"]!;

    it("has exactly 11 slots", () => {
      expect(template).toHaveLength(11);
    });

    it("has 1 facilitator, 2 planners, 2 developers, 6 reviewers", () => {
      const roles = template.map((s) => s.role);
      expect(roles.filter((r) => r === "facilitator")).toHaveLength(1);
      expect(roles.filter((r) => r === "planner")).toHaveLength(2);
      expect(roles.filter((r) => r === "developer")).toHaveLength(2);
      expect(roles.filter((r) => r === "reviewer")).toHaveLength(6);
    });

    it("reviewer slots have correct specializations", () => {
      const reviewerSpecs = template
        .filter((s) => s.role === "reviewer")
        .map((s) => s.specialization)
        .sort();
      expect(reviewerSpecs).toEqual(
        ["architect", "design", "patterns", "performance", "security", "simplifier"],
      );
    });
  });

  describe("full-team-unified-council", () => {
    const template = LOOP_TEMPLATES["full-team-unified-council"]!;

    it("has exactly 6 slots", () => {
      expect(template).toHaveLength(6);
    });

    it("has 1 facilitator, 2 planners, 2 developers, 1 full-council reviewer", () => {
      const roles = template.map((s) => s.role);
      expect(roles.filter((r) => r === "facilitator")).toHaveLength(1);
      expect(roles.filter((r) => r === "planner")).toHaveLength(2);
      expect(roles.filter((r) => r === "developer")).toHaveLength(2);
      expect(roles.filter((r) => r === "reviewer")).toHaveLength(1);
    });

    it("reviewer slot has full-council specialization", () => {
      const reviewer = template.find((s) => s.role === "reviewer");
      expect(reviewer?.specialization).toBe("full-council");
    });
  });

  describe("small-team", () => {
    const template = LOOP_TEMPLATES["small-team"]!;

    it("has exactly 4 slots", () => {
      expect(template).toHaveLength(4);
    });

    it("has 1 facilitator, 1 planner, 1 developer, 1 full-council reviewer", () => {
      const roles = template.map((s) => s.role);
      expect(roles.filter((r) => r === "facilitator")).toHaveLength(1);
      expect(roles.filter((r) => r === "planner")).toHaveLength(1);
      expect(roles.filter((r) => r === "developer")).toHaveLength(1);
      expect(roles.filter((r) => r === "reviewer")).toHaveLength(1);
    });

    it("reviewer slot has full-council specialization", () => {
      const reviewer = template.find((s) => s.role === "reviewer");
      expect(reviewer?.specialization).toBe("full-council");
    });
  });

  describe("all templates", () => {
    it("every slot has a non-empty systemPrompt", () => {
      for (const [name, slots] of Object.entries(LOOP_TEMPLATES)) {
        for (const slot of slots) {
          expect(slot.systemPrompt, `${name} / ${slot.label} systemPrompt`).toBeTruthy();
          expect(slot.systemPrompt.length, `${name} / ${slot.label} systemPrompt length`).toBeGreaterThan(0);
        }
      }
    });

    it("every slot has a non-empty label", () => {
      for (const [name, slots] of Object.entries(LOOP_TEMPLATES)) {
        for (const slot of slots) {
          expect(slot.label, `${name} / ${slot.role} label`).toBeTruthy();
          expect(slot.label.length, `${name} / ${slot.role} label length`).toBeGreaterThan(0);
        }
      }
    });
  });
});

describe("LOOP_TEMPLATE_NAMES", () => {
  it("contains all 3 template names", () => {
    expect(LOOP_TEMPLATE_NAMES).toHaveLength(3);
    expect(LOOP_TEMPLATE_NAMES).toContain("full-team");
    expect(LOOP_TEMPLATE_NAMES).toContain("full-team-unified-council");
    expect(LOOP_TEMPLATE_NAMES).toContain("small-team");
  });
});

describe("JobSlotStatusSchema", () => {
  it("accepts all valid statuses", () => {
    for (const s of JOB_SLOT_STATUSES) {
      expect(JobSlotStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects invalid status", () => {
    expect(() => JobSlotStatusSchema.parse("invalid")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => JobSlotStatusSchema.parse("")).toThrow();
  });

  it("rejects non-string values", () => {
    expect(() => JobSlotStatusSchema.parse(123)).toThrow();
    expect(() => JobSlotStatusSchema.parse(null)).toThrow();
    expect(() => JobSlotStatusSchema.parse(undefined)).toThrow();
  });
});
