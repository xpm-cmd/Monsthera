import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerKnowledgeTools } from "../../../src/tools/knowledge-tools.js";
import {
  installToolRuntimeInstrumentation,
  resetToolRateLimitState,
} from "../../../src/tools/runtime-instrumentation.js";
import { registerWorkflowTools, resolveReviewerAssignments } from "../../../src/tools/workflow-tools.js";

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<any>>();

  tool(name: string, _description: string, _schema: object, handler: (input: unknown) => Promise<any>) {
    this.handlers.set(name, handler);
  }
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'unknown',
      provider TEXT,
      model TEXT,
      model_family TEXT,
      model_version TEXT,
      identity_source TEXT,
      role_id TEXT NOT NULL DEFAULT 'observer',
      trust_tier TEXT NOT NULL DEFAULT 'B',
      registered_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      state TEXT NOT NULL DEFAULT 'active',
      connected_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      claimed_files_json TEXT,
      worktree_path TEXT,
      worktree_branch TEXT
    );
    CREATE TABLE knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      agent_id TEXT,
      session_id TEXT,
      embedding BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE index_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      db_indexed_commit TEXT,
      zoekt_indexed_commit TEXT,
      indexed_at TEXT,
      last_success TEXT,
      last_error TEXT
    );
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      duration_ms REAL NOT NULL,
      status TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      commit_scope TEXT NOT NULL,
      payload_size_in INTEGER NOT NULL,
      payload_size_out INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      output_hash TEXT NOT NULL,
      redacted_summary TEXT NOT NULL,
      error_code TEXT,
      error_detail TEXT,
      denial_reason TEXT
    );
    CREATE TABLE debug_payloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL REFERENCES event_logs(event_id),
      raw_input TEXT,
      raw_output TEXT,
      expires_at TEXT NOT NULL
    );
  `);
  sqlite.prepare(`INSERT INTO index_state (repo_id, db_indexed_commit) VALUES (?, ?)`).run(1, "abc1234");
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("workflow tools", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  const tempDirs: string[] = [];
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    server = new FakeServer();
    calls.length = 0;
    resetToolRateLimitState();

    const now = new Date().toISOString();
    queries.upsertAgent(db, {
      id: "agent-dev",
      name: "Dev",
      type: "test",
      roleId: "developer",
      trustTier: "A",
      registeredAt: now,
    });
    queries.insertSession(db, {
      id: "session-dev",
      agentId: "agent-dev",
      state: "active",
      connectedAt: now,
      lastActivity: now,
    });
    queries.upsertAgent(db, {
      id: "agent-obs",
      name: "Obs",
      type: "test",
      roleId: "observer",
      trustTier: "B",
      registeredAt: now,
    });
    queries.insertSession(db, {
      id: "session-obs",
      agentId: "agent-obs",
      state: "active",
      connectedAt: now,
      lastActivity: now,
    });

    installToolRuntimeInstrumentation(server as unknown as McpServer, async () => ({
      config: {
        debugLogging: false,
        secretPatterns: [],
        toolRateLimits: {
          defaultPerMinute: 50,
        },
      },
      db,
      sqlite,
      repoId: 1,
      repoPath: "/test",
      globalDb: null,
      globalSqlite: null,
      searchRouter: {
        getSemanticReranker: () => null,
        rebuildKnowledgeFts: vi.fn(),
      },
      insight: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    } as any));

    registerPublicWorkflowFixtures(server, calls);
    registerKnowledgeTools(server as unknown as McpServer, async () => ({
      db,
      repoId: 1,
      sqlite,
      globalDb: null,
      globalSqlite: null,
      searchRouter: {
        getSemanticReranker: () => null,
        rebuildKnowledgeFts: vi.fn(),
      },
      insight: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    } as any));
    registerWorkflowTools(server as unknown as McpServer, async () => ({
      db,
      sqlite,
      repoId: 1,
      repoPath: "/test",
      globalDb: null,
      globalSqlite: null,
      config: {
        debugLogging: false,
        secretPatterns: [],
        toolRateLimits: {
          defaultPerMinute: 50,
        },
      },
      insight: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      searchRouter: {
        getSemanticReranker: () => null,
        rebuildKnowledgeFts: vi.fn(),
      },
    } as any));
  });

  afterEach(async () => {
    resetToolRateLimitState();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
    sqlite.close();
  });

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  it("runs onboard end-to-end and stores the generated knowledge entry", async () => {
    const result = await handler("run_workflow")({
      name: "onboard",
      params: {
        query: "architecture overview",
        title: "Workflow onboard note",
      },
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      name: "onboard",
      status: "completed",
    });

    const stored = queries.getKnowledgeByKey(db, payload.outputs.knowledge_entry.key as string);
    expect(stored).toMatchObject({
      title: "Workflow onboard note",
      agentId: "agent-dev",
      sessionId: "session-dev",
      type: "context",
    });
    expect(stored?.content).toContain("architecture overview");
    expect(stored?.content).toContain("run_workflow");
  });

  it("chains deep-review through sequential per-file analysis before suggestions", async () => {
    const result = await handler("run_workflow")({
      name: "deep-review",
      params: {},
      agentId: "agent-obs",
      sessionId: "session-obs",
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      name: "deep-review",
      status: "completed",
    });
    expect(calls.map((call) => `${call.tool}:${String(call.input.filePath ?? "")}`)).toEqual([
      "get_change_pack:",
      "analyze_complexity:src/alpha.ts",
      "analyze_complexity:src/beta.ts",
      "analyze_test_coverage:src/alpha.ts",
      "analyze_test_coverage:src/beta.ts",
      "suggest_actions:",
    ]);
    expect(payload.outputs.suggestions).toEqual({
      changedPaths: ["src/alpha.ts", "src/beta.ts"],
      recommendedTools: ["analyze_complexity", "analyze_test_coverage"],
    });
  });

  it("surfaces per-step permission denials when a workflow reaches a protected tool", async () => {
    const result = await handler("run_workflow")({
      name: "onboard",
      params: {},
      agentId: "agent-obs",
      sessionId: "session-obs",
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      name: "onboard",
      status: "failed",
    });
    expect(payload.steps.at(-1)).toMatchObject({
      key: "knowledge_entry",
      status: "failed",
      errorCode: "denied",
    });
  });

  it("executes repo-local custom workflows discovered from .agora/workflows", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "agora-workflow-tools-"));
    tempDirs.push(repoPath);
    const workflowDir = join(repoPath, ".agora", "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "review.yaml"), `name: repo-review
