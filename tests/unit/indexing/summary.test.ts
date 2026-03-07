import { describe, it, expect } from "vitest";
import { generateSummary, generateRawSummary } from "../../../src/indexing/summary.js";
import type { ParseResult } from "../../../src/indexing/parser.js";

describe("generateSummary", () => {
  it("includes class, function, and type counts", () => {
    const result: ParseResult = {
      symbols: [
        { name: "MyClass", kind: "class", line: 0 },
        { name: "getData", kind: "method", line: 5 },
        { name: "helper", kind: "function", line: 10 },
        { name: "Config", kind: "type", line: 15 },
      ],
      imports: [{ source: "node:fs", kind: "import" }],
      lineCount: 20,
    };

    const summary = generateSummary("src/index.ts", result);
    expect(summary).toContain("Classes: MyClass");
    expect(summary).toContain("Functions: helper");
    expect(summary).toContain("Methods: getData");
    expect(summary).toContain("Types: Config");
    expect(summary).toContain("20 lines");
    expect(summary).toContain("1 imports");
  });

  it("truncates long variable lists", () => {
    const symbols = Array.from({ length: 15 }, (_, i) => ({
      name: `var${i}`,
      kind: "variable" as const,
      line: i,
    }));

    const result: ParseResult = { symbols, imports: [], lineCount: 50 };
    const summary = generateSummary("vars.ts", result);
    expect(summary).toContain("(+5 more)");
  });

  it("handles empty parse result", () => {
    const result: ParseResult = { symbols: [], imports: [], lineCount: 1 };
    const summary = generateSummary("empty.ts", result);
    expect(summary).toBe("1 lines");
  });
});

describe("generateRawSummary", () => {
  it("generates summary for unparseable files", () => {
    const content = "line1\nline2\nline3";
    const summary = generateRawSummary("data.json", content);
    expect(summary).toContain("3 lines");
    expect(summary).toContain(".json");
  });
});
