import { describe, expect, it } from "vitest";
import { CAPABILITY_TOOL_NAMES } from "../../../src/tools/tool-manifest.js";
import { TOOL_ACCESS_POLICY } from "../../../src/trust/tool-policy.js";

describe("tool access policy", () => {
  it("declares an access policy for every capability tool", () => {
    expect(Object.keys(TOOL_ACCESS_POLICY).sort()).toEqual([...CAPABILITY_TOOL_NAMES].sort());
  });
});
