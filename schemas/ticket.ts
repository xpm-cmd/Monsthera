import { z } from "zod/v4";

// --- Enums ---

export const TicketStatus = z.enum([
  "backlog", "technical_analysis", "approved", "in_progress", "in_review", "ready_for_commit",
  "blocked", "resolved", "closed", "wont_fix",
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const TicketSeverity = z.enum(["critical", "high", "medium", "low"]);
export type TicketSeverity = z.infer<typeof TicketSeverity>;

// --- State Machine ---

/**
 * Legal status transitions. Each key maps to the set of statuses it can transition TO.
 *
 * Canonical implementation path:
 * backlog → technical_analysis → approved → in_progress → in_review → ready_for_commit → resolved → closed
 *
 * Non-implementation or planning-only tickets may finish earlier through:
 * backlog → technical_analysis → resolved
 * backlog → technical_analysis → approved → in_review
 */
export const VALID_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  backlog:            ["technical_analysis", "wont_fix"],
  technical_analysis: ["backlog", "approved", "resolved", "wont_fix"],
  approved:           ["in_progress", "in_review", "backlog", "wont_fix"],
  in_progress:        ["in_review", "blocked", "wont_fix"],
  in_review:          ["in_progress", "ready_for_commit"],  // reject → in_progress
  ready_for_commit:   ["in_progress", "resolved"],          // late fix or post-commit resolution
  blocked:            ["in_progress", "wont_fix"],          // unblock or abandon
  resolved:           ["in_progress", "closed"],     // reopen → in_progress
  closed:             ["backlog"],
  wont_fix:           ["backlog"],
};

/**
 * Which roles can trigger each transition (advisory — not enforced in Stage 1).
 * "*" means any role. Specific roles listed mean only those roles should trigger it.
 */
export const TRANSITION_ROLES: Record<string, readonly string[]> = {
  "backlog→technical_analysis": ["reviewer", "facilitator", "admin"],
  "backlog→wont_fix":       ["reviewer", "facilitator", "admin"],
  "technical_analysis→backlog": ["reviewer", "facilitator", "admin"],
  "technical_analysis→approved": ["reviewer", "facilitator", "admin"],
  "technical_analysis→resolved": ["reviewer", "facilitator", "admin"],
  "technical_analysis→wont_fix": ["reviewer", "facilitator", "admin"],
  "approved→in_progress":   ["developer", "admin"],
  "approved→in_review":     ["developer", "admin"],
  "approved→backlog":       ["reviewer", "facilitator", "admin"],       // rework
  "approved→wont_fix":      ["reviewer", "facilitator", "admin"],
  "in_progress→in_review":  ["developer", "admin"],
  "in_progress→blocked":    ["developer", "admin"],
  "in_progress→wont_fix":   ["reviewer", "facilitator", "admin"],
  "in_review→in_progress":  ["reviewer", "facilitator", "admin"],     // reject
  "in_review→ready_for_commit": ["reviewer", "facilitator", "admin"],
  "ready_for_commit→in_progress": ["developer", "reviewer", "facilitator", "admin"],
  "ready_for_commit→resolved": ["developer", "facilitator", "admin"],
  "blocked→in_progress":    ["developer", "admin"],     // unblock
  "blocked→wont_fix":       ["reviewer", "facilitator", "admin"],
  "resolved→in_progress":   ["developer", "reviewer", "facilitator", "admin"],  // reopen
  "resolved→closed":        ["reviewer", "facilitator", "admin"],
  "closed→backlog":         ["admin"],
  "wont_fix→backlog":       ["admin"],
};

// --- Input/Output Schemas ---

export const CreateTicketInput = z.object({
  title: z.string().min(1).max(200).describe("Ticket title"),
  description: z.string().min(1).max(5000).describe("Ticket description"),
  severity: TicketSeverity.default("medium").describe("Severity level"),
  priority: z.number().int().min(0).max(10).default(5).describe("Priority 0-10, higher = more urgent"),
  tags: z.array(z.string()).default([]).describe("Tags for filtering"),
  affectedPaths: z.array(z.string()).default([]).describe("File paths affected"),
  acceptanceCriteria: z.string().max(2000).optional().describe("Criteria for resolution"),
});
export type CreateTicketInput = z.infer<typeof CreateTicketInput>;

export const Ticket = z.object({
  id: z.number(),
  repoId: z.number(),
  ticketId: z.string(),            // TKT-{uuid8}
  title: z.string(),
  description: z.string(),
  status: TicketStatus,
  severity: TicketSeverity,
  priority: z.number().int(),
  tagsJson: z.string().nullable(),
  affectedPathsJson: z.string().nullable(),
  acceptanceCriteria: z.string().nullable(),
  creatorAgentId: z.string(),
  creatorSessionId: z.string(),
  assigneeAgentId: z.string().nullable(),
  resolvedByAgentId: z.string().nullable(),
  commitSha: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof Ticket>;

export const TicketHistoryEntry = z.object({
  id: z.number(),
  ticketId: z.number(),           // FK → tickets.id (internal)
  fromStatus: TicketStatus.nullable(),
  toStatus: TicketStatus,
  agentId: z.string(),
  sessionId: z.string(),
  comment: z.string().nullable(),
  timestamp: z.string(),
});
export type TicketHistoryEntry = z.infer<typeof TicketHistoryEntry>;

export const TicketComment = z.object({
  id: z.number(),
  ticketId: z.number(),           // FK → tickets.id (internal)
  agentId: z.string(),
  sessionId: z.string(),
  content: z.string(),
  createdAt: z.string(),
});
export type TicketComment = z.infer<typeof TicketComment>;
