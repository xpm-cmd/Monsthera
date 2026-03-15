import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { createSandbox, registerSandboxAgent, type SandboxContext } from "../../../src/simulation/harness.js";
import { tickets, agents, sessions, ticketHistory, eventLogs } from "../../../src/db/schema.js";

describe("simulation harness", () => {
  let sandbox: SandboxContext;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agora-harness-"));
    sandbox = createSandbox({ repoPath: tempDir });
  });

  afterEach(async () => {
    sandbox.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("createSandbox", () => {
    it("creates an in-memory DB with all required tables", () => {
      const tableNames = sandbox.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tableNames.map((t) => t.name);

      expect(names).toContain("repos");
      expect(names).toContain("agents");
      expect(names).toContain("sessions");
      expect(names).toContain("tickets");
      expect(names).toContain("ticket_history");
      expect(names).toContain("ticket_comments");
      expect(names).toContain("review_verdicts");
      expect(names).toContain("council_assignments");
      expect(names).toContain("coordination_messages");
      expect(names).toContain("dashboard_events");
      expect(names).toContain("ticket_dependencies");
      expect(names).toContain("patches");
      expect(names).toContain("knowledge");
      expect(names).toContain("protected_artifacts");
      expect(names).toContain("commit_locks");
      expect(names).toContain("event_logs");
      expect(names).toContain("debug_payloads");
      expect(names).toContain("files");
      expect(names).toContain("imports");
      expect(names).toContain("index_state");
    });

    it("creates FTS5 virtual tables", () => {
      const tableNames = sandbox.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tableNames.map((t) => t.name);

      expect(names).toContain("knowledge_fts");
    });

    it("registers the repo and provides a valid repoId", () => {
      expect(sandbox.repoId).toBeGreaterThan(0);

      const repos = sandbox.sqlite
        .prepare("SELECT id, path, name FROM repos")
        .all() as Array<{ id: number; path: string; name: string }>;

      expect(repos).toHaveLength(1);
      expect(repos[0]!.path).toBe(tempDir);
    });

    it("provides a working coordination bus", () => {
      registerSandboxAgent(sandbox, "test-agent");

      const msg = sandbox.bus.send({
        from: "test-agent",
        to: null,
        type: "broadcast",
        payload: { key: "value" },
      });

      expect(msg).toBeTruthy();
      expect(typeof msg.id).toBe("string");
    });

    it("dispose closes the database", () => {
      sandbox.dispose();

      expect(() => {
        sandbox.sqlite.prepare("SELECT 1").get();
      }).toThrow();

      // Re-create for afterEach cleanup
      sandbox = createSandbox({ repoPath: tempDir });
    });
  });

  describe("registerSandboxAgent", () => {
    it("creates agent and session records", () => {
      const { agentId, sessionId } = registerSandboxAgent(sandbox, "sim-dev-1", {
        model: "haiku",
        roleId: "developer",
      });

      expect(agentId).toBe("sim-dev-1");
      expect(sessionId).toContain("sim-session-sim-dev-1");

      const agentRows = sandbox.db
        .select()
        .from(agents)
        .where(sql`${agents.id} = ${agentId}`)
        .all();
      expect(agentRows).toHaveLength(1);
      expect(agentRows[0]!.model).toBe("haiku");

      const sessionRows = sandbox.db
        .select()
        .from(sessions)
        .where(sql`${sessions.id} = ${sessionId}`)
        .all();
      expect(sessionRows).toHaveLength(1);
      expect(sessionRows[0]!.agentId).toBe(agentId);
    });

    it("allows multiple agents with different models", () => {
      const agent1 = registerSandboxAgent(sandbox, "dev-haiku", { model: "haiku" });
      const agent2 = registerSandboxAgent(sandbox, "dev-sonnet", { model: "sonnet" });

      expect(agent1.agentId).not.toBe(agent2.agentId);

      const allAgents = sandbox.db.select().from(agents).all();
      expect(allAgents).toHaveLength(2);
    });
  });

  describe("ticket operations in sandbox", () => {
    it("can insert and query tickets via Drizzle ORM", () => {
      const { agentId, sessionId } = registerSandboxAgent(sandbox, "ticket-creator");
      const now = new Date().toISOString();

      sandbox.sqlite
        .prepare([
          "INSERT INTO tickets (",
          "  repo_id, ticket_id, title, description, status,",
          "  severity, priority, creator_agent_id, creator_session_id,",
          "  commit_sha, created_at, updated_at",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join("\n"))
        .run(
          sandbox.repoId, "TKT-sandbox01", "Test ticket", "A sandbox test ticket",
          "backlog", "medium", 5, agentId, sessionId,
          "abc123", now, now,
        );

      const result = sandbox.db
        .select()
        .from(tickets)
        .where(sql`${tickets.ticketId} = 'TKT-sandbox01'`)
        .all();

      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe("Test ticket");
    });

    it("can record ticket history", () => {
      const { agentId, sessionId } = registerSandboxAgent(sandbox, "history-agent");
      const now = new Date().toISOString();

      sandbox.sqlite
        .prepare([
          "INSERT INTO tickets (",
          "  repo_id, ticket_id, title, description,",
          "  creator_agent_id, creator_session_id, commit_sha, created_at, updated_at",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join("\n"))
        .run(sandbox.repoId, "TKT-hist01", "History test", "desc", agentId, sessionId, "sha1", now, now);

      const ticketRow = sandbox.sqlite
        .prepare("SELECT id FROM tickets WHERE ticket_id = 'TKT-hist01'")
        .get() as { id: number };

      sandbox.sqlite
        .prepare([
          "INSERT INTO ticket_history (",
          "  ticket_id, from_status, to_status, agent_id, session_id, timestamp",
          ") VALUES (?, ?, ?, ?, ?, ?)",
        ].join("\n"))
        .run(ticketRow.id, "backlog", "in_progress", agentId, sessionId, now);

      const history = sandbox.db
        .select()
        .from(ticketHistory)
        .where(sql`${ticketHistory.ticketId} = ${ticketRow.id}`)
        .all();

      expect(history).toHaveLength(1);
      expect(history[0]!.toStatus).toBe("in_progress");
    });
  });

  describe("event_logs table in sandbox", () => {
    it("can insert and query event logs", () => {
      const now = new Date().toISOString();

      sandbox.sqlite
        .prepare([
          "INSERT INTO event_logs (",
          "  event_id, agent_id, session_id, tool, timestamp,",
          "  duration_ms, status, repo_id, commit_scope,",
          "  payload_size_in, payload_size_out, input_hash, output_hash, redacted_summary",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join("\n"))
        .run(
          "evt-001", "agent-1", "sess-1", "create_ticket", now,
          150.5, "success", String(sandbox.repoId), "HEAD",
          500, 1200, "hash-in", "hash-out", "created ticket",
        );

      const logs = sandbox.db.select().from(eventLogs).all();

      expect(logs).toHaveLength(1);
      expect(logs[0]!.tool).toBe("create_ticket");
      expect(logs[0]!.durationMs).toBe(150.5);
    });
  });

  describe("isolation", () => {
    it("two sandboxes are completely independent", () => {
      const sandbox2 = createSandbox({ repoPath: "/tmp/other-repo" });

      registerSandboxAgent(sandbox, "agent-in-1");
      registerSandboxAgent(sandbox2, "agent-in-2");

      const agents1 = sandbox.db.select().from(agents).all();
      const agents2 = sandbox2.db.select().from(agents).all();

      expect(agents1).toHaveLength(1);
      expect(agents1[0]!.id).toBe("agent-in-1");
      expect(agents2).toHaveLength(1);
      expect(agents2[0]!.id).toBe("agent-in-2");

      sandbox2.dispose();
    });
  });
});
