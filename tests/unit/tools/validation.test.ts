import { describe, it, expect } from "vitest";
import {
  requireString,
  optionalString,
  optionalNumber,
  isErrorResponse,
  requireEnum,
  successResponse,
  errorResponse,
  MAX_ID_LENGTH,
} from "../../../src/tools/validation.js";
import type { ToolResponse } from "../../../src/tools/knowledge-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unwrap the JSON text payload from a ToolResponse */
function parseResponseText(resp: { content: { text: string }[] }): unknown {
  return JSON.parse(resp.content[0]!.text);
}

// ---------------------------------------------------------------------------
// requireString
// ---------------------------------------------------------------------------

describe("requireString", () => {
  it("returns the string for a valid non-empty string", () => {
    const result = requireString({ name: "hello" }, "name");
    expect(result).toBe("hello");
  });

  it("returns error for missing key", () => {
    const result = requireString({}, "name");
    expect(isErrorResponse(result)).toBe(true);
    const body = parseResponseText(result as ToolResponse);
    expect(body).toMatchObject({ error: "VALIDATION_FAILED" });
  });

  it("returns error for empty string", () => {
    const result = requireString({ name: "" }, "name");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for number type", () => {
    const result = requireString({ name: 42 }, "name");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for boolean type", () => {
    const result = requireString({ name: true }, "name");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for null", () => {
    const result = requireString({ name: null }, "name");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for array", () => {
    const result = requireString({ name: ["a", "b"] }, "name");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for undefined value", () => {
    const result = requireString({ name: undefined }, "name");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error when string exceeds default max length", () => {
    const long = "x".repeat(MAX_ID_LENGTH + 1);
    const result = requireString({ name: long }, "name");
    expect(isErrorResponse(result)).toBe(true);
    const body = parseResponseText(result as ToolResponse);
    expect((body as ToolResponse).message).toContain(`${MAX_ID_LENGTH}`);
  });

  it("accepts string at exactly the default max length", () => {
    const exact = "x".repeat(MAX_ID_LENGTH);
    const result = requireString({ name: exact }, "name");
    expect(result).toBe(exact);
  });

  it("respects custom maxLength parameter", () => {
    const result = requireString({ name: "abcdef" }, "name", 5);
    expect(isErrorResponse(result)).toBe(true);
    const body = parseResponseText(result as ToolResponse);
    expect((body as ToolResponse).message).toContain("5");
  });

  it("accepts string within custom maxLength", () => {
    const result = requireString({ name: "abc" }, "name", 5);
    expect(result).toBe("abc");
  });

  it("includes the key name in the error message", () => {
    const result = requireString({}, "myField");
    const body = parseResponseText(result as ToolResponse);
    expect((body as ToolResponse).message).toContain("myField");
  });
});

// ---------------------------------------------------------------------------
// optionalString
// ---------------------------------------------------------------------------

