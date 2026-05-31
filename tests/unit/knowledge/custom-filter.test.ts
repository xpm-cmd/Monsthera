import { describe, it, expect } from "vitest";
import { parseCustomFilter, matchesCustomFilter } from "../../../src/knowledge/custom-filter.js";

// PR-14a (ADR-020 P2): `--filter custom.<key><op><value>` over the free-form
// extraFrontmatter bag. Equality is string-based; <,<=,>,>= are numeric. Only
// scalar values are filterable — objects/arrays are stored but never match
// (ADR-012: no silent coercion).
describe("parseCustomFilter (PR-14a)", () => {
  it("parses string equality", () => {
    const r = parseCustomFilter("custom.origin=human");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ key: "origin", op: "=", value: "human" });
  });

  it("parses numeric comparison and exposes the parsed number", () => {
    const r = parseCustomFilter("custom.replicability_score<0.8");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ key: "replicability_score", op: "<", value: "0.8", numeric: 0.8 });
  });

  it("matches the two-char operators <= and >= before the single-char ones", () => {
    const le = parseCustomFilter("custom.score<=5");
    const ge = parseCustomFilter("custom.score>=5");
    expect(le.ok && le.value.op).toBe("<=");
    expect(ge.ok && ge.value.op).toBe(">=");
  });

  it("treats the leftmost operator as the separator (operators inside an equality value are kept)", () => {
    const r = parseCustomFilter("custom.note=a<b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ key: "note", op: "=", value: "a<b" });
  });

  it("rejects a missing custom. prefix", () => {
    expect(parseCustomFilter("origin=human").ok).toBe(false);
  });

  it("rejects an empty key, empty value, or missing operator", () => {
    expect(parseCustomFilter("custom.=human").ok).toBe(false);
    expect(parseCustomFilter("custom.score<").ok).toBe(false);
    expect(parseCustomFilter("custom.origin").ok).toBe(false);
  });

  it("rejects a non-numeric value for a comparison operator", () => {
    expect(parseCustomFilter("custom.score<abc").ok).toBe(false);
  });
});

describe("matchesCustomFilter (PR-14a)", () => {
  const filter = (expr: string) => {
    const r = parseCustomFilter(expr);
    if (!r.ok) throw new Error(`bad test filter: ${expr}`);
    return r.value;
  };

  it("matches string equality and coerces non-string scalars to string", () => {
    expect(matchesCustomFilter({ origin: "human" }, filter("custom.origin=human"))).toBe(true);
    expect(matchesCustomFilter({ origin: "agent" }, filter("custom.origin=human"))).toBe(false);
    expect(matchesCustomFilter({ year: 2024 }, filter("custom.year=2024"))).toBe(true);
    expect(matchesCustomFilter({ flag: true }, filter("custom.flag=true"))).toBe(true);
  });

  it("compares numerically for </<=/>/>=, including numeric strings", () => {
    expect(matchesCustomFilter({ score: 0.5 }, filter("custom.score<0.8"))).toBe(true);
    expect(matchesCustomFilter({ score: 0.9 }, filter("custom.score<0.8"))).toBe(false);
    expect(matchesCustomFilter({ score: "0.5" }, filter("custom.score<0.8"))).toBe(true);
    expect(matchesCustomFilter({ n: 5 }, filter("custom.n>=5"))).toBe(true);
    expect(matchesCustomFilter({ n: 4 }, filter("custom.n>=5"))).toBe(false);
  });

  it("does not match a non-numeric scalar on a comparison operator", () => {
    expect(matchesCustomFilter({ score: "high" }, filter("custom.score<0.8"))).toBe(false);
    expect(matchesCustomFilter({ score: true }, filter("custom.score<0.8"))).toBe(false);
  });

  it("never matches non-scalar values (objects/arrays) — ADR-012 no silent coercion", () => {
    expect(matchesCustomFilter({ obj: { a: 1 } }, filter("custom.obj=x"))).toBe(false);
    expect(matchesCustomFilter({ arr: [1, 2] }, filter("custom.arr=1"))).toBe(false);
  });

  it("does not match when the key is absent or there is no custom frontmatter", () => {
    expect(matchesCustomFilter({ other: "v" }, filter("custom.origin=human"))).toBe(false);
    expect(matchesCustomFilter(undefined, filter("custom.origin=human"))).toBe(false);
  });
});
