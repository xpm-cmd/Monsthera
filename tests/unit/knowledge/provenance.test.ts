import { describe, it, expect } from "vitest";
import {
  ORIGIN,
  ORIGIN_VALUES,
  DEFAULT_ORIGIN,
  ORIGIN_FRONTMATTER_KEY,
  isOrigin,
  resolveOrigin,
  summarizeProvenance,
} from "../../../src/knowledge/provenance.js";

// PR-13: provenance. `origin` is stored in the free-form extraFrontmatter bag
// (ADR-020) and resolved to a known enum at read-time. The default (`agent`) is
// NOT written to disk — only non-default origins are persisted — so the resolver
// must collapse missing/unknown values to the default.
describe("provenance origin contract (PR-13)", () => {
  it("enumerates exactly agent | human | distilled | ingested", () => {
    expect([...ORIGIN_VALUES]).toEqual(["agent", "human", "distilled", "ingested"]);
  });

  it("exposes named constants that match the enum values", () => {
    expect(ORIGIN.AGENT).toBe("agent");
    expect(ORIGIN.HUMAN).toBe("human");
    expect(ORIGIN.DISTILLED).toBe("distilled");
    expect(ORIGIN.INGESTED).toBe("ingested");
  });

  it("defaults to agent and stores under the `origin` key", () => {
    expect(DEFAULT_ORIGIN).toBe("agent");
    expect(ORIGIN_FRONTMATTER_KEY).toBe("origin");
  });

  describe("isOrigin", () => {
    it("accepts every known enum value", () => {
      for (const value of ORIGIN_VALUES) expect(isOrigin(value)).toBe(true);
    });

    it("rejects unknown strings and non-strings", () => {
      expect(isOrigin("robot")).toBe(false);
      expect(isOrigin("Agent")).toBe(false); // case-sensitive
      expect(isOrigin(123)).toBe(false);
      expect(isOrigin(undefined)).toBe(false);
      expect(isOrigin(null)).toBe(false);
      expect(isOrigin({ origin: "agent" })).toBe(false);
    });
  });

  describe("resolveOrigin", () => {
    it("returns the stored origin when it is a known value", () => {
      expect(resolveOrigin({ extraFrontmatter: { origin: "distilled" } })).toBe("distilled");
      expect(resolveOrigin({ extraFrontmatter: { origin: "human" } })).toBe("human");
      expect(resolveOrigin({ extraFrontmatter: { origin: "ingested" } })).toBe("ingested");
    });

    it("defaults to agent when no provenance is recorded", () => {
      expect(resolveOrigin({})).toBe("agent");
      expect(resolveOrigin({ extraFrontmatter: {} })).toBe("agent");
      expect(resolveOrigin({ extraFrontmatter: { ticket: "ABC-123" } })).toBe("agent");
    });

    it("collapses unrecognized or non-string origins to the default", () => {
      expect(resolveOrigin({ extraFrontmatter: { origin: "robot" } })).toBe("agent");
      expect(resolveOrigin({ extraFrontmatter: { origin: 123 } })).toBe("agent");
      expect(resolveOrigin({ extraFrontmatter: { origin: null } })).toBe("agent");
    });
  });

  describe("summarizeProvenance", () => {
    it("returns all-zero counts and no unrecognized values for an empty corpus", () => {
      const summary = summarizeProvenance([]);
      expect(summary.counts).toEqual({ agent: 0, human: 0, distilled: 0, ingested: 0 });
      expect(summary.unrecognized).toEqual({ count: 0, values: [] });
    });

    it("counts known origins and treats missing/null provenance as agent", () => {
      const summary = summarizeProvenance([
        {}, // no extraFrontmatter -> agent
        { extraFrontmatter: { origin: "agent" } },
        { extraFrontmatter: { origin: null } }, // explicit empty -> agent
        { extraFrontmatter: { origin: "human" } },
        { extraFrontmatter: { origin: "distilled" } },
        { extraFrontmatter: { origin: "ingested" } },
      ]);
      expect(summary.counts).toEqual({ agent: 3, human: 1, distilled: 1, ingested: 1 });
      expect(summary.unrecognized.count).toBe(0);
    });

    it("surfaces present-but-unrecognized origins as distinct, sorted values", () => {
      const summary = summarizeProvenance([
        { extraFrontmatter: { origin: "robot" } },
        { extraFrontmatter: { origin: "robot" } }, // duplicate value, counted twice
        { extraFrontmatter: { origin: "alien" } },
        { extraFrontmatter: { origin: 123 } }, // non-string still surfaces
      ]);
      expect(summary.counts).toEqual({ agent: 0, human: 0, distilled: 0, ingested: 0 });
      expect(summary.unrecognized.count).toBe(4);
      expect(summary.unrecognized.values).toEqual(["123", "alien", "robot"]);
    });
  });
});
