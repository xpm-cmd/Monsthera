import { describe, it, expect } from "vitest";
import { withSemanticEnabled } from "../../../src/cli/self-commands.js";

describe("withSemanticEnabled", () => {
  it("sets search.semanticEnabled=true on an empty config", () => {
    expect(withSemanticEnabled({})).toEqual({ search: { semanticEnabled: true } });
  });

  it("preserves existing search fields and other top-level keys", () => {
    const input = { repoPath: "/x", search: { alpha: 0.5, bm25K1: 2, semanticEnabled: false } };
    expect(withSemanticEnabled(input)).toEqual({
      repoPath: "/x",
      search: { alpha: 0.5, bm25K1: 2, semanticEnabled: true },
    });
  });

  it("replaces a non-object `search` value defensively", () => {
    expect(withSemanticEnabled({ search: "oops" })).toEqual({ search: { semanticEnabled: true } });
  });

  it("does not mutate the input", () => {
    const input = { search: { semanticEnabled: false } };
    withSemanticEnabled(input);
    expect(input).toEqual({ search: { semanticEnabled: false } });
  });
});
