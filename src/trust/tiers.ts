import type { TrustTier } from "../../schemas/evidence-bundle.js";
import type { RoleId } from "../../schemas/agent.js";
import { BUILT_IN_ROLES } from "../../schemas/agent.js";

export interface AccessDecision {
  allowed: boolean;
  reason: string;
}

export function checkToolAccess(
  tool: string,
  roleId: RoleId,
  trustTier: TrustTier,
): AccessDecision {
  const role = BUILT_IN_ROLES[roleId];
  if (!role) {
    return { allowed: false, reason: `Unknown role: ${roleId}` };
  }

  const { permissions } = role;

  // Admin wildcard
  if (permissions.allowedTools.includes("*")) {
    return { allowed: true, reason: "admin" };
  }

  if (!permissions.allowedTools.includes(tool)) {
    return { allowed: false, reason: `Role ${roleId} does not have access to ${tool}` };
  }

  // Tier-specific restrictions
  if (tool === "propose_patch" && !permissions.canProposePatch) {
    return { allowed: false, reason: `Role ${roleId} cannot propose patches` };
  }

  if (tool === "propose_note" && !permissions.canProposeNote) {
    return { allowed: false, reason: `Role ${roleId} cannot propose notes` };
  }

  if (tool === "broadcast" && !permissions.canBroadcast) {
    return { allowed: false, reason: `Role ${roleId} cannot broadcast` };
  }

  if (tool === "claim_files" && !permissions.canClaimFiles) {
    return { allowed: false, reason: `Role ${roleId} cannot claim files` };
  }

  return { allowed: true, reason: "ok" };
}

export function canReadNoteType(roleId: RoleId, noteType: string): boolean {
  const role = BUILT_IN_ROLES[roleId];
  if (!role) return false;
  return role.permissions.readableNoteTypes.includes(noteType);
}

export function canWriteNoteType(roleId: RoleId, noteType: string): boolean {
  const role = BUILT_IN_ROLES[roleId];
  if (!role) return false;
  return role.permissions.allowedNoteTypes.includes(noteType);
}

export function getMaxCodeSpanLines(trustTier: TrustTier): number {
  return trustTier === "A" ? 200 : 0;
}
