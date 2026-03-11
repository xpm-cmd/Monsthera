import { describe, it, expect } from "vitest";
import { isConfigFile, isTestRelatedQuery, sanitizeFts5Query } from "../../../src/search/fts5.js";

describe("sanitizeFts5Query", () => {
  it("returns empty for whitespace-only input", () => {
    expect(sanitizeFts5Query("")).toBe("");
    expect(sanitizeFts5Query("   ")).toBe("");
    expect(sanitizeFts5Query("\t\n")).toBe("");
  });

  it("preserves special chars inside FTS5 quoted terms", () => {
    const result = sanitizeFts5Query("onClick={handler}");
    // Should keep {, }, = inside quotes — not strip them
    expect(result).toContain("onClick={handler}");
  });

  it("allows single uppercase identifiers", () => {
    const result = sanitizeFts5Query("T x Y");
    // T and Y (uppercase) should be kept; x (lowercase) dropped
    expect(result).toContain('"T"');
    expect(result).toContain('"Y"');
    expect(result).not.toContain('"x"');
  });

  it("allows underscore as single-char term", () => {
    const result = sanitizeFts5Query("_ foo");
    expect(result).toContain('"_"');
  });

  it("supports phrase queries", () => {
    const result = sanitizeFts5Query('"exact phrase" other');
    expect(result).toContain('"exact phrase"');
    expect(result).toContain('"other"');
  });

  it("uses AND for 1-3 terms", () => {
    expect(sanitizeFts5Query("one two")).toBe('"one" AND "two"');
    expect(sanitizeFts5Query("one two three")).toBe('"one" AND "two" AND "three"');
  });

  it("uses OR for 4+ terms", () => {
    const result = sanitizeFts5Query("update user profile settings");
    expect(result).toContain(" OR ");
    expect(result).not.toContain(" AND ");
  });

  it("strips stop words", () => {
    const result = sanitizeFts5Query("the createServer");
    expect(result).toBe('"createServer"');
  });

  it("strips trailing * (FTS5 prefix operator)", () => {
    const result = sanitizeFts5Query("serv*");
    expect(result).toBe('"serv"');
  });

  it("escapes double quotes inside terms", () => {
    // Edge case: term containing literal quote
    const result = sanitizeFts5Query('say"hello');
    expect(result).toContain('""');
  });

  it("splits on colons for key:value patterns", () => {
    const result = sanitizeFts5Query("map:hooks");
    expect(result).toContain('"map"');
    expect(result).toContain('"hooks"');
  });

  it("counts phrases toward AND/OR threshold", () => {
    // 1 phrase + 1 term = 2 terms total → AND
    const result = sanitizeFts5Query('"exact match" other');
    expect(result).toContain(" AND ");
  });

  it("detects broader test-related query vocabulary", () => {
    expect(isTestRelatedQuery("unit testing dashboard search")).toBe(true);
    expect(isTestRelatedQuery("e2e workflow spec")).toBe(true);
    expect(isTestRelatedQuery("dashboard metrics")).toBe(false);
  });

  it("recognizes common config and build files", () => {
    expect(isConfigFile("Dockerfile")).toBe(true);
    expect(isConfigFile("Makefile")).toBe(true);
    expect(isConfigFile(".github/workflows/ci.yml")).toBe(true);
    expect(isConfigFile("package.json")).toBe(true);
  });
});
