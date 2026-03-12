import type { CapabilityToolName } from "../tools/tool-manifest.js";

export type WorkflowStepErrorMode = "stop" | "continue";
export type WorkflowStatus = "completed" | "failed" | "partial";
export type WorkflowStepStatus = "completed" | "failed" | "partial" | "skipped";

export interface WorkflowStepSpec {
  key: string;
  tool: CapabilityToolName;
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
  tool: CapabilityToolName;
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
