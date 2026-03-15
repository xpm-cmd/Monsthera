import type { WorkflowCatalogEntry, WorkflowSpec } from "./types.js";

export const BUILTIN_WORKFLOW_NAMES = ["onboard", "deep-review", "ta-review", "deep-review-v2", "backlog-triage", "auto-resolve"] as const;
export type BuiltInWorkflowName = (typeof BUILTIN_WORKFLOW_NAMES)[number];

export const BUILTIN_WORKFLOWS: Record<BuiltInWorkflowName, WorkflowSpec> = {
  onboard: {
    name: "onboard",
    description: "Collect a compact architecture snapshot and store it as repo knowledge.",
    defaults: {
      query: "architecture",
      title: "Onboard snapshot",
      scope: "repo",
    },
    steps: [
      {
        key: "code_pack",
        tool: "get_code_pack",
        description: "Collect compact architecture-oriented code context.",
        input: {
          query: "{{params.query}}",
          verbosity: "compact",
        },
      },
      {
        key: "capabilities",
        tool: "capabilities",
        description: "Inspect available tools and workflow surface.",
        input: {},
      },
      {
        key: "knowledge_entry",
        tool: "store_knowledge",
        description: "Persist the onboarding summary as repo knowledge.",
        input: {
          type: "context",
          scope: "{{params.scope}}",
          title: "{{params.title}}",
          tags: ["workflow", "onboarding"],
          content: [
            "Workflow: onboard",
            "Query: {{steps.code_pack.query}}",
            "Current head: {{steps.code_pack.currentHead}}",
            "Candidate count: {{steps.code_pack.candidateCount}}",
            "Candidates: {{steps.code_pack.candidates}}",
            "Tools: {{steps.capabilities.tools}}",
            "Workflows: {{steps.capabilities.workflows}}",
            "Review roles: {{steps.capabilities.availableReviewRoles}}",
          ].join("\n"),
        },
      },
    ],
  },
  "deep-review": {
    name: "deep-review",
    description: "Inspect the latest change pack, fan out static analysis, then suggest review actions.",
    steps: [
      {
        key: "changes",
        tool: "get_change_pack",
        description: "Capture the latest changed files and commit context.",
        input: {
          sinceCommit: "{{params.sinceCommit}}",
          verbosity: "compact",
        },
      },
      {
        key: "complexity",
        tool: "analyze_complexity",
        description: "Analyze complexity for each changed file sequentially.",
        forEach: "steps.changes.changedFiles",
        onError: "continue",
        input: {
          filePath: "{{item.path}}",
        },
      },
      {
        key: "coverage",
        tool: "analyze_test_coverage",
        description: "Inspect structural test coverage for each changed file sequentially.",
        forEach: "steps.changes.changedFiles",
        onError: "continue",
        input: {
          filePath: "{{item.path}}",
        },
      },
      {
        key: "suggestions",
        tool: "suggest_actions",
        description: "Recommend follow-up actions for the changed path set.",
        input: {
          changedPaths: "{{steps.changes.changedFiles.path}}",
        },
      },
    ],
  },
  "ta-review": {
    name: "ta-review",
    description: "Collect ticket context, wait for council quorum, then approve the ticket once the checkpoint passes.",
    requiredParams: ["ticketId"],
    defaults: {
      timeoutSeconds: 120,
    },
    steps: [
      {
        key: "ticket",
        tool: "get_ticket",
        description: "Load the target ticket before requesting council review.",
        input: {
          ticketId: "{{params.ticketId}}",
        },
      },
      {
        key: "quorum",
        type: "quorum_checkpoint",
        tool: "quorum_checkpoint",
        description: "Wait for analytical council quorum with architect/security veto enforcement.",
        input: {
          ticketId: "{{params.ticketId}}",
          timeout: "{{params.timeoutSeconds}}",
          onFail: "block",
        },
      },
      {
        key: "approval",
        tool: "update_ticket_status",
        description: "Approve the ticket when the quorum checkpoint is satisfied.",
        condition: "steps.quorum.advisoryReady",
        input: {
          ticketId: "{{params.ticketId}}",
          status: "approved",
          comment: "Workflow ta-review: quorum checkpoint satisfied",
        },
      },
    ],
  },
  "deep-review-v2": {
    name: "deep-review-v2",
    description: "Run deep-review context gathering, then gate ready_for_commit on the council quorum checkpoint.",
    requiredParams: ["ticketId"],
    defaults: {
      timeoutSeconds: 120,
    },
    steps: [
      {
        key: "changes",
        tool: "get_change_pack",
        description: "Capture the current change pack before the quorum checkpoint.",
        input: {
          sinceCommit: "{{params.sinceCommit}}",
          verbosity: "compact",
        },
      },
      {
        key: "quorum",
        type: "quorum_checkpoint",
        tool: "quorum_checkpoint",
        description: "Wait for analytical council quorum with architect/security veto enforcement.",
        input: {
          ticketId: "{{params.ticketId}}",
          timeout: "{{params.timeoutSeconds}}",
          onFail: "block",
        },
      },
      {
        key: "ready_for_commit",
        tool: "update_ticket_status",
        description: "Advance the ticket when the quorum checkpoint is satisfied.",
        condition: "steps.quorum.advisoryReady",
        input: {
          ticketId: "{{params.ticketId}}",
          status: "ready_for_commit",
          comment: "Workflow deep-review-v2: quorum checkpoint satisfied",
        },
      },
    ],
  },
  "backlog-triage": {
    name: "backlog-triage",
    description: "Evaluate a backlog ticket for planning completeness and advance to technical_analysis when ready.",
    requiredParams: ["ticketId"],
    steps: [
      {
        key: "ticket",
        tool: "get_ticket",
        description: "Load the full ticket to evaluate readiness.",
        input: { ticketId: "{{params.ticketId}}" },
      },
      {
        key: "advance",
        tool: "update_ticket_status",
        description: "Advance to technical_analysis when ticket has description and affected paths.",
        condition: "steps.ticket.description && steps.ticket.affectedPaths",
        onError: "continue",
        input: {
          ticketId: "{{params.ticketId}}",
          status: "technical_analysis",
          comment: "Planner auto-triage: ticket has description and affected paths — advancing to technical analysis.",
        },
      },
    ],
  },
  "auto-resolve": {
    name: "auto-resolve",
    description: "Resolve a ready_for_commit ticket — verifies patches exist and advances to resolved.",
    requiredParams: ["ticketId"],
    steps: [
      {
        key: "ticket",
        tool: "get_ticket",
        description: "Load the ticket to verify it is ready for resolution.",
        input: { ticketId: "{{params.ticketId}}" },
      },
      {
        key: "patches",
        tool: "list_patches",
        description: "Verify that committed or validated patches exist for this ticket.",
        onError: "continue" as const,
        input: {},
      },
      {
        key: "resolve",
        tool: "update_ticket_status",
        description: "Advance to resolved when ticket is ready_for_commit.",
        condition: "steps.ticket.status === 'ready_for_commit'",
        onError: "continue" as const,
        input: {
          ticketId: "{{params.ticketId}}",
          status: "resolved",
          comment: "Planner auto-resolve: ticket reached ready_for_commit, advancing to resolved.",
        },
      },
    ],
  },
};

export function getBuiltInWorkflow(name: BuiltInWorkflowName): WorkflowSpec {
  return BUILTIN_WORKFLOWS[name];
}

export function isBuiltInWorkflowName(name: string): name is BuiltInWorkflowName {
  return (BUILTIN_WORKFLOW_NAMES as readonly string[]).includes(name);
}

export function listBuiltInWorkflows(): WorkflowCatalogEntry[] {
  return BUILTIN_WORKFLOW_NAMES.map((name) => ({
    name,
    description: BUILTIN_WORKFLOWS[name].description,
    tools: BUILTIN_WORKFLOWS[name].steps.map((step) => step.tool),
    source: "builtin",
  }));
}
