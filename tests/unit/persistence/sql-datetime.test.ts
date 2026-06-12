import { describe, it, expect } from "vitest";
import { toIsoTimestamp } from "../../../src/persistence/sql-datetime.js";

describe("toIsoTimestamp", () => {
  it("converts a driver Date to the ISO instant", () => {
    expect(toIsoTimestamp(new Date("2026-06-11T13:02:54.500Z"))).toBe(
      "2026-06-11T13:02:54.500Z",
    );
  });

  it("reinterprets MySQL wall-clock digits as UTC", () => {
    expect(toIsoTimestamp("2026-06-11 13:02:54.500")).toBe("2026-06-11T13:02:54.500Z");
  });

  it("normalizes second-precision digits to a full ISO timestamp", () => {
    expect(toIsoTimestamp("2026-06-11 13:02:54")).toBe("2026-06-11T13:02:54.000Z");
  });

  it("passes ISO-Z strings through unchanged", () => {
    expect(toIsoTimestamp("2026-06-11T13:02:54.500Z")).toBe("2026-06-11T13:02:54.500Z");
  });
});
