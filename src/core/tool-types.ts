export type ToolRunnerErrorCode = "tool_not_found" | "denied" | "execution_failed" | "validation_failed";

export type ToolRunnerCallResult =
  | {
      ok: true;
      tool: string;
      result: unknown;
    }
  | {
      ok: false;
      tool: string;
      errorCode: ToolRunnerErrorCode;
      message: string;
      result?: unknown;
      causeCode?: string;
      detail?: string;
    };
