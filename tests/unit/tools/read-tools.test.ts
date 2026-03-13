import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import {
  registerReadTools,
  shapeChangePackResult,
  shapeCodePackResult,
  shapeIssuePackResult,
} from "../../../src/tools/read-tools.js";

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
      "run_workflow",
      "send_coordination",
      "poll_coordination",
      "list_patches",
      "list_notes",
      "end_session",
      "search_tickets",
      "assign_council",
      "submit_verdict",
      "check_consensus",
      "analyze_complexity",
      "analyze_test_coverage",
      "suggest_actions",
      "list_protected_artifacts",
      "lookup_dependencies",
    ]));
    expect(payload.workflows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "onboard" }),
      expect.objectContaining({ name: "deep-review" }),
    ]));
    expect(payload.repoAgents).toEqual([]);
    expect(payload.availableReviewRoles).toEqual({
      architect: [],
      simplifier: [],
      security: [],
      performance: [],
      patterns: [],
      design: [],
    });
    expect(payload.agentIdentity).toEqual({
      fields: ["provider", "model", "modelFamily", "modelVersion", "identitySource"],
      identitySources: ["self_declared", "config", "peer_asserted", "system_assigned"],
      uniquenessKey: "provider+model",
      strictDiversityEligibility: "requires both provider and model",
    });
    expect(payload.customWorkflows).toEqual([]);
    expect(payload.customWorkflowWarnings).toEqual([]);
  });

  it("describes required actor fields for protected knowledge and coordination tools", async () => {
    const storeKnowledge = await handler("schema")({ toolName: "store_knowledge" });
    const pollCoordination = await handler("schema")({ toolName: "poll_coordination" });
    const endSession = await handler("schema")({ toolName: "end_session" });
    const requestReindex = await handler("schema")({ toolName: "request_reindex" });
    const listPatches = await handler("schema")({ toolName: "list_patches" });
    const listNotes = await handler("schema")({ toolName: "list_notes" });
    const searchTickets = await handler("schema")({ toolName: "search_tickets" });
    const runWorkflow = await handler("schema")({ toolName: "run_workflow" });
    const analyzeComplexity = await handler("schema")({ toolName: "analyze_complexity" });
    const analyzeTestCoverage = await handler("schema")({ toolName: "analyze_test_coverage" });
    const suggestActions = await handler("schema")({ toolName: "suggest_actions" });
    const listProtectedArtifacts = await handler("schema")({ toolName: "list_protected_artifacts" });
    const registerAgent = await handler("schema")({ toolName: "register_agent" });
    const createTicket = await handler("schema")({ toolName: "create_ticket" });
    const updateTicket = await handler("schema")({ toolName: "update_ticket" });
    const commentTicket = await handler("schema")({ toolName: "comment_ticket" });
    const assignCouncil = await handler("schema")({ toolName: "assign_council" });
    const submitVerdict = await handler("schema")({ toolName: "submit_verdict" });
    const checkConsensus = await handler("schema")({ toolName: "check_consensus" });
    const updateTicketStatus = await handler("schema")({ toolName: "update_ticket_status" });

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
    expect(JSON.parse(runWorkflow.content[0].text).inputSchema).toMatchObject({
      name: "string (built-in: onboard|deep-review|ta-review|deep-review-v2; custom: custom:<name>)",
      params: "object (optional workflow parameters)",
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(analyzeComplexity.content[0].text).inputSchema).toMatchObject({
      filePath: "string (file path relative to repo root, required)",
    });
    expect(JSON.parse(analyzeTestCoverage.content[0].text).inputSchema).toMatchObject({
      filePath: "string (file path relative to repo root, required)",
    });
    expect(JSON.parse(suggestActions.content[0].text).inputSchema).toMatchObject({
      changedPaths: "string[] (repo-relative changed file paths, required)",
    });
    expect(JSON.parse(listProtectedArtifacts.content[0].text).inputSchema).toMatchObject({
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(registerAgent.content[0].text).inputSchema).toMatchObject({
      provider: "string (optional normalized provider)",
      model: "string (optional normalized model)",
      modelFamily: "string (optional model family)",
      modelVersion: "string (optional model version)",
      identitySource: "enum: self_declared|config|peer_asserted|system_assigned (optional)",
    });
    expect(JSON.parse(createTicket.content[0].text).inputSchema).toMatchObject({
      acceptanceCriteria: "string (optional, max 8000)",
    });
    expect(JSON.parse(updateTicket.content[0].text).inputSchema).toMatchObject({
      acceptanceCriteria: "string (optional, max 8000)",
    });
    expect(JSON.parse(commentTicket.content[0].text).inputSchema).toMatchObject({
      content: "string (1-8000 chars)",
    });
    expect(JSON.parse(assignCouncil.content[0].text).inputSchema).toMatchObject({
      ticketId: "string (TKT-...)",
      councilAgentId: "string (required)",
      specialization: "enum: architect|simplifier|security|performance|patterns|design",
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(submitVerdict.content[0].text).inputSchema).toMatchObject({
      specialization: "enum: architect|simplifier|security|performance|patterns|design",
      verdict: "enum: pass|fail|abstain",
      reasoning: "string (optional, max 8000)",
      transition: "enum: technical_analysis→approved|in_review→ready_for_commit (optional)",
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(checkConsensus.content[0].text).inputSchema).toMatchObject({
      ticketId: "string (TKT-...)",
      transition: "enum: technical_analysis→approved|in_review→ready_for_commit (optional)",
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(updateTicketStatus.content[0].text).inputSchema).toMatchObject({
      skipKnowledgeCapture: "boolean (optional, only relevant for resolved|closed transitions)",
    });

    const codePack = await handler("schema")({ toolName: "get_code_pack" });
    const changePack = await handler("schema")({ toolName: "get_change_pack" });
    const issuePack = await handler("schema")({ toolName: "get_issue_pack" });

    expect(JSON.parse(codePack.content[0].text).inputSchema.verbosity).toBe(
      "enum: full|compact|minimal (default full)",
    );
    expect(JSON.parse(changePack.content[0].text).inputSchema.verbosity).toBe(
      "enum: full|compact|minimal (default full)",
    );
    expect(JSON.parse(issuePack.content[0].text).inputSchema.verbosity).toBe(
      "enum: full|compact|minimal (default full)",
    );
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

  it("includes custom repo-local workflows in capabilities and run_workflow schema discovery", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "agora-read-tools-"));
    tempDirs.push(repoPath);
    const workflowDir = join(repoPath, ".agora", "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, "review.yaml"),
      `name: repo-review
description: Repo local workflow
steps:
  - tool: get_change_pack
    input: {}
    output: changes
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

    const capabilities = await scopedServer.handlers.get("capabilities")!({});
    const schema = await scopedServer.handlers.get("schema")!({ toolName: "run_workflow" });
    const capabilitiesPayload = JSON.parse(capabilities.content[0].text);
    const schemaPayload = JSON.parse(schema.content[0].text);

    expect(capabilitiesPayload.customWorkflows).toEqual([
      expect.objectContaining({
        name: "custom:repo-review",
        filePath: ".agora/workflows/review.yaml",
        source: "custom",
      }),
    ]);
    expect(capabilitiesPayload.workflows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "custom:repo-review" }),
    ]));
    expect(schemaPayload.inputSchema).toMatchObject({
      name: "string (built-in: onboard|deep-review|ta-review|deep-review-v2; custom: custom:repo-review)",
    });
  });

  it("runs suggest_actions against repo-local dispatch rules", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "agora-dispatch-rules-"));
    tempDirs.push(repoPath);
    const agoraDir = join(repoPath, ".agora");
    await mkdir(agoraDir, { recursive: true });
    await writeFile(
      join(agoraDir, "dispatch-rules.yaml"),
      `rules:
  - pattern: "src/db/**"
    actions:
      - analyze_complexity
      - lookup_dependencies
    required_roles:
      - architect
      - security
    reason: "Database changes need deeper review."
  - always: true
    actions: get_issue_pack
    required_roles: patterns
    reason: "Always collect related issue context."
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

    const result = await scopedServer.handlers.get("suggest_actions")!({
      changedPaths: ["src/db/schema.ts", "docs/architecture.md"],
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.advisoryOnly).toBe(true);
    expect(payload.rulesSource).toBe("repo");
    expect(payload.repoRuleFileExists).toBe(true);
    expect(payload.recommendedTools).toEqual(expect.arrayContaining([
      "analyze_complexity",
      "lookup_dependencies",
      "get_issue_pack",
    ]));
    expect(payload.requiredRoles).toEqual(["architect", "security", "patterns"]);
    expect(payload.quorumMin).toBe(3);
    expect(payload.matchedRules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        selector: "src/db/**",
        matchedPaths: ["src/db/schema.ts"],
      }),
      expect.objectContaining({
        selector: "always",
        matchedPaths: ["src/db/schema.ts", "docs/architecture.md"],
      }),
    ]));
  });
});

