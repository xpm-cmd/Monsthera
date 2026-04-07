import { describe, it, expect } from "vitest";
import {
  ErrorCode,
  MonstheraError,
  ValidationError,
  NotFoundError,
  AlreadyExistsError,
  PermissionError,
  StateTransitionError,
  StorageError,
  ConfigurationError,
  GuardFailedError,
  ConcurrencyConflictError,
} from "../../../src/core/errors.js";

describe("MonstheraError", () => {
  it("carries the error code and message", () => {
    const error = new MonstheraError(ErrorCode.NOT_FOUND, "something missing");
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(error.message).toBe("something missing");
    expect(error.name).toBe("MonstheraError");
  });

  it("carries optional details", () => {
    const details = { entity: "User", id: "123" };
    const error = new MonstheraError(ErrorCode.NOT_FOUND, "not found", details);
    expect(error.details).toEqual(details);
  });

  it("has undefined details when not provided", () => {
    const error = new MonstheraError(ErrorCode.VALIDATION_FAILED, "bad input");
    expect(error.details).toBeUndefined();
  });

  it(".toResult() creates a Result.err wrapping the error", () => {
    const error = new MonstheraError(ErrorCode.STORAGE_ERROR, "disk full");
    const result = error.toResult();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(error);
  });
});

describe("ValidationError", () => {
  it("sets correct name and code", () => {
    const error = new ValidationError("invalid field");
    expect(error.name).toBe("ValidationError");
    expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(error.message).toBe("invalid field");
  });
});

describe("NotFoundError", () => {
  it("formats message with entity and id", () => {
    const error = new NotFoundError("Article", "abc-123");
    expect(error.name).toBe("NotFoundError");
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(error.message).toBe("Article not found: abc-123");
    expect(error.details).toEqual({ entity: "Article", id: "abc-123" });
  });
});

describe("AlreadyExistsError", () => {
  it("sets correct name, code, and message", () => {
    const error = new AlreadyExistsError("User", "user-1");
    expect(error.name).toBe("AlreadyExistsError");
    expect(error.code).toBe(ErrorCode.ALREADY_EXISTS);
    expect(error.message).toBe("User already exists: user-1");
  });
});

describe("PermissionError", () => {
  it("sets correct name and code", () => {
    const error = new PermissionError("access denied");
    expect(error.name).toBe("PermissionError");
    expect(error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });
});

describe("StateTransitionError", () => {
  it("includes from/to/reason in message and details", () => {
    const error = new StateTransitionError("planning", "review", "missing enrichment");
    expect(error.name).toBe("StateTransitionError");
    expect(error.code).toBe(ErrorCode.STATE_TRANSITION_INVALID);
    expect(error.message).toBe("Cannot transition from planning to review: missing enrichment");
    expect(error.details).toEqual({ from: "planning", to: "review", reason: "missing enrichment" });
  });
});

describe("StorageError", () => {
  it("sets correct name and code", () => {
    const error = new StorageError("write failed");
    expect(error.name).toBe("StorageError");
    expect(error.code).toBe(ErrorCode.STORAGE_ERROR);
  });
});

describe("ConfigurationError", () => {
  it("sets correct name and code", () => {
    const error = new ConfigurationError("missing config key");
    expect(error.name).toBe("ConfigurationError");
    expect(error.code).toBe(ErrorCode.CONFIGURATION_ERROR);
  });
});

describe("GuardFailedError", () => {
  it("includes guard name in message and details", () => {
    const error = new GuardFailedError("hasEnrichment", "no enrichment found");
    expect(error.name).toBe("GuardFailedError");
    expect(error.code).toBe(ErrorCode.GUARD_FAILED);
    expect(error.message).toBe('Guard "hasEnrichment" failed: no enrichment found');
    expect(error.details).toEqual({ guard: "hasEnrichment", reason: "no enrichment found" });
  });
});

describe("ConcurrencyConflictError", () => {
  it("includes resource in message and details", () => {
    const error = new ConcurrencyConflictError("file:src/index.ts");
    expect(error.name).toBe("ConcurrencyConflictError");
    expect(error.code).toBe(ErrorCode.CONCURRENCY_CONFLICT);
    expect(error.message).toBe("Concurrency conflict on: file:src/index.ts");
    expect(error.details?.resource).toBe("file:src/index.ts");
  });

  it("merges extra details", () => {
    const error = new ConcurrencyConflictError("res", { claimedBy: "agent-1" });
    expect(error.details?.resource).toBe("res");
    expect(error.details?.claimedBy).toBe("agent-1");
  });
});
