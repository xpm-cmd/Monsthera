import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = ".agora/workflows";

const PLANNER_LOOP_YAML = `name: planner-loop
description: Reviews backlog tickets, posts plan iterations, advances to technical_analysis.
params:
  - agentId
  - sessionId
steps:
  - output: backlog
    tool: list_tickets
    description: Find tickets needing planning
    input:
      status: backlog
      agentId: "{{params.agentId}}"
      sessionId: "{{params.sessionId}}"
      limit: 5

  - output: ticket
    tool: get_ticket
    description: Load first backlog ticket details
    condition: "steps.backlog.tickets.length > 0"
    input:
      ticketId: "{{steps.backlog.tickets[0].ticketId}}"
      agentId: "{{params.agentId}}"
      sessionId: "{{params.sessionId}}"

  - output: context
    tool: get_code_pack
    description: Gather code context for affected paths
    condition: "steps.ticket"
    input:
      query: "{{steps.ticket.title}}"
      expand: true
      maxFiles: 10

  - output: plan_comment
    tool: comment_ticket
    description: Post plan iteration with analysis
    condition: "steps.ticket"
    input:
      ticketId: "{{steps.ticket.ticketId}}"
      content: "[Plan Iteration] Reviewed ticket context. Affected files identified via code search. Ready for technical analysis."
      agentId: "{{params.agentId}}"
      sessionId: "{{params.sessionId}}"

  - output: advance
    tool: update_ticket_status
    description: Advance ticket to technical_analysis
    condition: "steps.ticket"
    input:
      ticketId: "{{steps.ticket.ticketId}}"
      status: technical_analysis
      agentId: "{{params.agentId}}"
      sessionId: "{{params.sessionId}}"
`;

const DEVELOPER_LOOP_YAML = `name: developer-loop
description: Picks an approved ticket, claims files, implements, and submits for review.
params:
  - agentId
  - sessionId
  - ticketId
steps:
  - output: ticket
    tool: get_ticket
    description: Load assigned ticket details
    input:
      ticketId: "{{params.ticketId}}"
      agentId: "{{params.agentId}}"
      sessionId: "{{params.sessionId}}"

  - output: context
    tool: get_code_pack
    description: Gather code context for implementation
    input:
      query: "{{steps.ticket.title}} {{steps.ticket.description}}"
      expand: true
      maxFiles: 15

  - output: knowledge
    tool: search_knowledge
    description: Load project context from knowledge store
    input:
      query: "{{steps.ticket.title}}"
      limit: 5

  - output: claim
    tool: claim_files
    description: Claim affected files to prevent conflicts
    input:
      agentId: "{{params.agentId}}"
      sessionId: "{{params.sessionId}}"
      paths: "{{steps.ticket.affectedPaths}}"
    onError: continue
`;

export async function ensureDefaultWorkflows(repoPath: string): Promise<string[]> {
  const dir = join(repoPath, WORKFLOW_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const created: string[] = [];

  const plannerPath = join(dir, "planner-loop.yaml");
  if (!existsSync(plannerPath)) {
    writeFileSync(plannerPath, PLANNER_LOOP_YAML, "utf-8");
    created.push("planner-loop.yaml");
  }

  const devPath = join(dir, "developer-loop.yaml");
  if (!existsSync(devPath)) {
    writeFileSync(devPath, DEVELOPER_LOOP_YAML, "utf-8");
    created.push("developer-loop.yaml");
  }

  return created;
}
