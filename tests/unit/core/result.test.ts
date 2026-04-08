import { describe, it, expect } from "vitest";
import { ok, err, unwrap, mapResult, flatMapResult, type Result } from "../../../src/core/result.js";

describe("ok()", () => {
  it("creates a success result with ok: true", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(42);
  });

  it("creates a success result with any value type", () => {
    const result = ok({ name: "test" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ name: "test" });
  });
});

describe("err()", () => {
  it("creates a failure result with ok: false", () => {
    const error = new Error("something went wrong");
    const result = err(error);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe(error);
  });

  it("creates a failure result with any error type", () => {
    const result = err("string error");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("string error");
  });
});

describe("unwrap()", () => {
  it("returns value from ok result", () => {
    const result = ok("hello");
    expect(unwrap(result)).toBe("hello");
  });

  it("throws error from err result", () => {
    const error = new Error("oops");
    const result = err(error);
    expect(() => unwrap(result)).toThrow(error);
  });
});

describe("mapResult()", () => {
  it("transforms the value of an ok result", () => {
    const result = ok(5);
    const mapped = mapResult(result, (n) => n * 2);
    expect(mapped.ok).toBe(true);
    expect(mapped.ok && mapped.value).toBe(10);
  });

  it("passes through an err result unchanged", () => {
    const error = new Error("fail");
    const result: Result<number, Error> = err(error);
    const mapped = mapResult(result, (n) => n * 2);
    expect(mapped.ok).toBe(false);
    expect(!mapped.ok && mapped.error).toBe(error);
  });
});

describe("flatMapResult()", () => {
  it("chains ok results", () => {
    const result = ok(5);
    const chained = flatMapResult(result, (n) => ok(n + 1));
    expect(chained.ok).toBe(true);
    expect(chained.ok && chained.value).toBe(6);
  });

  it("short-circuits on err result", () => {
    const error = new Error("fail");
    const result: Result<number, Error> = err(error);
    let called = false;
    const chained = flatMapResult(result, (n) => {
      called = true;
      return ok(n + 1);
    });
    expect(called).toBe(false);
    expect(chained.ok).toBe(false);
    expect(!chained.ok && chained.error).toBe(error);
  });

  it("propagates inner err from chained function", () => {
    const innerError = new Error("inner fail");
    const result = ok(5);
    const chained = flatMapResult(result, (_n) => err(innerError));
    expect(chained.ok).toBe(false);
    expect(!chained.ok && chained.error).toBe(innerError);
  });
});

describe("type narrowing", () => {
  it("narrows to value with if (result.ok)", () => {
    const result: Result<string, Error> = ok("value");
    if (result.ok) {
      // TypeScript should allow accessing result.value here
      expect(result.value).toBe("value");
    } else {
      // This branch should not be reached
      expect.fail("Should not reach error branch");
    }
  });

  it("narrows to error with if (!result.ok)", () => {
    const error = new Error("test");
    const result: Result<string, Error> = err(error);
    if (!result.ok) {
      // TypeScript should allow accessing result.error here
      expect(result.error).toBe(error);
    } else {
      expect.fail("Should not reach ok branch");
    }
  });
});
