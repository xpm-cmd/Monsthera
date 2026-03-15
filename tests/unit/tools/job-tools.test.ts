import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerJobTools } from "../../../src/tools/job-tools.js";
import { LOOP_TEMPLATES } from "../../../schemas/job.js";

// ─── FakeServer (same pattern as read-tools.test.ts) ──────────────────

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<any>>();

  tool(name: string, _description: string, _schema: object, handler: (input: unknown) => Promise<any>) {
    this.handlers.set(name, handler);
  }
}

// ─── DB Setup ─────────────────────────────────────────────────────────

function createJobDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // Core tables needed by job tools + resolveAgent + recordDashboardEvent
  sqlite.exec(`
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
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
    CREATE TABLE dashboard_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      event_type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE job_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      slot_id TEXT NOT NULL UNIQUE,
      loop_id TEXT NOT NULL,
      role TEXT NOT NULL,
      specialization TEXT,
      label TEXT NOT NULL,
      description TEXT,
      system_prompt TEXT,
      context_json TEXT,
      ticket_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      agent_id TEXT,
      session_id TEXT,
      claimed_at TEXT,
      active_since TEXT,
      completed_at TEXT,
      last_heartbeat TEXT,
      progress_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_job_slots_loop_status ON job_slots(repo_id, loop_id, status);
    CREATE INDEX idx_job_slots_agent ON job_slots(agent_id);
    CREATE INDEX idx_job_slots_ticket ON job_slots(repo_id, ticket_id);
  `);

  const db = drizzle(sqlite, { schema });
  queries.upsertRepo(db, "/test", "test");
  return { db, sqlite };
}

function insertAgent(
  db: ReturnType<typeof createJobDb>["db"],
  agentId: string,
  sessionId: string,
  role: string = "developer",
  trustTier: string = "A",
) {
  const now = new Date().toISOString();
  queries.upsertAgent(db, {
    id: agentId,
    name: agentId,
    type: "test",
    roleId: role,
    trustTier,
    registeredAt: now,
  });
  queries.insertSession(db, {
    id: sessionId,
    agentId,
    state: "active",
    connectedAt: now,
    lastActivity: now,
  });
}

