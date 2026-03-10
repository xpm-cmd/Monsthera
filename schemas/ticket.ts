import { z } from "zod/v4";

// --- Enums ---

export const TicketStatus = z.enum([
  "backlog", "assigned", "in_progress", "in_review",
  "blocked", "resolved", "closed", "wont_fix",
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const TicketSeverity = z.enum(["critical", "high", "medium", "low"]);
export type TicketSeverity = z.infer<typeof TicketSeverity>;

// --- State Machine ---

/** Legal status transitions. Each key maps to the set of statuses it can transition TO. */
export const VALID_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  backlog:     ["assigned", "wont_fix"],
  assigned:    ["in_progress", "wont_fix"],
  in_progress: ["in_review", "blocked", "wont_fix"],
  in_review:   ["in_progress", "resolved"],  // reject → in_progress
  blocked:     ["in_progress"],               // unblock
  resolved:    ["in_progress", "closed"],     // reopen → in_progress
  closed:      [],
  wont_fix:    [],
};

/**
 * Which roles can trigger each transition (advisory — not enforced in Stage 1).
 * "*" means any role. Specific roles listed mean only those roles should trigger it.
 */
export const TRANSITION_ROLES: Record<string, readonly string[]> = {
  "backlog→assigned":       ["developer", "admin"],
  "backlog→wont_fix":       ["reviewer", "admin"],
  "assigned→in_progress":   ["developer", "admin"],
  "assigned→wont_fix":      ["reviewer", "admin"],
  "in_progress→in_review":  ["developer", "admin"],
  "in_progress→blocked":    ["developer", "admin"],
  "in_progress→wont_fix":   ["reviewer", "admin"],
  "in_review→in_progress":  ["reviewer", "admin"],     // reject
  "in_review→resolved":     ["reviewer", "admin"],
  "blocked→in_progress":    ["developer", "admin"],     // unblock
  "resolved→in_progress":   ["developer", "reviewer", "admin"],  // reopen
  "resolved→closed":        ["reviewer", "admin"],
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
