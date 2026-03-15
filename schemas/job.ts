import { z } from "zod/v4";
import type { RoleId } from "./agent.js";

// ─── Job Slot Status Machine ────────────────────────────────────────

export const JOB_SLOT_STATUSES = ["open", "claimed", "active", "completed", "abandoned"] as const;
export type JobSlotStatus = (typeof JOB_SLOT_STATUSES)[number];

export const JobSlotStatusSchema = z.enum(JOB_SLOT_STATUSES);

export const JOB_SLOT_TRANSITIONS: Record<JobSlotStatus, readonly JobSlotStatus[]> = {
  open:      ["claimed"],
  claimed:   ["active", "abandoned", "open"],
  active:    ["completed", "abandoned", "open"],
  completed: [],
  abandoned: ["open"],
};

// ─── Job Context (injected to agent on claim) ───────────────────────

export interface JobContext {
  focusFiles?: string[];
  relatedTickets?: string[];
  goals?: string[];
  constraints?: string[];
  [key: string]: unknown;
}

// ─── Job Slot ───────────────────────────────────────────────────────

export interface JobSlot {
  id: number;
  repoId: number;
  slotId: string;
  loopId: string;
  role: RoleId;
  specialization: string | null;
  label: string;
  description: string | null;
  systemPrompt: string | null;
  contextJson: string | null;  // JSON-serialized JobContext
  ticketId: string | null;
  status: JobSlotStatus;
  agentId: string | null;
  sessionId: string | null;
  claimedAt: string | null;
  activeSince: string | null;
  completedAt: string | null;
  lastHeartbeat: string | null;
  progressNote: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Loop Template Slot Definition ──────────────────────────────────

export interface LoopTemplateSlot {
  role: RoleId;
  specialization?: string;
  label: string;
  systemPrompt: string;
  description?: string;
  contextJson?: JobContext;
}

// ─── Loop Templates ─────────────────────────────────────────────────

const FACILITATOR_PROMPT = `You are the Loop Facilitator.

## Priority 1: Coordination (always)
1. Monitor all agents: call list_jobs every 3 minutes
2. Ensure planners are refining backlog tickets with depth
3. When planners agree a ticket is ready, transition it to technical_analysis
4. Assign council members via assign_council for TA review
5. Resolve blockers — if an agent is stuck, coordinate via send_coordination
6. Track overall loop progress and report via update_job_progress

## Priority 2: Commit Queue (when no urgent coordination work)
When there are no blockers to resolve or agents to coordinate, process the
ready_for_commit queue. Commits MUST be serialized — one at a time:

1. list_tickets(status="ready_for_commit") to find the queue
2. If queue is empty: return to Priority 1. Do not idle.
3. lookup_dependencies for each ticket to build a dependency graph
4. Sort: dependencies first, then by priority
5. For each ticket:
   a. DEPENDENCY CHECK: if this ticket depends on one that failed or was
      sent back to in_review this cycle, skip it — send it to in_review too,
      comment explaining the failed dependency
   b. get_ticket to load details and affected paths
   c. list_patches to find the validated patch
      - No validated patch: comment_ticket, update_ticket_status to "in_review"
        so council can vote on it, next
      - Multiple patches: use the most recent (latest createdAt)
   d. Apply the patch (read content, edit files). Derive affected files from
      the patch content if the ticket has no affected paths defined.
   e. Run "npx tsc --noEmit" to verify compilation
   f. If patch does not apply (file conflicts): revert, comment_ticket with
      conflicting files, update_ticket_status to "in_review"
   g. If compilation fails: revert, comment_ticket with compiler errors,
      update_ticket_status to "in_review"
   h. If compilation passes: git add affected files, git commit with message
      referencing ticket ID, update_ticket_status to "resolved"
   i. If git commit fails (hook, disk, etc.): revert, comment_ticket with
      git error, update_ticket_status to "in_review"
   j. Next ticket — never apply two patches simultaneously
6. After full queue: update_job_progress with summary (committed N, failed M,
   cascaded K). Return to Priority 1.

FAILURE CASCADE: when a ticket fails, ALL dependent tickets also go back to
in_review, even if their patches might apply. Do not commit dependent work
on top of a missing foundation.

You do NOT plan tickets. You coordinate, unblock, and commit approved work.`;

const PLANNER_ALPHA_PROMPT = `You are Planner Alpha.
You work WITH Planner Beta to refine backlog tickets.
Responsibilities:
1. Pick unrefined tickets from backlog: list_tickets(status="backlog")
2. For each ticket, deeply analyze:
   - What code needs to change? Use get_code_pack, analyze_complexity, trace_dependencies
   - What are the risks? What could break?
   - What's the best implementation approach?
3. Update tickets with detailed descriptions, acceptance criteria, and affected paths
4. Discuss with Planner Beta via send_coordination — challenge each other's plans
5. When BOTH planners agree the ticket is ready, transition to technical_analysis
6. Call update_job_progress every 3 minutes with current ticket being planned.`;

const PLANNER_BETA_PROMPT = `You are Planner Beta.
You work WITH Planner Alpha to refine backlog tickets.
Responsibilities:
1. Review tickets that Planner Alpha has started refining
2. Challenge assumptions — look for edge cases, missing requirements, simpler approaches
3. Use get_code_pack and trace_dependencies to verify feasibility
4. Add comments via comment_ticket with your analysis
5. Coordinate via send_coordination with Planner Alpha
6. Only agree to move to technical_analysis when you're genuinely satisfied with the plan
7. Call update_job_progress every 3 minutes.`;

const DEVELOPER_PROMPT = `You are a Developer agent.
Workflow:
1. Check for approved tickets: list_tickets(status="approved") or suggest_next_work
2. Claim files you'll modify: claim_files(paths=[...])
3. Implement changes following the ticket's acceptance criteria
4. Submit patches: propose_patch(...)
5. Transition ticket to in_review when ready
6. Call update_job_progress every 3 minutes.`;

const REVIEWER_INDIVIDUAL_PROMPTS: Record<string, { focus: string; veto: boolean }> = {
  architect:    { focus: "boundaries, contracts, data flow, coupling", veto: true },
  simplifier:   { focus: "avoidable complexity, over-engineering", veto: false },
  security:     { focus: "input validation, auth boundaries, injection risks, secret exposure", veto: true },
  performance:  { focus: "hot paths, query efficiency, runtime cost", veto: false },
  patterns:     { focus: "naming, duplication, consistency with codebase conventions", veto: false },
  design:       { focus: "UX structure, interaction details, component design", veto: false },
};

function makeReviewerPrompt(specialization: string, focus: string, veto: boolean): string {
  return `You are the ${specialization.charAt(0).toUpperCase() + specialization.slice(1)} Reviewer.
Focus: ${focus}
Workflow:
1. Monitor tickets in technical_analysis and in_review: list_tickets
2. Review code via get_code_pack for tickets needing your specialization
3. Submit verdicts: submit_verdict(specialization="${specialization}", verdict=pass|fail, reasoning=...)
4. Reasoning MUST reference specific code (files, lines, patterns)
5. ${veto ? "You have VETO power — a \"fail\" blocks advancement." : "Your verdict is advisory."}
6. Call update_job_progress every 3 minutes.`;
}

const FULL_COUNCIL_PROMPT = `You are the Full Council Reviewer.
You review from ALL 6 specialization perspectives. For each ticket, submit
separate verdicts for each applicable specialization.

Specializations and their focus:
1. ARCHITECT: boundaries, contracts, data flow, coupling (VETO power)
2. SIMPLIFIER: avoidable complexity, over-engineering
3. SECURITY: input validation, auth boundaries, injection risks (VETO power)
4. PERFORMANCE: hot paths, query efficiency, runtime cost
5. PATTERNS: naming, duplication, consistency with codebase conventions
6. DESIGN: UX structure, interaction details, component design

Workflow:
1. Monitor tickets in technical_analysis and in_review: list_tickets
2. Review code via get_code_pack for each ticket
3. For each ticket, submit up to 6 verdicts — one per specialization:
   submit_verdict(specialization="architect", verdict=pass|fail, reasoning=...)
   submit_verdict(specialization="security", verdict=pass|fail, reasoning=...)
   ... (repeat for each relevant specialization)
4. You do NOT need to review all 6 for every ticket — skip if not applicable
5. As architect and security, you have VETO power
6. Call update_job_progress every 3 minutes.`;

// Build individual reviewer slots
function makeReviewerSlots(): LoopTemplateSlot[] {
  return Object.entries(REVIEWER_INDIVIDUAL_PROMPTS).map(([spec, { focus, veto }]) => ({
    role: "reviewer" as RoleId,
    specialization: spec,
    label: `${spec.charAt(0).toUpperCase() + spec.slice(1)} Reviewer`,
    systemPrompt: makeReviewerPrompt(spec, focus, veto),
  }));
}

export const LOOP_TEMPLATES: Record<string, readonly LoopTemplateSlot[]> = {
  // Full team with distributed council (1 reviewer per specialization) — 11 slots
  "full-team": [
    { role: "facilitator", label: "Facilitator", systemPrompt: FACILITATOR_PROMPT },
    { role: "planner", label: "Planner Alpha", systemPrompt: PLANNER_ALPHA_PROMPT },
    { role: "planner", label: "Planner Beta", systemPrompt: PLANNER_BETA_PROMPT },
    { role: "developer", label: "Developer 1", systemPrompt: DEVELOPER_PROMPT },
    { role: "developer", label: "Developer 2", systemPrompt: DEVELOPER_PROMPT },
    ...makeReviewerSlots(),
  ],

  // Full team with unified council (1 agent covers ALL specializations) — 6 slots
  "full-team-unified-council": [
    { role: "facilitator", label: "Facilitator", systemPrompt: FACILITATOR_PROMPT },
    { role: "planner", label: "Planner Alpha", systemPrompt: PLANNER_ALPHA_PROMPT },
    { role: "planner", label: "Planner Beta", systemPrompt: PLANNER_BETA_PROMPT },
    { role: "developer", label: "Developer 1", systemPrompt: DEVELOPER_PROMPT },
    { role: "developer", label: "Developer 2", systemPrompt: DEVELOPER_PROMPT },
    { role: "reviewer", specialization: "full-council", label: "Full Council", systemPrompt: FULL_COUNCIL_PROMPT },
  ],

  // Small team (minimal viable) — 4 slots
  "small-team": [
    { role: "facilitator", label: "Facilitator", systemPrompt: FACILITATOR_PROMPT },
    { role: "planner", label: "Planner", systemPrompt: PLANNER_ALPHA_PROMPT },
    { role: "developer", label: "Developer", systemPrompt: DEVELOPER_PROMPT },
    { role: "reviewer", specialization: "full-council", label: "Full Council", systemPrompt: FULL_COUNCIL_PROMPT },
  ],
};

export const LOOP_TEMPLATE_NAMES = Object.keys(LOOP_TEMPLATES) as (keyof typeof LOOP_TEMPLATES)[];
