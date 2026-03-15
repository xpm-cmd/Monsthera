import { describe, expect, it } from "vitest";
import {
  validateDescriptor,
  validateBatch,
  type AntiBasuraContext,
} from "../../../src/simulation/anti-basura.js";
import type { TicketDescriptor, PlanningEvidence } from "../../../src/simulation/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanningEvidence(overrides?: Partial<PlanningEvidence>): PlanningEvidence {
  return {
    summary: "Refactor target function to reduce complexity.",
    approach: "Extract logic, simplify control flow.",
    affectedAreas: ["src/example.ts"],
    riskAssessment: "Low — scoped to single function with existing tests.",
    testPlan: "Run existing test suite. Verify no regressions.",
    ...overrides,
  };
}

function makeDescriptor(overrides?: Partial<TicketDescriptor>): TicketDescriptor {
  return {
    corpusId: "corpus-0001",
    title: "Reduce complexity in src/example.ts",
    description: "Auto-detected: high complexity in `src/example.ts`. Needs refactoring to simplify control flow.",
    affectedPaths: ["src/example.ts"],
    tags: ["autoresearch"],
    severity: "medium",
    priority: 5,
    acceptanceCriteria: "All existing tests pass after changes. No new lint errors.",
    source: "auto_detected",
    atomicityLevel: "micro",
    suggestedModel: "haiku",
    estimatedLines: 30,
    planningEvidence: makePlanningEvidence(),
    ...overrides,
  };
}

