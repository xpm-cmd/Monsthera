import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadCustomWorkflows } from "../../../src/workflows/loader.js";

describe("custom workflow loader", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("loads valid repo-local workflows and normalizes their runtime spec", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "monsthera-workflows-"));
    tempDirs.push(repoPath);
    const workflowDir = join(repoPath, ".monsthera", "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "review.yaml"), `name: repo-review
description: Review repo-local changes
params: [sinceCommit]
defaults:
  verbosity: compact
steps:
  - tool: get_change_pack
    input: { sinceCommit: "{{params.sinceCommit}}", verbosity: "{{params.verbosity}}" }
    output: changes
  - tool: suggest_actions
    input:
      changedPaths: "{{steps.changes.changedFiles.path}}"
    output: suggestions
`, "utf-8");

    const result = await loadCustomWorkflows(repoPath);

    expect(result.warnings).toEqual([]);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]).toMatchObject({
      name: "custom:repo-review",
      localName: "repo-review",
      filePath: ".monsthera/workflows/review.yaml",
      tools: ["get_change_pack", "suggest_actions"],
      spec: {
        name: "custom:repo-review",
        requiredParams: ["sinceCommit"],
        defaults: { verbosity: "compact" },
      },
    });
    expect(result.workflows[0]?.spec.steps[0]).toMatchObject({
      key: "changes",
      tool: "get_change_pack",
      input: {
        sinceCommit: "{{params.sinceCommit}}",
        verbosity: "{{params.verbosity}}",
      },
    });
  });

  it("warns and skips invalid or unsupported workflow definitions", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "monsthera-workflows-"));
    tempDirs.push(repoPath);
    const workflowDir = join(repoPath, ".monsthera", "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "invalid.yaml"), `name: broken
steps: nope
`, "utf-8");
    await writeFile(join(workflowDir, "unknown-tool.yaml"), `name: missing-tool
steps:
  - tool: not_a_real_tool
    input: {}
    output: result
`, "utf-8");

    const result = await loadCustomWorkflows(repoPath);

    expect(result.workflows).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: ".monsthera/workflows/invalid.yaml",
      }),
      expect.objectContaining({
        filePath: ".monsthera/workflows/unknown-tool.yaml",
        message: "Unknown workflow tool `not_a_real_tool`",
      }),
    ]));
  });

  it("parses quorum checkpoint steps from repo-local YAML workflows", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "monsthera-workflows-"));
    tempDirs.push(repoPath);
    const workflowDir = join(repoPath, ".monsthera", "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "gated.yaml"), `name: gated-review
params: [ticketId]
steps:
  - type: quorum_checkpoint
    input:
      ticketId: "{{params.ticketId}}"
      timeout: 30
      onFail: continue_with_warning
    output: quorum
`, "utf-8");

    const result = await loadCustomWorkflows(repoPath);

    expect(result.warnings).toEqual([]);
    expect(result.workflows[0]?.spec.steps[0]).toMatchObject({
      key: "quorum",
      type: "quorum_checkpoint",
      tool: "quorum_checkpoint",
      input: {
        ticketId: "{{params.ticketId}}",
        timeout: 30,
        onFail: "continue_with_warning",
      },
    });
  });

  it("ships a deep council-loop workflow in the repo", async () => {
    const result = await loadCustomWorkflows(process.cwd());

    expect(result.warnings.filter((warning) => warning.filePath === ".monsthera/workflows/council-loop.yaml")).toEqual([]);

    const workflow = result.workflows.find((entry) => entry.localName === "council-loop");
    expect(workflow).toBeDefined();
    expect(workflow?.filePath).toBe(".monsthera/workflows/council-loop.yaml");
    expect(workflow?.tools).toEqual(expect.arrayContaining([
      "get_ticket",
      "get_change_pack",
      "get_issue_pack",
      "get_code_pack",
      "analyze_complexity",
      "analyze_test_coverage",
      "suggest_actions",
      "comment_ticket",
      "assign_council",
      "submit_verdict",
      "check_consensus",
    ]));
    expect(workflow?.spec.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "issuePack",
        tool: "get_issue_pack",
      }),
      expect.objectContaining({
        key: "codePack",
        tool: "get_code_pack",
      }),
      expect.objectContaining({
        key: "pathCodePacks",
        tool: "get_code_pack",
        forEach: "steps.ticket.affectedPaths",
        onError: "continue",
      }),
      expect.objectContaining({
        key: "complexity",
        tool: "analyze_complexity",
        forEach: "steps.ticket.affectedPaths",
        onError: "continue",
      }),
      expect.objectContaining({
        key: "coverage",
        tool: "analyze_test_coverage",
        forEach: "steps.ticket.affectedPaths",
        onError: "continue",
      }),
      expect.objectContaining({
        key: "reviewNote",
        tool: "comment_ticket",
        condition: "!steps.consensus.advisoryReady",
      }),
      expect.objectContaining({
        key: "verdict",
        tool: "submit_verdict",
      }),
    ]));
  });
});
