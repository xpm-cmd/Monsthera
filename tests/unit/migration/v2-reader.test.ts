import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteV2SourceReader } from "../../../src/migration/v2-reader.js";

const tempDirs: string[] = [];

function makeTempDb(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `monsthera-${name}-`));
  tempDirs.push(dir);
  return join(dir, "source.db");
}

function createDb(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("SqliteV2SourceReader", () => {
  it("reads the current SQLite schema used by this repository", async () => {
    const dbPath = makeTempDb("current");
    const db = createDb(dbPath);

    db.exec(`
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL,
        ticket_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        severity TEXT NOT NULL,
        priority INTEGER NOT NULL,
        tags_json TEXT,
        affected_paths_json TEXT,
        acceptance_criteria TEXT,
        creator_agent_id TEXT NOT NULL,
        creator_session_id TEXT NOT NULL,
        assignee_agent_id TEXT,
        resolved_by_agent_id TEXT,
        commit_sha TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE review_verdicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        specialization TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reasoning TEXT,
        created_at TEXT NOT NULL,
        superseded_by INTEGER
      );
      CREATE TABLE council_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        specialization TEXT NOT NULL,
        assigned_by_agent_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL
      );
    `);

    db.prepare(
      `INSERT INTO tickets
        (repo_id, ticket_id, title, description, status, severity, priority, tags_json, creator_agent_id, creator_session_id, assignee_agent_id, commit_sha, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      "TKT-123",
      "Harden auth",
      "Fix the auth edge cases",
      "technical_analysis",
      "critical",
      10,
      JSON.stringify(["bug", "security"]),
      "agent-creator",
      "session-1",
      "agent-assignee",
      "abc123",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );

    db.prepare(
      `INSERT INTO review_verdicts
        (ticket_id, agent_id, session_id, specialization, verdict, reasoning, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      "agent-reviewer",
      "session-2",
      "security",
      "pass",
      "Looks safe.",
      "2026-01-03T00:00:00.000Z",
    );

    db.prepare(
      `INSERT INTO council_assignments
        (ticket_id, agent_id, specialization, assigned_by_agent_id, assigned_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      1,
      "agent-architect",
      "architect",
      "agent-lead",
      "2026-01-01T01:00:00.000Z",
    );

    db.close();

    const reader = new SqliteV2SourceReader(dbPath);

    const tickets = await reader.readTickets();
    expect(tickets.ok).toBe(true);
    expect(tickets.ok && tickets.value[0]).toMatchObject({
      id: "TKT-123",
      title: "Harden auth",
      body: "Fix the auth edge cases",
      status: "in-progress",
      priority: "p0",
      assignee: "agent-assignee",
      tags: ["bug", "security"],
      codeRefs: [],
    });

    const verdicts = await reader.readVerdicts("TKT-123");
    expect(verdicts.ok).toBe(true);
    expect(verdicts.ok && verdicts.value[0]).toMatchObject({
      ticket_id: "TKT-123",
      council_member: "security (agent-reviewer)",
      outcome: "approved",
      reasoning: "Looks safe.",
    });

    const assignments = await reader.readAssignments("TKT-123");
    expect(assignments.ok).toBe(true);
    expect(assignments.ok && assignments.value[0]).toMatchObject({
      ticket_id: "TKT-123",
      council_member: "agent-architect",
      role: "architect",
    });

    await reader.close();
  });

  it("continues to support the legacy migration schema", async () => {
    const dbPath = makeTempDb("legacy");
    const db = createDb(dbPath);

    db.exec(`
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        assignee TEXT,
        tags TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE verdicts (
        ticket_id TEXT NOT NULL,
        council_member TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reasoning TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE council_assignments (
        ticket_id TEXT NOT NULL,
        council_member TEXT NOT NULL,
        role TEXT NOT NULL,
        assigned_at TEXT NOT NULL
      );
    `);

    db.prepare(
      `INSERT INTO tickets
        (id, title, body, status, priority, assignee, tags, created_at, updated_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "T-1",
      "Legacy ticket",
      "Legacy body",
      "resolved",
      "p1",
      "agent-1",
      "bug,legacy",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );

    db.prepare(
      "INSERT INTO verdicts (ticket_id, council_member, outcome, reasoning, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("T-1", "council-a", "approved", "Ship it.", "2026-01-03T00:00:00.000Z");

    db.prepare(
      "INSERT INTO council_assignments (ticket_id, council_member, role, assigned_at) VALUES (?, ?, ?, ?)",
    ).run("T-1", "council-a", "security", "2026-01-01T01:00:00.000Z");

    db.close();

    const reader = new SqliteV2SourceReader(dbPath);

    const tickets = await reader.readTickets();
    expect(tickets.ok && tickets.value[0]).toMatchObject({
      id: "T-1",
      status: "resolved",
      priority: "p1",
      tags: ["bug", "legacy"],
      codeRefs: [],
    });

    const verdicts = await reader.readVerdicts("T-1");
    expect(verdicts.ok && verdicts.value[0]).toMatchObject({
      council_member: "council-a",
      outcome: "approved",
    });

    const assignments = await reader.readAssignments("T-1");
    expect(assignments.ok && assignments.value[0]).toMatchObject({
      council_member: "council-a",
      role: "security",
    });

    await reader.close();
  });
});
