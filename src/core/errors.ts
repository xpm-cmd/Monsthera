import type { Result } from "./result.js";
import { err } from "./result.js";

/** Error codes as string constants */
export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  STATE_TRANSITION_INVALID: "STATE_TRANSITION_INVALID",
  STORAGE_ERROR: "STORAGE_ERROR",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
  GUARD_FAILED: "GUARD_FAILED",
  CONCURRENCY_CONFLICT: "CONCURRENCY_CONFLICT",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Base error class for all Monsthera errors */
export class MonstheraError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MonstheraError";
    this.code = code;
    this.details = details;
  }

  /** Create a Result.err from this error */
  toResult<T>(): Result<T, MonstheraError> {
    return err(this);
  }
}

/** Validation failure (bad input, schema mismatch) */
export class ValidationError extends MonstheraError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.VALIDATION_FAILED, message, details);
    this.name = "ValidationError";
  }
}

/** Entity not found */
export class NotFoundError extends MonstheraError {
  constructor(entity: string, id: string) {
    super(ErrorCode.NOT_FOUND, `${entity} not found: ${id}`, { entity, id });
    this.name = "NotFoundError";
  }
}

/** Entity already exists */
export class AlreadyExistsError extends MonstheraError {
  constructor(entity: string, id: string) {
    super(ErrorCode.ALREADY_EXISTS, `${entity} already exists: ${id}`, { entity, id });
    this.name = "AlreadyExistsError";
  }
}

/** Permission denied */
export class PermissionError extends MonstheraError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.PERMISSION_DENIED, message, details);
    this.name = "PermissionError";
  }
}

/** Invalid state transition (e.g., planning → review without enrichment) */
export class StateTransitionError extends MonstheraError {
  constructor(from: string, to: string, reason: string) {
    super(ErrorCode.STATE_TRANSITION_INVALID, `Cannot transition from ${from} to ${to}: ${reason}`, { from, to, reason });
    this.name = "StateTransitionError";
  }
}

/** Storage/persistence failure */
export class StorageError extends MonstheraError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.STORAGE_ERROR, message, details);
    this.name = "StorageError";
  }
}

/** Configuration error */
export class ConfigurationError extends MonstheraError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.CONFIGURATION_ERROR, message, details);
    this.name = "ConfigurationError";
  }
}

/** Guard evaluation failure */
export class GuardFailedError extends MonstheraError {
  constructor(guard: string, reason: string) {
    super(ErrorCode.GUARD_FAILED, `Guard "${guard}" failed: ${reason}`, { guard, reason });
    this.name = "GuardFailedError";
  }
}

/** Concurrency conflict (e.g., file claim collision) */
export class ConcurrencyConflictError extends MonstheraError {
  constructor(resource: string, details?: Record<string, unknown>) {
    super(ErrorCode.CONCURRENCY_CONFLICT, `Concurrency conflict on: ${resource}`, { resource, ...details });
    this.name = "ConcurrencyConflictError";
  }
}
