import { describe, it, expect } from "vitest";
import { matchesProtectedPattern } from "../../../src/patches/validator.js";

describe("matchesProtectedPattern", () => {
  it("matches exact path", () => {
    expect(matchesProtectedPattern("src/db/schema.ts", "src/db/schema.ts")).toBe(true);
  });

  it("rejects non-matching exact path", () => {
    expect(matchesProtectedPattern("src/db/queries.ts", "src/db/schema.ts")).toBe(false);
  });

  it("matches directory prefix with trailing slash", () => {
    expect(matchesProtectedPattern("src/db/schema.ts", "src/db/")).toBe(true);
    expect(matchesProtectedPattern("src/db/queries.ts", "src/db/")).toBe(true);
  });

  it("rejects non-matching directory prefix", () => {
    expect(matchesProtectedPattern("src/tools/foo.ts", "src/db/")).toBe(false);
  });

  it("matches trailing wildcard", () => {
    expect(matchesProtectedPattern("src/db/schema.ts", "src/db/*")).toBe(true);
    expect(matchesProtectedPattern("src/db/sub/deep.ts", "src/db/*")).toBe(true);
  });

  it("rejects non-matching wildcard", () => {
    expect(matchesProtectedPattern("src/tools/foo.ts", "src/db/*")).toBe(false);
  });

  it("matches root-level wildcard", () => {
    expect(matchesProtectedPattern(".agora/config.json", ".agora/*")).toBe(true);
  });

  it("rejects when no pattern matches", () => {
    expect(matchesProtectedPattern("lib/utils.ts", "src/db/schema.ts")).toBe(false);
    expect(matchesProtectedPattern("lib/utils.ts", "src/")).toBe(false);
    expect(matchesProtectedPattern("lib/utils.ts", "src/*")).toBe(false);
  });
});
