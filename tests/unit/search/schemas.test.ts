import { describe, it, expect } from "vitest";
import { validateSearchInput } from "../../../src/search/schemas.js";

describe("validateSearchInput", () => {
  it("accepts valid input", () => {
    const result = validateSearchInput({ query: "test" });
    expect(result.ok).toBe(true);
  });

  it("accepts input with all optional fields", () => {
    const result = validateSearchInput({ query: "test", type: "knowledge", limit: 10, offset: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("knowledge");
    expect(result.value.limit).toBe(10);
    expect(result.value.offset).toBe(5);
  });

  it("rejects empty query", () => {
    const result = validateSearchInput({ query: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects missing query", () => {
    const result = validateSearchInput({});
    expect(result.ok).toBe(false);
  });

  it("rejects whitespace-only query", () => {
    const result = validateSearchInput({ query: "   " });
    expect(result.ok).toBe(false);
  });

  it("trims query whitespace", () => {
    const result = validateSearchInput({ query: "  test  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.query).toBe("test");
  });

  it("rejects invalid type", () => {
    const result = validateSearchInput({ query: "test", type: "invalid" });
    expect(result.ok).toBe(false);
  });

  it("rejects limit of 0", () => {
    const result = validateSearchInput({ query: "test", limit: 0 });
    expect(result.ok).toBe(false);
  });

  it("rejects limit over 100", () => {
    const result = validateSearchInput({ query: "test", limit: 101 });
    expect(result.ok).toBe(false);
  });

  it("rejects negative offset", () => {
    const result = validateSearchInput({ query: "test", offset: -1 });
    expect(result.ok).toBe(false);
  });

  it("returns error with VALIDATION_FAILED code", () => {
    const result = validateSearchInput({ query: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
