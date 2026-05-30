import { describe, it, expect } from "vitest";
import { isAffirmative } from "../../../src/cli/prompt.js";

describe("isAffirmative", () => {
  it("accepts y / yes case-insensitively, ignoring surrounding whitespace", () => {
    for (const answer of ["y", "Y", "yes", "YES", "Yes", "  y  ", " yes "]) {
      expect(isAffirmative(answer)).toBe(true);
    }
  });

  it("rejects everything else, including empty and near-misses", () => {
    for (const answer of ["", "n", "N", "no", "nope", "maybe", "yep", "yeah", "ok"]) {
      expect(isAffirmative(answer)).toBe(false);
    }
  });
});
