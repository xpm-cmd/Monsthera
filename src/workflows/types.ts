import type { CapabilityToolName } from "../tools/tool-manifest.js";
import type { ReviewVerdictRecord } from "../tickets/consensus.js";
import type { ToolRunnerCallResult } from "../tools/tool-runner.js";

export type WorkflowStepErrorMode = "stop" | "continue";
export type WorkflowCheckpointFailureMode = "block" | "continue_with_warning";
export type WorkflowStatus = "completed" | "failed" | "partial";
export type WorkflowStepStatus = "completed" | "failed" | "partial" | "skipped";
export type WorkflowCatalogSource = "builtin" | "custom";
export type WorkflowStepType = "tool" | "quorum_checkpoint";
export type WorkflowStepToolName = CapabilityToolName | "quorum_checkpoint";

export interface WorkflowQuorumRequest {
  ticketId: string;
  roles: string[];
  workflowName: string;
  stepKey: string;
  requestedBy: string;
  timeoutSeconds: number;
}

export interface WorkflowRuntime {
  runner: {
    callTool: (name: string, params: Record<string, unknown>) => Promise<ToolRunnerCallResult>;
    has: (name: string) => boolean;
  };
  actor: WorkflowActor;
  workflowName?: string;
  loadReviewVerdicts?: (ticketId: string) => Promise<ReviewVerdictRecord[] | null> | ReviewVerdictRecord[] | null;
  sendCoordination?: (request: WorkflowQuorumRequest) => void | Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkflowStepSpec {
  key: string;
  tool: WorkflowStepToolName;
  type?: WorkflowStepType;
  input: Record<string, unknown>;
  description?: string;
  condition?: string;
  onError?: WorkflowStepErrorMode;
  forEach?: string;
}

export interface WorkflowSpec {
  name: string;
  description: string;
  steps: WorkflowStepSpec[];
  requiredParams?: string[];
  defaults?: Record<string, unknown>;
}

export interface WorkflowCatalogEntry {
  name: string;
  description: string;
  tools: string[];
  source: WorkflowCatalogSource;
  filePath?: string;
}

export interface WorkflowActor {
  agentId: string;
  sessionId: string;
}

export interface WorkflowItemResult {
  index: number;
  status: Exclude<WorkflowStepStatus, "skipped">;
  input: Record<string, unknown>;
  output?: unknown;
  durationMs: number;
  errorCode?: string;
  message?: string;
}

export interface WorkflowStepResult {
  key: string;
  tool: WorkflowStepToolName;
  description?: string;
  status: WorkflowStepStatus;
  durationMs: number;
  input?: Record<string, unknown>;
  output?: unknown;
  items?: WorkflowItemResult[];
  errorCode?: string;
  message?: string;
}

export interface WorkflowResult {
  name: string;
  description: string;
  status: WorkflowStatus;
  params: Record<string, unknown>;
  steps: WorkflowStepResult[];
  outputs: Record<string, unknown>;
  durationMs: number;
}
