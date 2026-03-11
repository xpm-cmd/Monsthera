import { describe, expect, it } from "vitest";
import {
  authorizeCrossInstanceTool,
  getCrossInstanceToolsForCapability,
  isCrossInstanceToolAllowed,
} from "../../../src/trust/cross-instance-policy.js";

describe("cross-instance capability policy", () => {
  const peer = {
    enabled: true,
    allowedCapabilities: ["read_code", "read_tickets"] as const,
  };

  it("allows tools covered by the peer capability set", () => {
    expect(isCrossInstanceToolAllowed(peer, "get_code_pack")).toBe(true);
    expect(isCrossInstanceToolAllowed(peer, "get_ticket")).toBe(true);
  });

  it("denies tools outside the peer capability set", () => {
    expect(authorizeCrossInstanceTool(peer, "search_knowledge")).toEqual({
      allowed: false,
      reason: "capability_not_allowed",
    });
  });

  it("denies all tools when the peer is disabled", () => {
    expect(authorizeCrossInstanceTool({
      enabled: false,
      allowedCapabilities: ["read_code"],
    }, "get_code_pack")).toEqual({
      allowed: false,
      reason: "peer_disabled",
    });
  });

  it("exposes the tool set for each capability", () => {
    expect(getCrossInstanceToolsForCapability("read_code")).toContain("lookup_dependencies");
    expect(getCrossInstanceToolsForCapability("read_tickets")).toContain("get_ticket");
  });
});