function makeContext(overrides?: Partial<AntiBasuraContext>): AntiBasuraContext {
  return {
    // Use a path that won't match file existence checks — we test file_not_found explicitly
    repoPath: "/tmp/nonexistent-repo-for-tests",
    existingTitles: [],
    corpusTitles: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("anti-basura validation", () => {
  describe("Gate 1: File existence", () => {
    it("rejects when affectedPaths point to nonexistent files", async () => {
      const descriptor = makeDescriptor({
        affectedPaths: ["src/does-not-exist.ts"],
      });
      const ctx = makeContext();
      const result = await validateDescriptor(descriptor, ctx);

      expect(result.valid).toBe(false);
      expect(result.rejections).toContainEqual(
        expect.objectContaining({ reason: "file_not_found" }),
      );
    });

    it("skips test file paths in existence checks", async () => {
      const descriptor = makeDescriptor({
        affectedPaths: ["src/example.test.ts"],
      });
      const ctx = makeContext();
      const result = await validateDescriptor(descriptor, ctx);

      // Should not have file_not_found for .test. files
      const fileErrors = result.rejections.filter((r) => r.reason === "file_not_found");
      expect(fileErrors).toHaveLength(0);
    });
  });

  describe("Gate 2: Deduplication", () => {
    it("rejects when title is too similar to an existing ticket", async () => {
      const descriptor = makeDescriptor({
        title: "Reduce complexity in src/example.ts",
      });
      const ctx = makeContext({
        existingTitles: ["Reduce complexity in src/example.ts"],
      });
      const result = await validateDescriptor(descriptor, ctx);

      expect(result.valid).toBe(false);
      expect(result.rejections).toContainEqual(
        expect.objectContaining({ reason: "duplicate" }),
      );
    });

    it("passes when title is sufficiently different", async () => {
      const descriptor = makeDescriptor({
        title: "Add unit tests for parser module",
      });
      const ctx = makeContext({
        existingTitles: ["Reduce complexity in src/example.ts"],
      });
      const result = await validateDescriptor(descriptor, ctx);

      const dupErrors = result.rejections.filter((r) => r.reason === "duplicate");
      expect(dupErrors).toHaveLength(0);
    });

    it("detects intra-batch duplicates via corpusTitles", async () => {
      const descriptor = makeDescriptor({
        title: "Reduce complexity in src/example.ts",
      });
      const ctx = makeContext({
        corpusTitles: ["Reduce complexity in src/example.ts"],
      });
      const result = await validateDescriptor(descriptor, ctx);

      expect(result.rejections).toContainEqual(
        expect.objectContaining({ reason: "duplicate" }),
      );
    });
  });

  describe("Gate 3: Actionability", () => {
    it("rejects non-imperative titles", async () => {
      const descriptor = makeDescriptor({
        title: "The complexity in src/example.ts is too high",
      });
      const ctx = makeContext();
      const result = await validateDescriptor(descriptor, ctx);

      expect(result.rejections).toContainEqual(
        expect.objectContaining({ reason: "not_actionable" }),
      );
    });

    it("accepts imperative titles", async () => {
      for (const verb of ["Add", "Fix", "Reduce", "Refactor", "Split"]) {
        const descriptor = makeDescriptor({
          title: `${verb} something in src/unique-${verb}.ts`,
        });
        const ctx = makeContext();
        const result = await validateDescriptor(descriptor, ctx);

        const actionErrors = result.rejections.filter((r) => r.reason === "not_actionable");
        expect(actionErrors).toHaveLength(0);
      }
    });

    it("rejects empty descriptions", async () => {
      const descriptor = makeDescriptor({
        description: "short",
      });
      const ctx = makeContext();
      const result = await validateDescriptor(descriptor, ctx);

      expect(result.rejections).toContainEqual(
        expect.objectContaining({
          reason: "not_actionable",
          message: expect.stringContaining("Description must be at least"),
        }),
      );
    });
  });

  describe("Gate 4: Size check", () => {
    it("rejects micro tickets over 50 estimated lines", async () => {
      const descriptor = makeDescriptor({
        atomicityLevel: "micro",
        estimatedLines: 80,
      });
      const ctx = makeContext();
      const result = await validateDescriptor(descriptor, ctx);

      expect(result.rejections).toContainEqual(
        expect.objectContaining({ reason: "too_large" }),
      );
    });

    it("rejects any ticket over 150 estimated lines", async () => {
      const descriptor = makeDescriptor({
        atomicityLevel: "small",
        estimatedLines: 200,
      });
      const ctx = makeContext();
      const result = await validateDescriptor(descriptor, ctx);

      expect(result.rejections).toContainEqual(
        expect.objectContaining({ reason: "too_large" }),
      );
    });

    it("passes small tickets within 150 lines", async () => {
      const descriptor = makeDescriptor({
        atomicityLevel: "small",
        estimatedLines: 100,
      });
      const ctx = makeContext();
      const result = await validateDescriptor(descriptor, ctx);

      const sizeErrors = result.rejections.filter((r) => r.reason === "too_large");
      expect(sizeErrors).toHaveLength(0);
    });
  });

  describe("Gate 5: Test plan", () => {
    it("rejects missing acceptance criteria", async () => {
      const descriptor = makeDescriptor({
        acceptanceCriteria: "",
      });
      const ctx = makeContext();
      const result = await validateDescriptor(descriptor, ctx);

      expect(result.rejections).toContainEqual(
        expect.objectContaining({ reason: "missing_test_plan" }),
      );
    });
  });

  describe("Gate 6: Planning evidence", () => {
    it("rejects when planning evidence fields are empty", async () => {
      const descriptor = makeDescriptor({
        planningEvidence: makePlanningEvidence({ summary: "" }),
      });
      const ctx = makeContext();
      const result = await validateDescriptor(descriptor, ctx);

      expect(result.rejections).toContainEqual(
        expect.objectContaining({ reason: "missing_planning_evidence" }),
      );
    });

    it("rejects when affectedAreas is empty array", async () => {
      const descriptor = makeDescriptor({
        planningEvidence: makePlanningEvidence({ affectedAreas: [] }),
      });
      const ctx = makeContext();
      const result = await validateDescriptor(descriptor, ctx);

      expect(result.rejections).toContainEqual(
        expect.objectContaining({ reason: "missing_planning_evidence" }),
      );
    });
  });

  describe("Batch validation", () => {
    it("separates valid and rejected descriptors", async () => {
      const valid1 = makeDescriptor({
        corpusId: "c-1",
        title: "Add tests for parser module",
        affectedPaths: ["src/example.test.ts"], // test files skip existence check
      });
      const invalid = makeDescriptor({
        corpusId: "c-2",
        title: "The complexity is bad", // non-imperative
        affectedPaths: ["src/example.test.ts"],
      });
      const valid2 = makeDescriptor({
        corpusId: "c-3",
        title: "Fix error handling in bus module",
        affectedPaths: ["src/example.spec.ts"],
      });

      const ctx = makeContext();
      const result = await validateBatch([valid1, invalid, valid2], ctx);

      expect(result.valid).toHaveLength(2);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.descriptor.corpusId).toBe("c-2");
    });

    it("updates corpusTitles to prevent intra-batch duplicates", async () => {
      const d1 = makeDescriptor({
        corpusId: "c-1",
        title: "Add tests for parser module",
        affectedPaths: ["src/example.test.ts"],
      });
      const d2 = makeDescriptor({
        corpusId: "c-2",
        title: "Add tests for parser module", // exact duplicate
        affectedPaths: ["src/example.test.ts"],
      });

      const ctx = makeContext();
      const result = await validateBatch([d1, d2], ctx);

      expect(result.valid).toHaveLength(1);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.descriptor.corpusId).toBe("c-2");
      expect(result.rejected[0]!.result.rejections[0]!.reason).toBe("duplicate");
    });
  });

  describe("Multiple failures", () => {
    it("collects all failures, not just the first", async () => {
      const descriptor = makeDescriptor({
        title: "Bad title no verb",
        description: "short",
        acceptanceCriteria: "",
        planningEvidence: makePlanningEvidence({ summary: "" }),
        affectedPaths: ["src/nonexistent-file.ts"],
      });
      const ctx = makeContext();
      const result = await validateDescriptor(descriptor, ctx);

      expect(result.valid).toBe(false);
      // Should have at least: file_not_found, not_actionable (title + description), missing_test_plan, missing_planning_evidence
      expect(result.rejections.length).toBeGreaterThanOrEqual(4);
      const reasons = new Set(result.rejections.map((r) => r.reason));
      expect(reasons).toContain("file_not_found");
      expect(reasons).toContain("not_actionable");
      expect(reasons).toContain("missing_test_plan");
      expect(reasons).toContain("missing_planning_evidence");
    });
  });
});