describe("suggest_next_work", () => {
  function createSuggestDb() {
    const sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT);
      CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    const db = drizzle(sqlite, { schema });
    queries.upsertRepo(db, "/test", "test");
    return { db, sqlite };
  }

  function insertAgentSession(db: ReturnType<typeof createSuggestDb>["db"], agentId: string, sessionId: string, claimedFiles: string[]) {
    const now = new Date().toISOString();
    queries.upsertAgent(db, {
      id: agentId,
      name: agentId,
      type: "test",
      roleId: "developer",
      trustTier: "A",
      registeredAt: now,
    });
    queries.insertSession(db, {
      id: sessionId,
      agentId,
      state: "active",
      connectedAt: now,
      lastActivity: now,
    });
    queries.updateSessionClaims(db, sessionId, claimedFiles);
  }

  function insertApprovedTicket(
    sqlite: InstanceType<typeof Database>,
    ticketId: string,
    title: string,
    priority: number,
    affectedPaths: string[],
  ) {
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO tickets (
        repo_id, ticket_id, title, description, status, severity, priority,
        tags_json, affected_paths_json, creator_agent_id, creator_session_id,
        assignee_agent_id, resolved_by_agent_id, commit_sha, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      1,
      ticketId,
      title,
      "Desc",
      "approved",
      "high",
      priority,
      "[]",
      JSON.stringify(affectedPaths),
      "agent-dev",
      "session-dev",
      null,
      null,
      "abc1234",
      now,
      now,
    );
  }

  function setupSuggestServer(db: ReturnType<typeof createSuggestDb>["db"]) {
    const server = new FakeServer();
    registerReadTools(server as unknown as McpServer, async () => ({
      db,
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
    return server.handlers.get("suggest_next_work")!;
  }

  it("returns a clear match when one ticket has the strongest overlap and ranking", async () => {
    const { db, sqlite } = createSuggestDb();
    try {
      insertAgentSession(db, "agent-dev", "session-dev", ["src/auth/index.ts"]);
      insertApprovedTicket(sqlite, "TKT-auth", "Auth work", 8, ["src/auth"]);
      insertApprovedTicket(sqlite, "TKT-ui", "UI work", 10, ["src/ui"]);

      const suggestNextWork = setupSuggestServer(db);
      const result = await suggestNextWork({ agentId: "agent-dev", sessionId: "session-dev", limit: 5 });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.match).toMatchObject({ kind: "clear_match" });
      expect(payload.routingRecommendation).toMatchObject({ action: "recommend", ticketId: "TKT-auth" });
      expect(payload.suggestions[0]).toMatchObject({
        ticketId: "TKT-auth",
        matchKind: "clear_match",
        overlapScore: 1,
      });
    } finally {
      sqlite.close();
    }
  });

  it("flags ambiguous matches when multiple tickets tie for the top score", async () => {
    const { db, sqlite } = createSuggestDb();
    try {
      insertAgentSession(db, "agent-dev", "session-dev", ["src/shared/button.ts"]);
      insertApprovedTicket(sqlite, "TKT-shared-a", "Shared A", 7, ["src/shared"]);
      insertApprovedTicket(sqlite, "TKT-shared-b", "Shared B", 7, ["src/shared/button.ts"]);

      const suggestNextWork = setupSuggestServer(db);
      const result = await suggestNextWork({ agentId: "agent-dev", sessionId: "session-dev", limit: 5 });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.match).toMatchObject({ kind: "ambiguous_match" });
      expect(payload.routingRecommendation).toMatchObject({
        action: "review_manually",
        ticketIds: ["TKT-shared-a", "TKT-shared-b"],
      });
      expect(payload.suggestions.slice(0, 2).map((entry: any) => entry.matchKind)).toEqual([
        "ambiguous_match",
        "ambiguous_match",
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("reports no_match when claimed files do not overlap approved work", async () => {
    const { db, sqlite } = createSuggestDb();
    try {
      insertAgentSession(db, "agent-dev", "session-dev", ["src/api/client.ts"]);
      insertApprovedTicket(sqlite, "TKT-ui", "UI work", 8, ["src/ui"]);
      insertApprovedTicket(sqlite, "TKT-docs", "Docs work", 6, ["docs"]);

      const suggestNextWork = setupSuggestServer(db);
      const result = await suggestNextWork({ agentId: "agent-dev", sessionId: "session-dev", limit: 5 });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.match).toMatchObject({ kind: "no_match" });
      expect(payload.routingRecommendation).toMatchObject({ action: "review_manually", confidence: "low" });
      expect(payload.suggestions[0]).toMatchObject({ matchKind: "no_match", overlapScore: 0 });
    } finally {
      sqlite.close();
    }
  });
});

describe("read tool verbosity shaping", () => {
  it("keeps full code packs backward-compatible and strips heavy fields in compact/minimal modes", () => {
    const payload = {
      bundleId: "bundle-1",
      repoId: "1",
      commit: "abc1234",
      query: "router",
      timestamp: "2026-03-12T00:00:00.000Z",
      trustTier: "A" as const,
      redactionPolicy: "none" as const,
      searchBackend: "fts5" as const,
      latencyMs: 12,
      rankingMetadata: { scoringWeights: { relevance: 1 } },
      currentHead: "abc1234",
      indexStale: false,
      candidates: Array.from({ length: 6 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        language: "ts",
        relevanceScore: 1 - index * 0.1,
        summary: `Summary ${index}`.repeat(30),
        symbols: [{ name: `fn${index}`, kind: "function", line: index + 1 }],
        provenance: "search_hit" as const,
      })),
      expanded: [{
        path: "src/file-0.ts",
        language: "ts",
        relevanceScore: 1,
        summary: "Expanded",
        symbols: [],
        provenance: "search_hit" as const,
        codeSpan: "const x = 1;",
        spanLines: { start: 1, end: 1 },
        changeRefs: [],
        relatedNotes: [],
        redactionApplied: false,
      }],
    };

    expect(shapeCodePackResult(payload, "full")).toBe(payload);

    const compact = shapeCodePackResult(payload, "compact") as Record<string, any>;
    expect(compact.verbosity).toBe("compact");
    expect(compact.candidateCount).toBe(6);
    expect(compact.candidatesTruncated).toBe(true);
    expect(compact.candidates).toHaveLength(5);
    expect(compact.candidates[0]).not.toHaveProperty("symbols");
    expect(compact.expanded).toEqual([]);

    const minimal = shapeCodePackResult(payload, "minimal") as Record<string, any>;
    expect(minimal.verbosity).toBe("minimal");
    expect(minimal.candidates).toHaveLength(3);
    expect(minimal.candidates[0]).not.toHaveProperty("relevanceScore");
    expect(minimal.expanded).toEqual([]);
  });

  it("drops diff bodies and truncates deterministic slices for change packs", () => {
    const payload = {
      currentHead: "head",
      sinceCommit: "base",
      changedFiles: Array.from({ length: 21 }, (_, index) => ({
        status: "M",
        path: `src/file-${index}.ts`,
        language: "ts",
        summary: `Changed file ${index}`.repeat(20),
        hasSecrets: false,
        linesAdded: index + 1,
        linesRemoved: index,
        diff: `diff body ${index}`,
      })),
      recentCommits: Array.from({ length: 4 }, (_, index) => ({
        sha: `sha-${index}`,
        message: `Commit message ${index}`.repeat(20),
        timestamp: `2026-03-12T00:00:0${index}.000Z`,
      })),
    };

    expect(shapeChangePackResult(payload, "full")).toBe(payload);

    const compact = shapeChangePackResult(payload, "compact") as Record<string, any>;
    expect(compact.verbosity).toBe("compact");
    expect(compact.changedFileCount).toBe(21);
    expect(compact.changedFilesTruncated).toBe(true);
    expect(compact.changedFiles).toHaveLength(20);
    expect(compact.changedFiles[0]).not.toHaveProperty("diff");
    expect(compact.recentCommits).toHaveLength(3);

    const minimal = shapeChangePackResult(payload, "minimal") as Record<string, any>;
    expect(minimal.verbosity).toBe("minimal");
    expect(minimal.changedFiles).toHaveLength(10);
    expect(minimal.changedFiles[0]).not.toHaveProperty("language");
    expect(minimal.recentCommits).toHaveLength(3);
  });

  it("summarizes note and knowledge matches for issue packs", () => {
    const payload = {
      currentHead: "head",
      query: "review",
      matchedNotes: Array.from({ length: 6 }, (_, index) => ({
        key: `note-${index}`,
        type: "issue",
        content: `This is note content ${index}. `.repeat(20),
        linkedPaths: [`src/file-${index}.ts`],
        agentId: "agent-1",
        commitSha: "abc1234",
        updatedAt: `2026-03-12T00:00:0${index}.000Z`,
      })),
      matchedKnowledge: Array.from({ length: 6 }, (_, index) => ({
        key: `knowledge-${index}`,
        type: "decision",
        scope: "repo",
        title: `Decision ${index}`,
        content: `Knowledge content ${index}. `.repeat(20),
        tags: ["one", "two"],
        updatedAt: `2026-03-12T00:01:0${index}.000Z`,
      })),
    };

    expect(shapeIssuePackResult(payload, "full")).toBe(payload);

    const compact = shapeIssuePackResult(payload, "compact") as Record<string, any>;
    expect(compact.verbosity).toBe("compact");
    expect(compact.matchedNoteCount).toBe(6);
    expect(compact.matchedNotes).toHaveLength(6);
    expect(compact.matchedNotes[0]).toHaveProperty("excerpt");
    expect(compact.matchedNotes[0]).not.toHaveProperty("content");
    expect(compact.matchedKnowledge[0]).toHaveProperty("excerpt");
    expect(compact.matchedKnowledge[0]).not.toHaveProperty("content");

    const minimal = shapeIssuePackResult(payload, "minimal") as Record<string, any>;
    expect(minimal.verbosity).toBe("minimal");
    expect(minimal.matchedNotes).toHaveLength(5);
    expect(minimal.matchedNotesTruncated).toBe(true);
    expect(minimal.matchedKnowledge).toHaveLength(5);
    expect(minimal.matchedKnowledgeTruncated).toBe(true);
  });
});
