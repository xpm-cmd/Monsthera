import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRepoAgentSearchSummary,
  buildRepoAgentSymbols,
  loadRepoAgentCatalog,
  parseRepoAgentManifest,
} from "../../../src/repo-agents/catalog.js";

describe("repo agent catalog", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("parses valid repo agent manifests and groups review roles", async () => {
    const repoPath = await createRepoWithAgents({
      "security.md": `---
name: Security Reviewer
description: Reviews trust boundaries and auth flows
role: reviewer
reviewRole: security
tags:
  - auth
  - security
---
# Mission

Find trust boundary violations and secret leaks.
`,
      "architect.md": `---
name: Architecture Reviewer
role: facilitator
reviewRole: architect
---
Focus on layering, abstractions, and long-term maintainability.
`,
    }, tempDirs);

    const catalog = await loadRepoAgentCatalog(repoPath);

    expect(catalog.repoAgents).toMatchObject([
      {
        name: "Architecture Reviewer",
        filePath: ".monsthera/agents/architect.md",
        role: "facilitator",
        reviewRole: "architect",
      },
      {
        name: "Security Reviewer",
        filePath: ".monsthera/agents/security.md",
        role: "reviewer",
        reviewRole: "security",
        tags: ["auth", "security"],
      },
    ]);
    expect(catalog.availableReviewRoles).toEqual({
      architect: ["Architecture Reviewer"],
      simplifier: [],
      security: ["Security Reviewer"],
      performance: [],
      patterns: [],
      design: [],
    });
    expect(catalog.warnings).toEqual([]);
  });

  it("warns and drops invalid reviewRole values without dropping the manifest", () => {
    const parsed = parseRepoAgentManifest(
      ".monsthera/agents/simplify.md",
      `---
name: Simplifier
description: Removes accidental complexity
role: reviewer
reviewRole: dx
---
Prefer smaller and clearer designs.
`,
    );

    expect(parsed.agent).toMatchObject({
      name: "Simplifier",
      role: "reviewer",
      reviewRole: null,
    });
    expect(parsed.warnings).toEqual([
      {
        filePath: ".monsthera/agents/simplify.md",
        message: "Invalid `reviewRole`; expected one of architect, simplifier, security, performance, patterns, design",
      },
    ]);
  });

  it("falls back to the file name and prompt excerpt when frontmatter is partial", () => {
    const parsed = parseRepoAgentManifest(
      ".monsthera/agents/patterns.md",
      `---
role: reviewer
reviewRole: patterns
---
Detect duplication, inconsistent naming, and local anti-patterns.
`,
    );

    expect(parsed.agent).toMatchObject({
      name: "patterns",
      description: "Detect duplication, inconsistent naming, and local anti-patterns.",
      role: "reviewer",
      reviewRole: "patterns",
    });
    expect(parsed.warnings).toEqual([]);
    expect(buildRepoAgentSearchSummary(parsed.agent!)).toContain("Review specialization: patterns");
    expect(buildRepoAgentSymbols(parsed.agent!)).toEqual([
      { name: "patterns" },
      { name: "reviewer" },
    ]);
  });

  it("warns when manifests are missing YAML frontmatter", () => {
    const parsed = parseRepoAgentManifest(
      ".monsthera/agents/security.md",
      "# Security Reviewer\n\nReview auth and trust boundaries.\n",
    );

    expect(parsed.agent).toBeNull();
    expect(parsed.warnings).toEqual([
      {
        filePath: ".monsthera/agents/security.md",
        message: "Missing or invalid YAML frontmatter",
      },
    ]);
  });
});

async function createRepoWithAgents(
  files: Record<string, string>,
  tempDirs: string[],
): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "monsthera-repo-agents-"));
  tempDirs.push(repoPath);
  const agentDir = join(repoPath, ".monsthera", "agents");
  await mkdir(agentDir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    await writeFile(join(agentDir, fileName), content, "utf-8");
  }
  return repoPath;
}
