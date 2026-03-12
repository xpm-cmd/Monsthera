import type { WorkflowSpec } from "./types.js";

export const BUILTIN_WORKFLOW_NAMES = ["onboard", "deep-review"] as const;
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
};

export function getBuiltInWorkflow(name: BuiltInWorkflowName): WorkflowSpec {
  return BUILTIN_WORKFLOWS[name];
}

export function listBuiltInWorkflows(): Array<{
  name: BuiltInWorkflowName;
  description: string;
  tools: string[];
}> {
  return BUILTIN_WORKFLOW_NAMES.map((name) => ({
    name,
    description: BUILTIN_WORKFLOWS[name].description,
    tools: BUILTIN_WORKFLOWS[name].steps.map((step) => step.tool),
  }));
}
