import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTicketTemplatesPath, loadTicketTemplates } from "../../../src/tickets/templates.js";

describe("ticket templates", () => {
  it("returns an empty result when the template file does not exist", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "agora-ticket-templates-"));

    const result = loadTicketTemplates(repoPath);

    expect(result.exists).toBe(false);
    expect(result.templates).toEqual([]);
    expect(result.path).toBe(getTicketTemplatesPath(repoPath));
  });

  it("loads repo-local ticket templates from JSON", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "agora-ticket-templates-"));
    const agoraDir = join(repoPath, ".agora");
    mkdirSync(agoraDir, { recursive: true });
    writeFileSync(join(agoraDir, "ticket-templates.json"), JSON.stringify({
      templates: [{
        id: "bug-report",
        name: "Bug report",
        title: "Fix dashboard regression",
        description: "Describe the bug and expected behavior.",
        severity: "high",
        priority: 7,
        tags: ["dashboard", "bug"],
        affectedPaths: ["src/dashboard/html.ts"],
        acceptanceCriteria: "Repro no longer occurs.",
      }],
    }, null, 2));

    const result = loadTicketTemplates(repoPath);

    expect(result.exists).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toMatchObject({
      id: "bug-report",
      priority: 7,
      tags: ["dashboard", "bug"],
    });
  });

  it("surfaces parse errors without crashing the dashboard", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "agora-ticket-templates-"));
    const agoraDir = join(repoPath, ".agora");
    mkdirSync(agoraDir, { recursive: true });
    writeFileSync(join(agoraDir, "ticket-templates.json"), "{\"templates\":[{\"id\":123}]}");

    const result = loadTicketTemplates(repoPath);

    expect(result.exists).toBe(true);
    expect(result.templates).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
