import { describe, expect, it } from "vitest";
import {
  COMPLEXITY_METHODOLOGY_VERSION,
  analyzeComplexityContent,
} from "../../../src/analysis/complexity.js";

describe("complexity analysis", () => {
  it("computes stable TypeScript file metrics from nested control flow", async () => {
    const content = [
      "export function analyze(value: number) {",
      "  if (value > 0) {",
      "    for (let index = 0; index < value; index += 1) {",
      "      while (index < value - 1) {",
      "        break;",
      "      }",
      "    }",
      "  }",
      "}",
      "",
      "class Worker {",
      "  run() {",
      "    return \"ok\";",
      "  }",
      "}",
    ].join("\n");

    const result = await analyzeComplexityContent("src/example.ts", content, "typescript");

    expect(result.methodologyVersion).toBe(COMPLEXITY_METHODOLOGY_VERSION);
    expect(result.syntaxErrorsPresent).toBe(false);
    expect(result.metrics).toEqual({
      loc: 15,
      nonEmptyLines: 14,
      functionCount: 2,
      classCount: 1,
      branchPoints: 3,
      maxNesting: 3,
      cyclomaticLike: 4,
    });
  });

  it("computes language-specific branch and nesting counts for Python", async () => {
    const content = [
      "def scan(values):",
      "    for value in values:",
      "        if value > 0:",
      "            break",
    ].join("\n");

    const result = await analyzeComplexityContent("src/example.py", content, "python");

    expect(result.syntaxErrorsPresent).toBe(false);
    expect(result.metrics).toEqual({
      loc: 4,
      nonEmptyLines: 4,
      functionCount: 1,
      classCount: 0,
      branchPoints: 2,
      maxNesting: 2,
      cyclomaticLike: 3,
    });
  });
});
