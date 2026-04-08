import type { ToolResponse } from "./knowledge-tools.js";

// Max lengths for input validation at the tool boundary
export const MAX_ID_LENGTH = 64;
export const MAX_TITLE_LENGTH = 200;
export const MAX_CONTENT_LENGTH = 500_000;
export const MAX_QUERY_LENGTH = 1000;
export const MAX_TAG_LENGTH = 100;
export const MAX_TAGS_COUNT = 50;

/** Helper to build a success response */
export function successResponse(data: unknown): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Helper to build an error response */
export function errorResponse(code: string, message: string): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
}

/** Extract a required string arg with length limit */
export function requireString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number = MAX_ID_LENGTH,
): string | ToolResponse {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return errorResponse("VALIDATION_FAILED", `"${key}" is required and must be a non-empty string`);
  }
  if (value.length > maxLength) {
    return errorResponse("VALIDATION_FAILED", `"${key}" exceeds maximum length of ${maxLength}`);
  }
  return value;
}

/** Extract an optional string arg with length limit */
export function optionalString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number = MAX_ID_LENGTH,
): string | undefined | ToolResponse {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return errorResponse("VALIDATION_FAILED", `"${key}" must be a string`);
  }
  if (value.length > maxLength) {
    return errorResponse("VALIDATION_FAILED", `"${key}" exceeds maximum length of ${maxLength}`);
  }
  return value;
}

/** Extract an optional number arg with min/max bounds */
export function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined | ToolResponse {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return errorResponse("VALIDATION_FAILED", `"${key}" must be a number`);
  }
  if (value < min || value > max) {
    return errorResponse("VALIDATION_FAILED", `"${key}" must be between ${min} and ${max}`);
  }
  return value;
}

/** Type guard: is the value a ToolResponse (i.e., an error from arg extraction)? */
export function isErrorResponse(value: unknown): value is ToolResponse {
  return typeof value === "object" && value !== null && "isError" in value;
}

/** Validate a string is one of the allowed enum values */
export function requireEnum(
  value: string,
  validValues: ReadonlySet<string>,
  fieldName: string,
): ToolResponse | null {
  if (!validValues.has(value)) {
    return errorResponse(
      "VALIDATION_FAILED",
      `Invalid ${fieldName} "${value}". Must be one of: ${[...validValues].join(", ")}`,
    );
  }
  return null;
}
