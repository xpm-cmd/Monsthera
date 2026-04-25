import { describe, it, expect } from "vitest";
import { computePlanningHash, extractPlanningSection } from "../../../src/work/planning-hash.js";

describe("computePlanningHash", () => {
  it("returns null when the body has no `## Planning` heading", () => {
    expect(computePlanningHash("# Title\n\nNo planning here.")).toBeNull();
    expect(computePlanningHash("")).toBeNull();
  });

  it("hashes the planning section only, stopping at the next `## ` heading", () => {
    const body = [
      "# Article",
      "",
      "## Planning",
      "Plan body line 1",
      "Plan body line 2",
      "",
      "## Implementation",
      "Should NOT be in hash",
    ].join("\n");

    const hash = computePlanningHash(body);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    const swapped = body.replace("Should NOT be in hash", "Different downstream content");
    expect(computePlanningHash(swapped)).toBe(hash);
  });

  it("is sensitive to internal whitespace and content changes", () => {
    const a = "## Planning\nLine A\n\n## Next\n";
    const b = "## Planning\nLine B\n\n## Next\n";
    expect(computePlanningHash(a)).not.toBe(computePlanningHash(b));
  });

  it("treats trailing-blank-line variation as no-op via trim()", () => {
    const a = "## Planning\nContent\n";
    const b = "## Planning\nContent\n\n\n";
    expect(computePlanningHash(a)).toBe(computePlanningHash(b));
  });

  it("captures the section content up to EOF when no follow-up heading exists", () => {
    expect(extractPlanningSection("## Planning\nbody")).toBe("body");
  });
});
