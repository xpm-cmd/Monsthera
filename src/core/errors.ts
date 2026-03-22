export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MonstheraError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "MonstheraError";
  }
}

export class IndexError extends MonstheraError {
  constructor(message: string) {
    super(message, "INDEX_ERROR");
    this.name = "IndexError";
  }
}

export class StalePatchError extends MonstheraError {
  constructor(
    public readonly baseCommit: string,
    public readonly currentHead: string,
  ) {
    super(
      `Patch base commit ${baseCommit} does not match current HEAD ${currentHead}. Re-fetch context and re-propose.`,
      "STALE_PATCH",
    );
    this.name = "StalePatchError";
  }
}

export class PermissionDeniedError extends MonstheraError {
  constructor(
    public readonly agentId: string,
    public readonly tool: string,
    public readonly reason: string,
  ) {
    super(`Agent ${agentId} denied access to ${tool}: ${reason}`, "PERMISSION_DENIED");
    this.name = "PermissionDeniedError";
  }
}

export class ValidationError extends MonstheraError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class SecretDetectedError extends MonstheraError {
  constructor(
    public readonly filePath: string,
    public readonly lineRange: { start: number; end: number },
  ) {
    super(`Secret pattern detected in ${filePath} at lines ${lineRange.start}-${lineRange.end}`, "SECRET_DETECTED");
    this.name = "SecretDetectedError";
  }
}
