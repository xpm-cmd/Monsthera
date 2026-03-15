import { describe, it, expect } from "vitest";
import { generateSummary, generateRawSummary, generateMarkdownSummary } from "../../../src/indexing/summary.js";
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
      references: [],
      lineCount: 20,
      leadingComment: "",
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

    const result: ParseResult = { symbols, imports: [], references: [], lineCount: 50, leadingComment: "" };
    const summary = generateSummary("vars.ts", result);
    expect(summary).toContain("(+5 more)");
  });

  it("handles empty parse result", () => {
    const result: ParseResult = { symbols: [], imports: [], references: [], lineCount: 1, leadingComment: "" };
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

describe("generateMarkdownSummary", () => {
  it("extracts headings from markdown", () => {
    const content = "# Title\n\nSome text\n\n## Section A\n\nMore text\n\n### Subsection";
    const result = generateMarkdownSummary("README.md", content);
    expect(result.headings).toEqual(["Title", "Section A", "Subsection"]);
    expect(result.summary).toContain("Headings: Title, Section A, Subsection");
  });

  it("strips markdown syntax from body text", () => {
    const content = "# Title\n\nSome **bold** and [link](http://x.com) text.";
    const result = generateMarkdownSummary("doc.md", content);
    expect(result.summary).toContain("Some bold and link text.");
  });

  it("truncates body to 500 chars", () => {
    const content = "# Title\n\n" + "A".repeat(600);
    const result = generateMarkdownSummary("long.md", content);
    // Body snippet should be at most 500 chars
    const bodyPart = result.summary.split(" | ").pop()!;
    expect(bodyPart.length).toBeLessThanOrEqual(500);
  });

  it("handles markdown with no headings", () => {
    const content = "Just plain text\nwith no headings.";
    const result = generateMarkdownSummary("plain.md", content);
    expect(result.headings).toEqual([]);
    expect(result.summary).toContain("2 lines");
    expect(result.summary).toContain("Just plain text");
  });

  it("handles empty markdown", () => {
    const result = generateMarkdownSummary("empty.md", "");
    expect(result.headings).toEqual([]);
    expect(result.summary).toContain("1 lines");
  });

  it("removes image references from body", () => {
    const content = "# Doc\n\nHere is ![alt text](image.png) in a paragraph.";
    const result = generateMarkdownSummary("doc.md", content);
    expect(result.summary).toContain("Here is  in a paragraph.");
    expect(result.summary).not.toContain("image.png");
  });
});
