import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDispatchRulesPath,
  loadDispatchRules,
  matchesDispatchPattern,
  parseDispatchRulesYaml,
  suggestActionsForChanges,
} from "../../../src/dispatch/rules.js";

describe("dispatch rules", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("falls back to built-in advisory rules when no repo file exists", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "agora-dispatch-builtins-"));
    tempDirs.push(repoPath);

    const result = suggestActionsForChanges(
      ["src/db/queries.ts", "tests/unit/tools/tool-manifest.test.ts", "package.json"],
      repoPath,
    );

    expect(result.advisoryOnly).toBe(true);
    expect(result.rulesSource).toBe("builtin");
    expect(result.repoRuleFileExists).toBe(false);
    expect(result.recommendedTools).toEqual(expect.arrayContaining([
      "analyze_complexity",
      "analyze_test_coverage",
      "search_knowledge",
      "get_issue_pack",
    ]));
    expect(result.requiredRoles).toEqual(["architect", "security", "patterns"]);
    expect(result.quorumMin).toBe(3);
    expect(result.matchedRules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        selector: "src/db/**",
        matchedPaths: ["src/db/queries.ts"],
      }),
      expect.objectContaining({
        selector: "**/*.test.*",
        matchedPaths: ["tests/unit/tools/tool-manifest.test.ts"],
      }),
      expect.objectContaining({
        selector: "package.json",
        matchedPaths: ["package.json"],
      }),
    ]));
  });

  it("loads repo-local rules and unions actions and required roles", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "agora-dispatch-repo-"));
    tempDirs.push(repoPath);
    const agoraDir = join(repoPath, ".agora");
    await mkdir(agoraDir, { recursive: true });
    await writeFile(
      getDispatchRulesPath(repoPath),
      `rules:
  - pattern: "src/**/*.ts"
    actions:
      - analyze_complexity
      - lookup_dependencies
    required_roles: [architect, performance]
    reason: "Source changes should trigger dependency and complexity checks."
  - always: true
    actions: get_issue_pack
    required_roles:
      - security
    reason: "Always review issue context before dispatch."
`,
      "utf-8",
    );

    const result = suggestActionsForChanges(["./src/api/router.ts", "docs/notes.md"], repoPath);

    expect(result.rulesSource).toBe("repo");
    expect(result.repoRuleFileExists).toBe(true);
    expect(result.recommendedTools).toEqual([
      "analyze_complexity",
      "lookup_dependencies",
      "get_issue_pack",
    ]);
    expect(result.recommendedActions).toEqual(result.recommendedTools);
    expect(result.requiredRoles).toEqual(["architect", "security", "performance"]);
    expect(result.quorumMin).toBe(3);
    expect(result.reasoning).toEqual(expect.arrayContaining([
      expect.stringContaining("src/api/router.ts matched src/**/*.ts"),
      expect.stringContaining("docs/notes.md matched always"),
    ]));
  });

  it("parses supported yaml fields and inline arrays", () => {
    const parsed = parseDispatchRulesYaml(`rules:
  - pattern: "schemas/**"
    actions: [analyze_complexity, get_issue_pack]
    required_roles: [architect, security]
    reason: "Schema changes affect contracts."
`);

    expect(parsed.rules).toEqual([
      {
        pattern: "schemas/**",
        always: false,
        actions: ["analyze_complexity", "get_issue_pack"],
        required_roles: ["architect", "security"],
        reason: "Schema changes affect contracts.",
      },
    ]);
  });

  it("falls back to built-ins with warnings when repo yaml is invalid", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "agora-dispatch-invalid-"));
    tempDirs.push(repoPath);
    const agoraDir = join(repoPath, ".agora");
    await mkdir(agoraDir, { recursive: true });
    await writeFile(
      getDispatchRulesPath(repoPath),
      `not_rules:
  - pattern: "src/**"
`,
      "utf-8",
    );

    const loaded = loadDispatchRules(repoPath);

    expect(loaded.rulesSource).toBe("builtin");
    expect(loaded.repoRuleFileExists).toBe(true);
    expect(loaded.warnings).toHaveLength(2);
    expect(loaded.warnings[0]).toContain("Failed to parse");
  });

  it("matches repo-relative glob patterns including ** and single-segment wildcards", () => {
    expect(matchesDispatchPattern("src/db/schema.ts", "src/db/**")).toBe(true);
    expect(matchesDispatchPattern("tests/unit/tools/read-tools.test.ts", "**/*.test.ts")).toBe(true);
    expect(matchesDispatchPattern("tsconfig.build.json", "tsconfig*.json")).toBe(true);
    expect(matchesDispatchPattern("src/db/schema.ts", "schemas/**")).toBe(false);
  });
});
