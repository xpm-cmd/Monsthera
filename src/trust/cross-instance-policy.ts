import type { CrossInstanceCapability, CrossInstancePeer } from "../core/config.js";

export interface CrossInstancePolicyDecision {
  allowed: boolean;
  reason: string;
}

type CrossInstancePolicyPeer = Pick<CrossInstancePeer, "enabled"> & {
  allowedCapabilities: readonly CrossInstanceCapability[];
};

const CAPABILITY_TOOLS: Record<CrossInstanceCapability, readonly string[]> = {
  read_code: [
    "status",
    "capabilities",
    "schema",
    "get_code_pack",
    "get_change_pack",
    "get_issue_pack",
    "lookup_dependencies",
  ],
  read_knowledge: [
    "search_knowledge",
    "query_knowledge",
  ],
  read_tickets: [
    "list_tickets",
    "search_tickets",
    "get_ticket",
  ],
};

export function isCrossInstanceToolAllowed(
  peer: CrossInstancePolicyPeer,
  tool: string,
): boolean {
  return authorizeCrossInstanceTool(peer, tool).allowed;
}

export function authorizeCrossInstanceTool(
  peer: CrossInstancePolicyPeer,
  tool: string,
): CrossInstancePolicyDecision {
  if (!peer.enabled) {
    return { allowed: false, reason: "peer_disabled" };
  }

  const allowed = peer.allowedCapabilities.some((capability) =>
    CAPABILITY_TOOLS[capability]?.includes(tool),
  );

  return allowed
    ? { allowed: true, reason: "ok" }
    : { allowed: false, reason: "capability_not_allowed" };
}

export function getCrossInstanceToolsForCapability(capability: CrossInstanceCapability): readonly string[] {
  return CAPABILITY_TOOLS[capability];
}
