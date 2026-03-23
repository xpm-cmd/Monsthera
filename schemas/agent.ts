import { z } from "zod/v4";
import { TrustTier } from "./evidence-bundle.js";

export const RoleId = z.enum(["developer", "reviewer", "facilitator", "planner", "observer", "admin"]);
export type RoleId = z.infer<typeof RoleId>;

export const AgentIdentitySource = z.enum(["self_declared", "config", "peer_asserted", "system_assigned"]);
export type AgentIdentitySource = z.infer<typeof AgentIdentitySource>;

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
        "run_workflow",
        "propose_patch", "propose_note", "claim_files",
        "status", "capabilities", "schema",
        "register_agent", "agent_status", "broadcast",
        "send_coordination", "poll_coordination", "list_patches", "list_notes",
        "request_reindex",
        "store_knowledge", "search_knowledge", "query_knowledge", "archive_knowledge", "delete_knowledge",
        "create_ticket", "assign_ticket", "update_ticket_status", "update_ticket",
        "list_tickets", "search_tickets", "get_ticket", "comment_ticket", "assign_council", "submit_verdict", "check_consensus", "list_verdicts",
        "link_tickets", "unlink_tickets", "prune_stale_relations",
        "lookup_dependencies", "export_audit",
        "list_protected_artifacts",
        "list_jobs", "claim_job", "update_job_progress", "complete_job", "release_job",
        "decompose_goal",
        "create_work_group", "update_work_group", "add_tickets_to_group", "remove_tickets_from_group", "list_work_groups",
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
        "run_workflow",
        "propose_note",
        "status", "capabilities", "schema",
        "register_agent", "agent_status", "broadcast",
        "send_coordination", "poll_coordination", "list_patches", "list_notes",
        "store_knowledge", "search_knowledge", "query_knowledge",
        "create_ticket", "update_ticket", "update_ticket_status",
        "list_tickets", "search_tickets", "get_ticket", "comment_ticket", "assign_council", "submit_verdict", "check_consensus", "list_verdicts",
        "link_tickets", "unlink_tickets",
        "lookup_dependencies", "export_audit",
        "list_protected_artifacts",
        "list_jobs", "claim_job", "update_job_progress", "complete_job", "release_job",
        "list_work_groups",
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
  planner: {
    id: "planner",
    name: "Planner",
    description: "Deep-dives into backlog tickets, refines requirements, discusses with other planners, and prepares tickets for council review",
    permissions: {
      allowedTools: [
        "get_code_pack", "get_change_pack", "get_issue_pack",
        "run_workflow",
        "propose_note",
        "status", "capabilities", "schema",
        "register_agent", "agent_status", "broadcast",
        "send_coordination", "poll_coordination", "list_patches", "list_notes",
        "store_knowledge", "search_knowledge", "query_knowledge",
        "create_ticket", "update_ticket", "update_ticket_status",
        "list_tickets", "search_tickets", "get_ticket", "comment_ticket",
        "link_tickets", "unlink_tickets", "prune_stale_relations",
        "analyze_complexity", "analyze_test_coverage",
        "decompose_goal",
        "lookup_dependencies", "trace_dependencies", "export_audit",
        "suggest_actions", "suggest_next_work",
        "create_loop", "list_jobs", "claim_job", "update_job_progress", "complete_job", "release_job",
        "create_work_group", "add_tickets_to_group", "list_work_groups",
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
        "run_workflow",
        "status", "capabilities", "schema",
        "register_agent", "agent_status",
        "search_knowledge", "query_knowledge",
        "list_tickets", "search_tickets", "get_ticket",
        "lookup_dependencies",
        "list_jobs",
        "list_work_groups",
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
  facilitator: {
    id: "facilitator",
    name: "Facilitator",
    description: "Drives discussion convergence, synthesizes positions, and advances ticket decisions",
    permissions: {
      allowedTools: [
        "get_code_pack", "get_change_pack", "get_issue_pack",
        "run_workflow",
        "propose_note",
        "status", "capabilities", "schema",
        "register_agent", "agent_status", "broadcast",
        "send_coordination", "poll_coordination", "list_patches", "list_notes",
        "store_knowledge", "search_knowledge", "query_knowledge", "archive_knowledge", "delete_knowledge",
        "create_ticket", "assign_ticket", "update_ticket_status", "update_ticket",
        "list_tickets", "search_tickets", "get_ticket", "comment_ticket", "assign_council", "submit_verdict", "check_consensus", "list_verdicts",
        "link_tickets", "unlink_tickets", "prune_stale_relations",
        "analyze_complexity", "analyze_test_coverage",
        "lookup_dependencies", "export_audit", "request_reindex",
        "list_protected_artifacts",
        "create_loop", "list_jobs", "claim_job", "update_job_progress", "complete_job", "release_job",
        "decompose_goal",
        "create_work_group", "update_work_group", "add_tickets_to_group", "remove_tickets_from_group", "list_work_groups",
        "spawn_agent",
        "compute_waves", "launch_convoy", "advance_wave", "get_wave_status",
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
  provider: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  modelFamily: z.string().nullable().default(null),
  modelVersion: z.string().nullable().default(null),
  identitySource: AgentIdentitySource.nullable().default(null),
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
  provider: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  modelFamily: z.string().trim().min(1).max(100).optional(),
  modelVersion: z.string().trim().min(1).max(100).optional(),
  identitySource: AgentIdentitySource.optional(),
  desiredRole: RoleId.default("observer"),
  authToken: z.string().min(1).max(200).optional(),
});
export type RegisterAgentInput = z.infer<typeof RegisterAgentInput>;
