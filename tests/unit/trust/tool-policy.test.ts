import { describe, expect, it } from "vitest";
import { CAPABILITY_TOOL_NAMES } from "../../../src/tools/tool-manifest.js";
import { TOOL_ACCESS_POLICY } from "../../../src/trust/tool-policy.js";
import { BUILT_IN_ROLES } from "../../../schemas/agent.js";

describe("tool access policy", () => {
  it("declares an access policy for every capability tool", () => {
    expect(Object.keys(TOOL_ACCESS_POLICY).sort()).toEqual([...CAPABILITY_TOOL_NAMES].sort());
  });

  it("facilitator cannot propose patches or claim files", () => {
    const perms = BUILT_IN_ROLES.facilitator.permissions;
    expect(perms.canProposePatch).toBe(false);
    expect(perms.canClaimFiles).toBe(false);
    expect(perms.allowedTools).not.toContain("propose_patch");
    expect(perms.allowedTools).not.toContain("claim_files");
  });

  it("facilitator can manage tickets and knowledge", () => {
    const tools = new Set(BUILT_IN_ROLES.facilitator.permissions.allowedTools);
    expect(tools.has("create_ticket")).toBe(true);
    expect(tools.has("update_ticket_status")).toBe(true);
    expect(tools.has("comment_ticket")).toBe(true);
    expect(tools.has("assign_council")).toBe(true);
    expect(tools.has("submit_verdict")).toBe(true);
    expect(tools.has("check_consensus")).toBe(true);
    expect(tools.has("store_knowledge")).toBe(true);
    expect(tools.has("broadcast")).toBe(true);
  });
});