description: Repo-local review workflow
params: [sinceCommit]
steps:
  - tool: get_change_pack
    input: { sinceCommit: "{{params.sinceCommit}}" }
    output: changes
  - tool: suggest_actions
    input:
      changedPaths: "{{steps.changes.changedFiles.path}}"
    output: suggestions
`, "utf-8");

    const scopedServer = new FakeServer();
    installToolRuntimeInstrumentation(scopedServer as unknown as McpServer, async () => ({
      config: {
        debugLogging: false,
        secretPatterns: [],
        toolRateLimits: {
          defaultPerMinute: 50,
        },
      },
      db,
      sqlite,
      repoId: 1,
      repoPath,
      globalDb: null,
      globalSqlite: null,
      searchRouter: {
        getSemanticReranker: () => null,
        rebuildKnowledgeFts: vi.fn(),
      },
      insight: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    } as any));
    registerPublicWorkflowFixtures(scopedServer, calls);
    registerKnowledgeTools(scopedServer as unknown as McpServer, async () => ({
      db,
      repoId: 1,
      sqlite,
      globalDb: null,
      globalSqlite: null,
      searchRouter: {
        getSemanticReranker: () => null,
        rebuildKnowledgeFts: vi.fn(),
      },
      insight: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    } as any));
    registerWorkflowTools(scopedServer as unknown as McpServer, async () => ({
      db,
      sqlite,
      repoId: 1,
      repoPath,
      globalDb: null,
      globalSqlite: null,
      config: {
        debugLogging: false,
        secretPatterns: [],
        toolRateLimits: {
          defaultPerMinute: 50,
        },
      },
      insight: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      searchRouter: {
        getSemanticReranker: () => null,
        rebuildKnowledgeFts: vi.fn(),
      },
    } as any));

    const result = await scopedServer.handlers.get("run_workflow")!({
      name: "repo-review",
      params: {
        sinceCommit: "base1234",
      },
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      name: "custom:repo-review",
      status: "completed",
    });
    expect(payload.outputs.suggestions).toEqual({
      changedPaths: ["src/alpha.ts", "src/beta.ts"],
      recommendedTools: ["analyze_complexity", "analyze_test_coverage"],
    });
  });

  it("does not resolve a role to a generic reviewer when a specialization-specific reviewer is required", () => {
    const resolutions = resolveReviewerAssignments({
      roles: ["architect", "security"],
      availableReviewRoles: {
        architect: ["Architect Reviewer"],
        security: ["Security Reviewer"],
      },
      requireDistinctModels: false,
      liveSessions: [{ id: "session-review", agentId: "agent-review" }],
      getAgent: (agentId) => {
        if (agentId !== "agent-review") return undefined;
        return {
          name: "Council Loop Reviewer",
          roleId: "reviewer",
          provider: "openai",
          model: "gpt-5",
        };
      },
    });

    expect(resolutions).toEqual([
      {
        specialization: "architect",
        agentId: null,
        agentName: null,
        sessionId: null,
        status: "no_candidate",
      },
      {
        specialization: "security",
        agentId: null,
        agentName: null,
        sessionId: null,
        status: "no_candidate",
      },
    ]);
  });

  it("prefers specialization-specific live reviewers and does not use generic fallback for other roles", () => {
    const resolutions = resolveReviewerAssignments({
      roles: ["architect", "security"],
      availableReviewRoles: {
        architect: ["Architect Reviewer"],
        security: ["Security Reviewer"],
      },
      requireDistinctModels: false,
      liveSessions: [
        { id: "session-architect", agentId: "agent-architect" },
        { id: "session-generic", agentId: "agent-review" },
      ],
      getAgent: (agentId) => {
        if (agentId === "agent-architect") {
          return {
            name: "Architect Reviewer",
            roleId: "reviewer",
            provider: "anthropic",
            model: "opus",
          };
        }
        if (agentId === "agent-review") {
          return {
            name: "Council Loop Reviewer",
            roleId: "reviewer",
            provider: "openai",
            model: "gpt-5",
          };
        }
        return undefined;
      },
    });

    expect(resolutions).toEqual([
      {
        specialization: "architect",
        agentId: "agent-architect",
        agentName: "Architect Reviewer",
        sessionId: "session-architect",
        status: "resolved",
      },
      {
        specialization: "security",
        agentId: null,
        agentName: null,
        sessionId: null,
        status: "no_candidate",
      },
    ]);
  });

  it("allows generic reviewer fallback only when the repo has no specialization-specific reviewer manifest for that role", () => {
    const resolutions = resolveReviewerAssignments({
      roles: ["architect", "security"],
      availableReviewRoles: {
        architect: [],
        security: [],
      },
      requireDistinctModels: false,
      liveSessions: [
        { id: "session-a", agentId: "agent-review-a" },
        { id: "session-b", agentId: "agent-review-b" },
      ],
      getAgent: (agentId) => ({
        name: agentId === "agent-review-a" ? "Council Loop Reviewer A" : "Council Loop Reviewer B",
        roleId: "reviewer",
        provider: agentId === "agent-review-a" ? "anthropic" : "openai",
        model: agentId === "agent-review-a" ? "sonnet" : "gpt-5",
      }),
    });

    expect(resolutions).toEqual([
      {
        specialization: "architect",
        agentId: "agent-review-a",
        agentName: "Council Loop Reviewer A",
        sessionId: "session-a",
        status: "resolved",
      },
      {
        specialization: "security",
        agentId: "agent-review-b",
        agentName: "Council Loop Reviewer B",
        sessionId: "session-b",
        status: "resolved",
      },
    ]);
  });

  it("does not assign two roles to different agents on the same model when strict model diversity is enabled", () => {
    const resolutions = resolveReviewerAssignments({
      roles: ["architect", "security"],
      availableReviewRoles: {
        architect: ["Architect Reviewer"],
        security: ["Security Reviewer"],
      },
      requireDistinctModels: true,
      liveSessions: [
        { id: "session-architect", agentId: "agent-architect" },
        { id: "session-security", agentId: "agent-security" },
      ],
      getAgent: (agentId) => {
        if (agentId === "agent-architect") {
          return {
            name: "Architect Reviewer",
            roleId: "reviewer",
            provider: "openai",
            model: "gpt-5",
          };
        }
        if (agentId === "agent-security") {
          return {
            name: "Security Reviewer",
            roleId: "reviewer",
            provider: "openai",
            model: "gpt-5",
          };
        }
        return undefined;
      },
    });

    expect(resolutions).toEqual([
      {
        specialization: "architect",
        agentId: "agent-architect",
        agentName: "Architect Reviewer",
        sessionId: "session-architect",
        status: "resolved",
      },
      {
        specialization: "security",
        agentId: null,
        agentName: null,
        sessionId: null,
        status: "no_candidate",
      },
    ]);
  });

  it("allows same-model reviewers for critical-ticket dispatch when model diversity is relaxed", () => {
    const resolutions = resolveReviewerAssignments({
      roles: ["architect", "security"],
      availableReviewRoles: {
        architect: ["Architect Reviewer"],
        security: ["Security Reviewer"],
      },
      requireDistinctModels: false,
      liveSessions: [
        { id: "session-architect", agentId: "agent-architect" },
        { id: "session-security", agentId: "agent-security" },
      ],
      getAgent: (agentId) => {
        if (agentId === "agent-architect") {
          return {
            name: "Architect Reviewer",
            roleId: "reviewer",
            provider: "openai",
            model: "gpt-5",
          };
        }
        if (agentId === "agent-security") {
          return {
            name: "Security Reviewer",
            roleId: "reviewer",
            provider: "openai",
            model: "gpt-5",
          };
        }
        return undefined;
      },
    });

    expect(resolutions).toEqual([
      {
        specialization: "architect",
        agentId: "agent-architect",
        agentName: "Architect Reviewer",
        sessionId: "session-architect",
        status: "resolved",
      },
      {
        specialization: "security",
        agentId: "agent-security",
        agentName: "Security Reviewer",
        sessionId: "session-security",
        status: "resolved",
      },
    ]);
  });

  it("caps same-model reviewer dispatch at three voters even when strict diversity is relaxed", () => {
    const resolutions = resolveReviewerAssignments({
      roles: ["architect", "simplifier", "security", "performance"],
      availableReviewRoles: {
        architect: [],
        simplifier: [],
        security: [],
        performance: [],
      },
      requireDistinctModels: false,
      maxReviewersPerModel: 3,
      liveSessions: [
        { id: "session-a", agentId: "agent-a" },
        { id: "session-b", agentId: "agent-b" },
        { id: "session-c", agentId: "agent-c" },
        { id: "session-d", agentId: "agent-d" },
      ],
      getAgent: (agentId) => ({
        name: `Reviewer ${agentId}`,
        roleId: "reviewer",
        provider: "openai",
        model: "gpt-5",
      }),
    });

    expect(resolutions).toEqual([
      {
        specialization: "architect",
        agentId: "agent-a",
        agentName: "Reviewer agent-a",
        sessionId: "session-a",
        status: "resolved",
      },
      {
        specialization: "simplifier",
        agentId: "agent-b",
        agentName: "Reviewer agent-b",
        sessionId: "session-b",
        status: "resolved",
      },
      {
        specialization: "security",
        agentId: "agent-c",
        agentName: "Reviewer agent-c",
        sessionId: "session-c",
        status: "resolved",
      },
      {
        specialization: "performance",
        agentId: null,
        agentName: null,
        sessionId: null,
        status: "no_candidate",
      },
    ]);
  });

  it("does not assign two roles to different sessions of the same agent", () => {
    const resolutions = resolveReviewerAssignments({
      roles: ["architect", "security"],
      availableReviewRoles: {
        architect: [],
        security: [],
      },
      requireDistinctModels: false,
      liveSessions: [
        { id: "session-a", agentId: "agent-review" },
        { id: "session-b", agentId: "agent-review" },
      ],
      getAgent: () => ({
        name: "Council Loop Reviewer",
        roleId: "reviewer",
        provider: "openai",
        model: "gpt-5",
      }),
    });

    expect(resolutions).toEqual([
      {
        specialization: "architect",
        agentId: "agent-review",
        agentName: "Council Loop Reviewer",
        sessionId: "session-a",
        status: "resolved",
      },
      {
        specialization: "security",
        agentId: null,
        agentName: null,
        sessionId: null,
        status: "no_candidate",
      },
    ]);
  });
});

function registerPublicWorkflowFixtures(
  server: FakeServer,
  calls: Array<{ tool: string; input: Record<string, unknown> }>,
): void {
  server.tool(
    "get_code_pack",
    "fixture",
    {
      query: z.string(),
      verbosity: z.enum(["full", "compact", "minimal"]).optional(),
    },
    async (input) => {
      const payload = input as Record<string, unknown>;
      calls.push({ tool: "get_code_pack", input: payload });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            query: payload.query,
            currentHead: "abc1234",
            candidateCount: 1,
            candidates: [{ path: "src/server.ts", summary: "Main server bootstrap" }],
          }),
        }],
      };
    },
  );

  server.tool("capabilities", "fixture", {}, async () => {
    calls.push({ tool: "capabilities", input: {} });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          tools: ["run_workflow", "get_code_pack", "store_knowledge"],
          workflows: [{ name: "onboard" }, { name: "deep-review" }],
          availableReviewRoles: {
            architect: [],
            simplifier: [],
            security: [],
            performance: [],
            patterns: [],
            design: [],
          },
        }),
      }],
    };
  });

  server.tool("get_change_pack", "fixture", {}, async (input) => {
    calls.push({ tool: "get_change_pack", input: input as Record<string, unknown> });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          changedFiles: [{ path: "src/alpha.ts" }, { path: "src/beta.ts" }],
          currentHead: "abc1234",
          sinceCommit: "base1234",
        }),
      }],
    };
  });

  server.tool(
    "analyze_complexity",
    "fixture",
    { filePath: z.string() },
    async (input) => {
      const payload = input as Record<string, unknown>;
      calls.push({ tool: "analyze_complexity", input: payload });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            filePath: payload.filePath,
            complexityScore: 4,
          }),
        }],
      };
    },
  );

  server.tool(
    "analyze_test_coverage",
    "fixture",
    { filePath: z.string() },
    async (input) => {
      const payload = input as Record<string, unknown>;
      calls.push({ tool: "analyze_test_coverage", input: payload });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            filePath: payload.filePath,
            verdict: "unknown",
          }),
        }],
      };
    },
  );

  server.tool(
    "suggest_actions",
    "fixture",
    { changedPaths: z.array(z.string()) },
    async (input) => {
      const payload = input as Record<string, unknown>;
      calls.push({ tool: "suggest_actions", input: payload });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            changedPaths: payload.changedPaths,
            recommendedTools: ["analyze_complexity", "analyze_test_coverage"],
          }),
        }],
      };
    },
  );
}
