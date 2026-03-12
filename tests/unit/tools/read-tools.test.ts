import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "../../../src/tools/read-tools.js";

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<any>>();

  tool(name: string, _description: string, _schema: object, handler: (input: unknown) => Promise<any>) {
    this.handlers.set(name, handler);
  }
}

describe("read tool discovery", () => {
  let server: FakeServer;
  const tempDirs: string[] = [];

  beforeEach(() => {
    server = new FakeServer();
    registerReadTools(server as unknown as McpServer, async () => ({
      repoId: 1,
      repoPath: "/test",
      config: {
        coordinationTopology: "hub-spoke",
        debugLogging: false,
      },
      searchRouter: {
        getSemanticReranker: () => null,
      },
    } as any));
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  it("lists the full registered tool surface in capabilities", async () => {
    const result = await handler("capabilities")({});
    const payload = JSON.parse(result.content[0].text);

    expect(payload.tools).toEqual(expect.arrayContaining([
      "send_coordination",
      "poll_coordination",
      "list_patches",
      "list_notes",
      "end_session",
      "search_tickets",
      "analyze_complexity",
      "analyze_test_coverage",
      "lookup_dependencies",
    ]));
    expect(payload.repoAgents).toEqual([]);
    expect(payload.availableReviewRoles).toEqual({
      architect: [],
      simplifier: [],
      security: [],
      performance: [],
      patterns: [],
    });
    expect(payload.agentIdentity).toEqual({
      fields: ["provider", "model", "modelFamily", "modelVersion", "identitySource"],
      identitySources: ["self_declared", "config", "peer_asserted", "system_assigned"],
      uniquenessKey: "provider+model",
      strictDiversityEligibility: "requires both provider and model",
    });
  });

  it("describes required actor fields for protected knowledge and coordination tools", async () => {
    const storeKnowledge = await handler("schema")({ toolName: "store_knowledge" });
    const pollCoordination = await handler("schema")({ toolName: "poll_coordination" });
    const endSession = await handler("schema")({ toolName: "end_session" });
    const requestReindex = await handler("schema")({ toolName: "request_reindex" });
    const listPatches = await handler("schema")({ toolName: "list_patches" });
    const listNotes = await handler("schema")({ toolName: "list_notes" });
    const searchTickets = await handler("schema")({ toolName: "search_tickets" });
    const analyzeComplexity = await handler("schema")({ toolName: "analyze_complexity" });
    const analyzeTestCoverage = await handler("schema")({ toolName: "analyze_test_coverage" });
    const registerAgent = await handler("schema")({ toolName: "register_agent" });

    expect(JSON.parse(storeKnowledge.content[0].text).inputSchema).toMatchObject({
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(pollCoordination.content[0].text).inputSchema).toMatchObject({
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(endSession.content[0].text).inputSchema).toMatchObject({
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(requestReindex.content[0].text).inputSchema).toMatchObject({
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(listPatches.content[0].text).inputSchema).toMatchObject({
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(listNotes.content[0].text).inputSchema).toMatchObject({
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(searchTickets.content[0].text).inputSchema).toMatchObject({
      agentId: "string (required)",
      sessionId: "string (required)",
      query: "string (1-1000 chars)",
    });
    expect(JSON.parse(analyzeComplexity.content[0].text).inputSchema).toMatchObject({
      filePath: "string (file path relative to repo root, required)",
    });
    expect(JSON.parse(analyzeTestCoverage.content[0].text).inputSchema).toMatchObject({
      filePath: "string (file path relative to repo root, required)",
    });
    expect(JSON.parse(registerAgent.content[0].text).inputSchema).toMatchObject({
      provider: "string (optional normalized provider)",
      model: "string (optional normalized model)",
      modelFamily: "string (optional model family)",
      modelVersion: "string (optional model version)",
      identitySource: "enum: self_declared|config|peer_asserted|system_assigned (optional)",
    });
  });

  it("keeps note schemas aligned with the supported note types", async () => {
    const proposeNote = await handler("schema")({ toolName: "propose_note" });
    const listNotes = await handler("schema")({ toolName: "list_notes" });

    expect(JSON.parse(proposeNote.content[0].text).inputSchema.type).toContain("runbook");
    expect(JSON.parse(proposeNote.content[0].text).inputSchema.type).toContain("file_summary");
    expect(JSON.parse(listNotes.content[0].text).inputSchema.type).not.toContain("rationale");
  });

  it("surfaces repo agent manifests in capabilities output", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "agora-read-tools-"));
    tempDirs.push(repoPath);
    const agentDir = join(repoPath, ".agora", "agents");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "security.md"),
      `---
name: Security Reviewer
description: Reviews trust boundaries and auth flows
role: reviewer
reviewRole: security
tags:
  - auth
---
Inspect auth and trust surfaces.
`,
      "utf-8",
    );

    const scopedServer = new FakeServer();
    registerReadTools(scopedServer as unknown as McpServer, async () => ({
      repoId: 1,
      repoPath,
      config: {
        coordinationTopology: "hub-spoke",
        debugLogging: false,
      },
      searchRouter: {
        getSemanticReranker: () => null,
      },
    } as any));

    const result = await scopedServer.handlers.get("capabilities")!({});
    const payload = JSON.parse(result.content[0].text);

    expect(payload.repoAgents).toEqual([
      {
        name: "Security Reviewer",
        description: "Reviews trust boundaries and auth flows",
        filePath: ".agora/agents/security.md",
        role: "reviewer",
        reviewRole: "security",
        tags: ["auth"],
      },
    ]);
    expect(payload.availableReviewRoles.security).toEqual(["Security Reviewer"]);
    expect(payload.repoAgentWarnings).toEqual([]);
  });
});
