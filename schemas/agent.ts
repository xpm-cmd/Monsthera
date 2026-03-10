import { z } from "zod/v4";
import { TrustTier } from "./evidence-bundle.js";

export const RoleId = z.enum(["developer", "reviewer", "observer", "admin"]);
export type RoleId = z.infer<typeof RoleId>;

export const RolePermissions = z.object({
  allowedTools: z.array(z.string()),
  trustTier: TrustTier,
  canBroadcast: z.boolean(),
  canClaimFiles: z.boolean(),
  canProposePatch: z.boolean(),
  canProposeNote: z.boolean(),
  allowedNoteTypes: z.array(z.string()).default([]),
  readableNoteTypes: z.array(z.string()).default([]),
  canViewSharedLogs: z.boolean(),
  canCreateTicket: z.boolean(),
  canTransitionTicket: z.boolean(),
});
export type RolePermissions = z.infer<typeof RolePermissions>;

export const Role = z.object({
  id: RoleId,
  name: z.string(),
  description: z.string(),
  permissions: RolePermissions,
});
export type Role = z.infer<typeof Role>;

export const BUILT_IN_ROLES: Record<RoleId, Role> = {
  developer: {
    id: "developer",
    name: "Developer",
    description: "Full code access, can propose patches and notes",
    permissions: {
      allowedTools: [
        "get_code_pack", "get_change_pack", "get_issue_pack",
        "propose_patch", "propose_note", "claim_files",
        "status", "capabilities", "schema",
        "register_agent", "agent_status", "broadcast",
        "request_reindex",
        "store_knowledge", "search_knowledge", "query_knowledge", "archive_knowledge", "delete_knowledge",
        "create_ticket", "assign_ticket", "update_ticket_status", "update_ticket",
        "list_tickets", "get_ticket", "comment_ticket",
      ],
      trustTier: "A",
      canBroadcast: true,
      canClaimFiles: true,
      canProposePatch: true,
      canProposeNote: true,
      allowedNoteTypes: ["issue", "decision", "change_note", "gotcha", "runbook", "repo_map", "module_map", "file_summary"],
      readableNoteTypes: ["issue", "decision", "change_note", "gotcha", "runbook", "repo_map", "module_map", "file_summary"],
      canViewSharedLogs: true,
      canCreateTicket: true,
      canTransitionTicket: true,
    },
  },
  reviewer: {
    id: "reviewer",
    name: "Reviewer",
    description: "Can review code and changes, propose notes but not patches",
    permissions: {
      allowedTools: [
        "get_code_pack", "get_change_pack", "get_issue_pack",
        "propose_note",
        "status", "capabilities", "schema",
        "register_agent", "agent_status",
        "store_knowledge", "search_knowledge", "query_knowledge",
        "create_ticket", "update_ticket_status",
        "list_tickets", "get_ticket", "comment_ticket",
      ],
      trustTier: "A",
      canBroadcast: true,
      canClaimFiles: false,
      canProposePatch: false,
      canProposeNote: true,
      allowedNoteTypes: ["issue", "decision", "change_note", "gotcha"],
      readableNoteTypes: ["issue", "decision", "change_note", "gotcha", "runbook", "repo_map", "module_map", "file_summary"],
      canViewSharedLogs: true,
      canCreateTicket: true,
      canTransitionTicket: true,
    },
  },
  observer: {
    id: "observer",
    name: "Observer",
    description: "Read-only access to code context",
    permissions: {
      allowedTools: [
        "get_code_pack", "get_change_pack", "get_issue_pack",
        "status", "capabilities", "schema",
        "register_agent", "agent_status",
        "search_knowledge", "query_knowledge",
        "list_tickets", "get_ticket",
      ],
      trustTier: "B",
      canBroadcast: false,
      canClaimFiles: false,
      canProposePatch: false,
      canProposeNote: false,
      allowedNoteTypes: [],
      readableNoteTypes: ["issue", "decision", "change_note"],
      canViewSharedLogs: false,
      canCreateTicket: false,
      canTransitionTicket: false,
    },
  },
  admin: {
    id: "admin",
    name: "Admin",
    description: "Full access to all tools and agent management",
    permissions: {
      allowedTools: ["*"],
      trustTier: "A",
      canBroadcast: true,
      canClaimFiles: true,
      canProposePatch: true,
      canProposeNote: true,
      allowedNoteTypes: ["issue", "decision", "change_note", "gotcha", "runbook", "repo_map", "module_map", "file_summary"],
      readableNoteTypes: ["issue", "decision", "change_note", "gotcha", "runbook", "repo_map", "module_map", "file_summary"],
      canViewSharedLogs: true,
      canCreateTicket: true,
      canTransitionTicket: true,
    },
  },
};

export const SessionState = z.enum(["active", "inactive", "disconnected"]);
export type SessionState = z.infer<typeof SessionState>;

export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().default("unknown"), // e.g., "claude-code", "codex", "opencode"
  roleId: RoleId,
  trustTier: TrustTier,
  registeredAt: z.string().datetime(),
});
export type Agent = z.infer<typeof Agent>;

export const AgentSession = z.object({
  id: z.string(),
  agentId: z.string(),
  state: SessionState,
  connectedAt: z.string().datetime(),
  lastActivity: z.string().datetime(),
  claimedFiles: z.array(z.string()).default([]),
});
export type AgentSession = z.infer<typeof AgentSession>;

export const RegisterAgentInput = z.object({
  name: z.string().min(1).max(100),
  type: z.string().max(50).default("unknown"),
  desiredRole: RoleId.default("observer"),
});
export type RegisterAgentInput = z.infer<typeof RegisterAgentInput>;