describe("optionalString", () => {
  it("returns undefined for missing key", () => {
    const result = optionalString({}, "name");
    expect(result).toBeUndefined();
  });

  it("returns undefined when value is explicitly undefined", () => {
    const result = optionalString({ name: undefined }, "name");
    expect(result).toBeUndefined();
  });

  it("returns the string for a valid string", () => {
    const result = optionalString({ name: "hello" }, "name");
    expect(result).toBe("hello");
  });

  it("returns empty string as valid (not undefined)", () => {
    // empty string is a string, not undefined — so it passes the typeof check
    const result = optionalString({ name: "" }, "name");
    expect(result).toBe("");
  });

  it("returns error for number type", () => {
    const result = optionalString({ name: 123 }, "name");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for boolean type", () => {
    const result = optionalString({ name: false }, "name");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for null", () => {
    const result = optionalString({ name: null }, "name");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for array", () => {
    const result = optionalString({ name: ["a"] }, "name");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for string exceeding default max length", () => {
    const long = "x".repeat(MAX_ID_LENGTH + 1);
    const result = optionalString({ name: long }, "name");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("accepts string at exactly the default max length", () => {
    const exact = "x".repeat(MAX_ID_LENGTH);
    const result = optionalString({ name: exact }, "name");
    expect(result).toBe(exact);
  });

  it("respects custom maxLength parameter", () => {
    const result = optionalString({ name: "toolong" }, "name", 3);
    expect(isErrorResponse(result)).toBe(true);
  });

  it("accepts string within custom maxLength", () => {
    const result = optionalString({ name: "ok" }, "name", 10);
    expect(result).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// optionalNumber
// ---------------------------------------------------------------------------

describe("optionalNumber", () => {
  it("returns undefined for missing key", () => {
    const result = optionalNumber({}, "count", 0, 100);
    expect(result).toBeUndefined();
  });

  it("returns undefined when value is explicitly undefined", () => {
    const result = optionalNumber({ count: undefined }, "count", 0, 100);
    expect(result).toBeUndefined();
  });

  it("returns the number for a valid number within range", () => {
    const result = optionalNumber({ count: 42 }, "count", 0, 100);
    expect(result).toBe(42);
  });

  it("returns the number at exactly the min bound", () => {
    const result = optionalNumber({ count: 0 }, "count", 0, 100);
    expect(result).toBe(0);
  });

  it("returns the number at exactly the max bound", () => {
    const result = optionalNumber({ count: 100 }, "count", 0, 100);
    expect(result).toBe(100);
  });

  it("returns error for string type", () => {
    const result = optionalNumber({ count: "42" }, "count", 0, 100);
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for boolean type", () => {
    const result = optionalNumber({ count: true }, "count", 0, 100);
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for null", () => {
    const result = optionalNumber({ count: null }, "count", 0, 100);
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for NaN", () => {
    const result = optionalNumber({ count: NaN }, "count", 0, 100);
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for Infinity", () => {
    const result = optionalNumber({ count: Infinity }, "count", 0, 100);
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for -Infinity", () => {
    const result = optionalNumber({ count: -Infinity }, "count", 0, 100);
    expect(isErrorResponse(result)).toBe(true);
  });

  it("returns error for number below min", () => {
    const result = optionalNumber({ count: -1 }, "count", 0, 100);
    expect(isErrorResponse(result)).toBe(true);
    const body = parseResponseText(result as ToolResponse);
    expect((body as ToolResponse).message).toContain("between 0 and 100");
  });

  it("returns error for number above max", () => {
    const result = optionalNumber({ count: 101 }, "count", 0, 100);
    expect(isErrorResponse(result)).toBe(true);
    const body = parseResponseText(result as ToolResponse);
    expect((body as ToolResponse).message).toContain("between 0 and 100");
  });

  it("works with negative min/max ranges", () => {
    const result = optionalNumber({ val: -5 }, "val", -10, -1);
    expect(result).toBe(-5);
  });

  it("rejects value outside negative range", () => {
    const result = optionalNumber({ val: 0 }, "val", -10, -1);
    expect(isErrorResponse(result)).toBe(true);
  });

  it("works with fractional numbers", () => {
    const result = optionalNumber({ ratio: 0.5 }, "ratio", 0, 1);
    expect(result).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// isErrorResponse
// ---------------------------------------------------------------------------

describe("isErrorResponse", () => {
  it("returns true for an error response from errorResponse()", () => {
    const resp = errorResponse("SOME_ERROR", "something went wrong");
    expect(isErrorResponse(resp)).toBe(true);
  });

  it("returns true for any object with isError property", () => {
    expect(isErrorResponse({ isError: true, content: [] })).toBe(true);
  });

  it("returns true even when isError is false (property exists)", () => {
    // The guard only checks "isError" in value, not its truthiness
    expect(isErrorResponse({ isError: false })).toBe(true);
  });

  it("returns false for a string", () => {
    expect(isErrorResponse("hello")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isErrorResponse(undefined)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isErrorResponse(null)).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isErrorResponse(42)).toBe(false);
  });

  it("returns false for a regular object without isError", () => {
    expect(isErrorResponse({ content: [] })).toBe(false);
  });

  it("returns false for a success response", () => {
    const resp = successResponse({ status: "ok" });
    expect(isErrorResponse(resp)).toBe(false);
  });

  it("returns false for an array", () => {
    expect(isErrorResponse([1, 2, 3])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requireEnum
// ---------------------------------------------------------------------------

describe("requireEnum", () => {
  const validValues = new Set(["alpha", "beta", "gamma"]);

  it("returns null for a valid enum value", () => {
    expect(requireEnum("alpha", validValues, "mode")).toBeNull();
  });

  it("returns null for each valid value", () => {
    for (const v of validValues) {
      expect(requireEnum(v, validValues, "mode")).toBeNull();
    }
  });

  it("returns error response for an invalid value", () => {
    const result = requireEnum("delta", validValues, "mode");
    expect(result).not.toBeNull();
    expect(isErrorResponse(result)).toBe(true);
  });

  it("includes the invalid value in the error message", () => {
    const result = requireEnum("delta", validValues, "mode");
    const body = parseResponseText(result as ToolResponse);
    expect((body as ToolResponse).message).toContain("delta");
  });

  it("includes the field name in the error message", () => {
    const result = requireEnum("delta", validValues, "myField");
    const body = parseResponseText(result as ToolResponse);
    expect((body as ToolResponse).message).toContain("myField");
  });

  it("lists allowed values in the error message", () => {
    const result = requireEnum("nope", validValues, "mode");
    const body = parseResponseText(result as ToolResponse);
    expect((body as ToolResponse).message).toContain("alpha");
    expect((body as ToolResponse).message).toContain("beta");
    expect((body as ToolResponse).message).toContain("gamma");
  });

  it("returns error for empty string when not in the set", () => {
    const result = requireEnum("", validValues, "mode");
    expect(isErrorResponse(result)).toBe(true);
  });

  it("is case-sensitive", () => {
    const result = requireEnum("Alpha", validValues, "mode");
    expect(isErrorResponse(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// successResponse
// ---------------------------------------------------------------------------

describe("successResponse", () => {
  it("wraps data in content array with type text", () => {
    const resp = successResponse({ status: "ok" });
    expect(resp.content).toHaveLength(1);
    expect(resp.content[0]!.type).toBe("text");
  });

  it("serializes data as pretty JSON (2-space indent)", () => {
    const data = { a: 1, b: "two" };
    const resp = successResponse(data);
    expect(resp.content[0]!.text).toBe(JSON.stringify(data, null, 2));
  });

  it("does not include isError", () => {
    const resp = successResponse("anything");
    expect(resp).not.toHaveProperty("isError");
  });

  it("handles string data", () => {
    const resp = successResponse("hello");
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed).toBe("hello");
  });

  it("handles number data", () => {
    const resp = successResponse(42);
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed).toBe(42);
  });

  it("handles null data", () => {
    const resp = successResponse(null);
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed).toBeNull();
  });

  it("handles array data", () => {
    const resp = successResponse([1, 2, 3]);
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed).toEqual([1, 2, 3]);
  });

  it("handles nested objects", () => {
    const data = { nested: { deep: { value: true } } };
    const resp = successResponse(data);
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// errorResponse
// ---------------------------------------------------------------------------

describe("errorResponse", () => {
  it("includes isError: true", () => {
    const resp = errorResponse("ERR_CODE", "something failed");
    expect(resp.isError).toBe(true);
  });

  it("wraps in content array with type text", () => {
    const resp = errorResponse("ERR_CODE", "something failed");
    expect(resp.content).toHaveLength(1);
    expect(resp.content[0]!.type).toBe("text");
  });

  it("includes error code in the JSON payload", () => {
    const resp = errorResponse("NOT_FOUND", "item missing");
    const body = JSON.parse(resp.content[0]!.text);
    expect(body.error).toBe("NOT_FOUND");
  });

  it("includes message in the JSON payload", () => {
    const resp = errorResponse("NOT_FOUND", "item missing");
    const body = JSON.parse(resp.content[0]!.text);
    expect(body.message).toBe("item missing");
  });

  it("preserves special characters in message", () => {
    const msg = 'value "foo" is <invalid> & broken';
    const resp = errorResponse("ERR", msg);
    const body = JSON.parse(resp.content[0]!.text);
    expect(body.message).toBe(msg);
  });

  it("preserves unicode in message", () => {
    const msg = "error: campo requerido \u2014 \u00bfd\u00f3nde est\u00e1?";
    const resp = errorResponse("ERR", msg);
    const body = JSON.parse(resp.content[0]!.text);
    expect(body.message).toBe(msg);
  });
});