function insertSlot(
  sqlite: InstanceType<typeof Database>,
  overrides: Partial<{
    slotId: string;
    loopId: string;
    role: string;
    specialization: string;
    label: string;
    systemPrompt: string;
    contextJson: string;
    ticketId: string;
    status: string;
    agentId: string;
    sessionId: string;
  }> = {},
) {
  const now = new Date().toISOString();
  const slotId = overrides.slotId ?? `JOB-${Math.random().toString(36).slice(2, 10)}`;
  sqlite.prepare(`
    INSERT INTO job_slots (
      repo_id, slot_id, loop_id, role, specialization, label,
      system_prompt, context_json, ticket_id, status,
      agent_id, session_id, claimed_at, active_since, completed_at,
      last_heartbeat, progress_note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1,
    slotId,
    overrides.loopId ?? "loop-1",
    overrides.role ?? "developer",
    overrides.specialization ?? null,
    overrides.label ?? "Test Slot",
    overrides.systemPrompt ?? null,
    overrides.contextJson ?? null,
    overrides.ticketId ?? null,
    overrides.status ?? "open",
    overrides.agentId ?? null,
    overrides.sessionId ?? null,
    null, null, null, null, null,
    now, now,
  );
  return slotId;
}

// ─── Test Helpers ─────────────────────────────────────────────────────

function setupServer(db: ReturnType<typeof createJobDb>["db"]) {
  const server = new FakeServer();
  registerJobTools(server as unknown as McpServer, async () => ({
    db,
    repoId: 1,
    repoPath: "/test",
    config: {
      coordinationTopology: "hub-spoke",
      debugLogging: false,
    },
    insight: { info: () => {}, warn: () => {}, error: () => {} },
    searchRouter: { getSemanticReranker: () => null },
  } as any));
  return server;
}

function handler(server: FakeServer, name: string) {
  const found = server.handlers.get(name);
  expect(found).toBeTypeOf("function");
  return found!;
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("create_loop", () => {
  let db: ReturnType<typeof createJobDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let server: FakeServer;

  beforeEach(() => {
    ({ db, sqlite } = createJobDb());
    server = setupServer(db);
  });
  afterEach(() => sqlite.close());

  it("creates a loop with full-team template (11 slots)", async () => {
    insertAgent(db, "agent-fac", "session-fac", "facilitator");
    const result = await handler(server, "create_loop")({
      loopId: "loop-alpha",
      template: "full-team",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });

    const payload = parse(result);
    expect(payload.loopId).toBe("loop-alpha");
    expect(payload.template).toBe("full-team");
    expect(payload.slotsCreated).toBe(LOOP_TEMPLATES["full-team"]!.length);
    expect(payload.slotIds).toHaveLength(LOOP_TEMPLATES["full-team"]!.length);
    // full-team = facilitator + 2 planners + 2 developers + 6 reviewers = 11
    expect(payload.slotsCreated).toBe(11);
  });

  it("creates a loop with small-team template (4 slots)", async () => {
    insertAgent(db, "agent-fac", "session-fac", "facilitator");
    const result = await handler(server, "create_loop")({
      loopId: "loop-small",
      template: "small-team",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });

    const payload = parse(result);
    expect(payload.slotsCreated).toBe(4);
    expect(payload.template).toBe("small-team");
  });

  it("rejects duplicate loopId", async () => {
    insertAgent(db, "agent-fac", "session-fac", "facilitator");
    // Create first loop
    await handler(server, "create_loop")({
      loopId: "loop-dup",
      template: "small-team",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });
    // Attempt duplicate
    const result = await handler(server, "create_loop")({
      loopId: "loop-dup",
      template: "small-team",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("already exists");
  });

  it("requires auth (resolveAgent rejects missing agent)", async () => {
    const result = await handler(server, "create_loop")({
      loopId: "loop-noauth",
      template: "small-team",
      agentId: "nonexistent",
      sessionId: "nonexistent",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Agent not found");
  });

  it("rejects observer role (access control)", async () => {
    insertAgent(db, "agent-obs", "session-obs", "observer", "B");
    const result = await handler(server, "create_loop")({
      loopId: "loop-obs",
      template: "small-team",
      agentId: "agent-obs",
      sessionId: "session-obs",
    });

    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload.denied).toBe(true);
  });

  it("custom template requires slots array", async () => {
    insertAgent(db, "agent-fac", "session-fac", "facilitator");
    const result = await handler(server, "create_loop")({
      loopId: "loop-custom-empty",
      template: "custom",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Custom template requires at least one slot");
  });

  it("custom template with provided slots succeeds", async () => {
    insertAgent(db, "agent-fac", "session-fac", "facilitator");
    const result = await handler(server, "create_loop")({
      loopId: "loop-custom",
      template: "custom",
      slots: [
        { role: "developer", label: "Custom Dev", description: "A custom dev slot" },
        { role: "reviewer", label: "Custom Reviewer" },
      ],
      agentId: "agent-fac",
      sessionId: "session-fac",
    });

    const payload = parse(result);
    expect(payload.slotsCreated).toBe(2);
    expect(payload.slotIds).toHaveLength(2);
  });

  it("allows planner role to create loops", async () => {
    insertAgent(db, "agent-plan", "session-plan", "planner");
    const result = await handler(server, "create_loop")({
      loopId: "loop-planner",
      template: "small-team",
      agentId: "agent-plan",
      sessionId: "session-plan",
    });

    expect(result.isError).toBeUndefined();
    const payload = parse(result);
    expect(payload.slotsCreated).toBe(4);
  });
});

describe("list_jobs", () => {
  let db: ReturnType<typeof createJobDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let server: FakeServer;

  beforeEach(() => {
    ({ db, sqlite } = createJobDb());
    server = setupServer(db);
    insertAgent(db, "agent-dev", "session-dev", "developer");
  });
  afterEach(() => sqlite.close());

  it("lists slots without systemPrompt", async () => {
    insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Slot",
      systemPrompt: "SECRET PROMPT",
    });

    const result = await handler(server, "list_jobs")({
      loopId: "loop-1",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = parse(result);
    expect(payload.slots).toHaveLength(1);
    expect(payload.slots[0].label).toBe("Dev Slot");
    expect(payload.slots[0]).not.toHaveProperty("systemPrompt");
  });

  it("filters by status", async () => {
    insertSlot(sqlite, { loopId: "loop-1", status: "open", label: "Open Slot" });
    insertSlot(sqlite, { loopId: "loop-1", status: "claimed", label: "Claimed Slot", agentId: "agent-dev" });

    const result = await handler(server, "list_jobs")({
      loopId: "loop-1",
      status: "open",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = parse(result);
    expect(payload.slots).toHaveLength(1);
    expect(payload.slots[0].label).toBe("Open Slot");
  });

  it("filters by role", async () => {
    insertSlot(sqlite, { loopId: "loop-1", role: "developer", label: "Dev" });
    insertSlot(sqlite, { loopId: "loop-1", role: "reviewer", label: "Rev" });

    const result = await handler(server, "list_jobs")({
      loopId: "loop-1",
      role: "developer",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = parse(result);
    expect(payload.slots).toHaveLength(1);
    expect(payload.slots[0].role).toBe("developer");
  });

  it("filters by loopId", async () => {
    insertSlot(sqlite, { loopId: "loop-1", label: "Loop 1 Slot" });
    insertSlot(sqlite, { loopId: "loop-2", label: "Loop 2 Slot" });

    const result = await handler(server, "list_jobs")({
      loopId: "loop-1",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = parse(result);
    expect(payload.slots).toHaveLength(1);
    expect(payload.slots[0].label).toBe("Loop 1 Slot");
  });

  it("lists all slots when no loopId is provided", async () => {
    insertSlot(sqlite, { loopId: "loop-1", label: "Slot A" });
    insertSlot(sqlite, { loopId: "loop-2", label: "Slot B" });

    const result = await handler(server, "list_jobs")({
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = parse(result);
    expect(payload.slots).toHaveLength(2);
  });

  it("returns loop summaries", async () => {
    insertSlot(sqlite, { loopId: "loop-1", status: "open" });
    insertSlot(sqlite, { loopId: "loop-1", status: "claimed", agentId: "agent-dev" });

    const result = await handler(server, "list_jobs")({
      loopId: "loop-1",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = parse(result);
    expect(payload.loops).toHaveLength(1);
    expect(payload.loops[0].loopId).toBe("loop-1");
    expect(payload.loops[0].total).toBe(2);
  });
});

describe("claim_job", () => {
  let db: ReturnType<typeof createJobDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let server: FakeServer;

  beforeEach(() => {
    ({ db, sqlite } = createJobDb());
    server = setupServer(db);
  });
  afterEach(() => sqlite.close());

  it("returns systemPrompt and context on claim by slotId", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      systemPrompt: "You are a developer. Do great work.",
      contextJson: JSON.stringify({ focusFiles: ["src/main.ts"], goals: ["implement feature"] }),
    });

    const result = await handler(server, "claim_job")({
      slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBeUndefined();
    const payload = parse(result);
    expect(payload.claimed).toBe(true);
    expect(payload.slotId).toBe(slotId);
    expect(payload.systemPrompt).toBe("You are a developer. Do great work.");
    expect(payload.context).toEqual({ focusFiles: ["src/main.ts"], goals: ["implement feature"] });
    expect(payload.label).toBe("Dev Work");
  });

  it("rejects if agent already has an active job", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    // First claim
    const slot1 = insertSlot(sqlite, { loopId: "loop-1", role: "developer", label: "Slot 1" });
    await handler(server, "claim_job")({
      slotId: slot1,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    // Second claim should fail
    const slot2 = insertSlot(sqlite, { loopId: "loop-1", role: "developer", label: "Slot 2" });
    const result = await handler(server, "claim_job")({
      slotId: slot2,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload.denied).toBe(true);
    expect(payload.reason).toContain("already have an active job");
    expect(payload.activeSlot.slotId).toBe(slot1);
  });

  it("auto-matches by role when loopId is provided", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    insertSlot(sqlite, { loopId: "loop-1", role: "reviewer", label: "Reviewer Slot" });
    const devSlotId = insertSlot(sqlite, { loopId: "loop-1", role: "developer", label: "Dev Slot" });

    const result = await handler(server, "claim_job")({
      loopId: "loop-1",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = parse(result);
    expect(payload.claimed).toBe(true);
    expect(payload.slotId).toBe(devSlotId);
    expect(payload.role).toBe("developer");
  });

  it("rejects if no open slots match agent role", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    insertSlot(sqlite, { loopId: "loop-1", role: "reviewer", label: "Reviewer Only" });

    const result = await handler(server, "claim_job")({
      loopId: "loop-1",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload.denied).toBe(true);
    expect(payload.reason).toContain("No open developer slots");
  });

  it("rejects claiming a non-open slot", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Claimed Slot",
      status: "claimed",
      agentId: "other-agent",
    });

    const result = await handler(server, "claim_job")({
      slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not open");
  });

  it("requires either slotId or loopId", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const result = await handler(server, "claim_job")({
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Provide either slotId or loopId");
  });

  it("rejects non-existent slotId", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const result = await handler(server, "claim_job")({
      slotId: "JOB-nonexist",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Slot not found");
  });
});

describe("update_job_progress", () => {
  let db: ReturnType<typeof createJobDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let server: FakeServer;

  beforeEach(() => {
    ({ db, sqlite } = createJobDb());
    server = setupServer(db);
  });
  afterEach(() => sqlite.close());

  it("updates heartbeat and progressNote", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "claimed",
      agentId: "agent-dev",
    });

    const result = await handler(server, "update_job_progress")({
      slotId,
      progressNote: "Working on auth module",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = parse(result);
    expect(payload.updated).toBe(true);
    expect(payload.progressNote).toBe("Working on auth module");
    expect(payload.lastHeartbeat).toBeTruthy();
  });

  it("transitions claimed to active", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "claimed",
      agentId: "agent-dev",
    });

    const result = await handler(server, "update_job_progress")({
      slotId,
      status: "active",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = parse(result);
    expect(payload.updated).toBe(true);
    expect(payload.status).toBe("active");
  });

  it("rejects invalid state transition open to completed", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "open",
      agentId: "agent-dev",
    });

    const result = await handler(server, "update_job_progress")({
      slotId,
      status: "completed",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot transition from open to completed");
  });

  it("rejects if not slot owner", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    insertAgent(db, "agent-other", "session-other", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "claimed",
      agentId: "agent-other",
    });

    const result = await handler(server, "update_job_progress")({
      slotId,
      progressNote: "Hijack attempt",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not assigned to you");
  });

  it("rejects non-existent slot", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const result = await handler(server, "update_job_progress")({
      slotId: "JOB-nonexist",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Slot not found");
  });

  it("can associate a ticketId with a slot", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "claimed",
      agentId: "agent-dev",
    });

    const result = await handler(server, "update_job_progress")({
      slotId,
      ticketId: "TKT-abc",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = parse(result);
    expect(payload.updated).toBe(true);
  });

  it("transitions active to completed", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "active",
      agentId: "agent-dev",
    });

    const result = await handler(server, "update_job_progress")({
      slotId,
      status: "completed",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = parse(result);
    expect(payload.updated).toBe(true);
    expect(payload.status).toBe("completed");
  });
});

describe("complete_job", () => {
  let db: ReturnType<typeof createJobDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let server: FakeServer;

  beforeEach(() => {
    ({ db, sqlite } = createJobDb());
    server = setupServer(db);
  });
  afterEach(() => sqlite.close());

  it("rejects completing a claimed slot (invalid transition)", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "claimed",
      agentId: "agent-dev",
    });

    const result = await handler(server, "complete_job")({
      slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    // claimed -> completed is not in transitions: claimed -> [active, abandoned, open]
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot complete a slot in claimed state");
  });

  it("marks an active slot as completed", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "active",
      agentId: "agent-dev",
    });

    const result = await handler(server, "complete_job")({
      slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBeUndefined();
    const payload = parse(result);
    expect(payload.completed).toBe(true);
    expect(payload.slotId).toBe(slotId);
    expect(payload.label).toBe("Dev Work");
  });

  it("rejects if not the slot owner", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    insertAgent(db, "agent-other", "session-other", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "active",
      agentId: "agent-other",
    });

    const result = await handler(server, "complete_job")({
      slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not assigned to you");
  });

  it("rejects invalid transition from open state", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "open",
      agentId: "agent-dev",
    });

    const result = await handler(server, "complete_job")({
      slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot complete a slot in open state");
  });

  it("rejects invalid transition from completed state", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "completed",
      agentId: "agent-dev",
    });

    const result = await handler(server, "complete_job")({
      slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot complete a slot in completed state");
  });

  it("rejects non-existent slot", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const result = await handler(server, "complete_job")({
      slotId: "JOB-nonexist",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Slot not found");
  });
});

describe("release_job", () => {
  let db: ReturnType<typeof createJobDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let server: FakeServer;

  beforeEach(() => {
    ({ db, sqlite } = createJobDb());
    server = setupServer(db);
  });
  afterEach(() => sqlite.close());

  it("releases a claimed slot back to open (owner)", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "claimed",
      agentId: "agent-dev",
    });

    const result = await handler(server, "release_job")({
      slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBeUndefined();
    const payload = parse(result);
    expect(payload.released).toBe(true);
    expect(payload.slotId).toBe(slotId);

    // Verify slot is back to open and unassigned
    const row = sqlite.prepare("SELECT status, agent_id FROM job_slots WHERE slot_id = ?").get(slotId) as any;
    expect(row.status).toBe("open");
    expect(row.agent_id).toBeNull();
  });

  it("releases an active slot back to open (owner)", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "active",
      agentId: "agent-dev",
    });

    const result = await handler(server, "release_job")({
      slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBeUndefined();
    const payload = parse(result);
    expect(payload.released).toBe(true);
  });

  it("facilitator can release another agent's slot", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    insertAgent(db, "agent-fac", "session-fac", "facilitator");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "active",
      agentId: "agent-dev",
    });

    const result = await handler(server, "release_job")({
      slotId,
      agentId: "agent-fac",
      sessionId: "session-fac",
    });

    expect(result.isError).toBeUndefined();
    const payload = parse(result);
    expect(payload.released).toBe(true);
  });

  it("admin can release another agent's slot", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    insertAgent(db, "agent-admin", "session-admin", "admin");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "claimed",
      agentId: "agent-dev",
    });

    const result = await handler(server, "release_job")({
      slotId,
      agentId: "agent-admin",
      sessionId: "session-admin",
    });

    expect(result.isError).toBeUndefined();
    const payload = parse(result);
    expect(payload.released).toBe(true);
  });

  it("non-owner developer cannot release another's slot", async () => {
    insertAgent(db, "agent-dev1", "session-dev1", "developer");
    insertAgent(db, "agent-dev2", "session-dev2", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "active",
      agentId: "agent-dev1",
    });

    const result = await handler(server, "release_job")({
      slotId,
      agentId: "agent-dev2",
      sessionId: "session-dev2",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Only the slot owner or a facilitator/admin");
  });

  it("cannot release a completed slot", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "completed",
      agentId: "agent-dev",
    });

    const result = await handler(server, "release_job")({
      slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot release a slot in completed state");
  });

  it("can release an abandoned slot", async () => {
    insertAgent(db, "agent-fac", "session-fac", "facilitator");
    const slotId = insertSlot(sqlite, {
      loopId: "loop-1",
      role: "developer",
      label: "Dev Work",
      status: "abandoned",
    });

    const result = await handler(server, "release_job")({
      slotId,
      agentId: "agent-fac",
      sessionId: "session-fac",
    });

    expect(result.isError).toBeUndefined();
    const payload = parse(result);
    expect(payload.released).toBe(true);
  });

  it("rejects non-existent slot", async () => {
    insertAgent(db, "agent-dev", "session-dev", "developer");
    const result = await handler(server, "release_job")({
      slotId: "JOB-nonexist",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Slot not found");
  });
});
