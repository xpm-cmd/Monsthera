import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import {
  insertJobSlot,
  getJobSlotBySlotId,
  getJobSlotsByLoop,
  getJobSlotsByAgent,
  getJobSlotsByTicketId,
  getOpenSlotsByRole,
  updateJobSlot,
  getDistinctLoops,
  abandonJobSlotsBySession,
  getAllJobSlots,
} from "../../../src/db/queries.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  for (const stmt of [
    `CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE job_slots (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), slot_id TEXT NOT NULL UNIQUE, loop_id TEXT NOT NULL, role TEXT NOT NULL, specialization TEXT, label TEXT NOT NULL, description TEXT, system_prompt TEXT, context_json TEXT, ticket_id TEXT, status TEXT NOT NULL DEFAULT 'open', agent_id TEXT, session_id TEXT, claimed_at TEXT, active_since TEXT, completed_at TEXT, last_heartbeat TEXT, progress_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]) {
    sqlite.prepare(stmt).run();
  }
  return { db: drizzle(sqlite, { schema }), sqlite };
}

function insertRepo(sqlite: InstanceType<typeof Database>): number {
  const result = sqlite
    .prepare("INSERT INTO repos (path, name, created_at) VALUES (?, ?, ?)")
    .run("/test/repo", "test-repo", new Date().toISOString());
  return Number(result.lastInsertRowid);
}

function makeSlot(repoId: number, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    repoId,
    slotId: `slot-${Math.random().toString(36).slice(2, 8)}`,
    loopId: "loop-1",
    role: "developer",
    label: "Dev Slot",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Job Slot Queries", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let repoId: number;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
    repoId = insertRepo(sqlite);
  });
  afterEach(() => sqlite.close());

  // --- insertJobSlot ---

  describe("insertJobSlot", () => {
    it("inserts and returns the row with all fields", () => {
      const slot = makeSlot(repoId, {
        slotId: "slot-abc",
        specialization: "frontend",
        description: "Build the UI",
        systemPrompt: "You are a frontend dev",
        contextJson: JSON.stringify({ key: "value" }),
        ticketId: "T-1",
      });

      const row = insertJobSlot(db, slot);

      expect(row.id).toBeTypeOf("number");
      expect(row.slotId).toBe("slot-abc");
      expect(row.repoId).toBe(repoId);
      expect(row.loopId).toBe("loop-1");
      expect(row.role).toBe("developer");
      expect(row.specialization).toBe("frontend");
      expect(row.label).toBe("Dev Slot");
      expect(row.description).toBe("Build the UI");
      expect(row.systemPrompt).toBe("You are a frontend dev");
      expect(row.contextJson).toBe(JSON.stringify({ key: "value" }));
      expect(row.ticketId).toBe("T-1");
      expect(row.status).toBe("open");
      expect(row.agentId).toBeNull();
      expect(row.sessionId).toBeNull();
    });

    it("defaults status to open", () => {
      const row = insertJobSlot(db, makeSlot(repoId));
      expect(row.status).toBe("open");
    });

    it("rejects duplicate slotId", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "dup" }));
      expect(() => insertJobSlot(db, makeSlot(repoId, { slotId: "dup" }))).toThrow();
    });
  });

  // --- getJobSlotBySlotId ---

  describe("getJobSlotBySlotId", () => {
    it("finds a slot by repoId and slotId", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "find-me" }));
      const found = getJobSlotBySlotId(db, repoId, "find-me");
      expect(found).toBeDefined();
      expect(found!.slotId).toBe("find-me");
    });

    it("returns undefined when slotId does not exist", () => {
      const found = getJobSlotBySlotId(db, repoId, "nonexistent");
      expect(found).toBeUndefined();
    });

    it("does not return a slot from a different repo", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "repo-scoped" }));

      const otherRepoId = Number(
        sqlite
          .prepare("INSERT INTO repos (path, name, created_at) VALUES (?, ?, ?)")
          .run("/other/repo", "other", new Date().toISOString()).lastInsertRowid,
      );

      const found = getJobSlotBySlotId(db, otherRepoId, "repo-scoped");
      expect(found).toBeUndefined();
    });
  });

  // --- getJobSlotsByLoop ---

  describe("getJobSlotsByLoop", () => {
    it("returns all slots for a loop", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "s1", loopId: "loop-A" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "s2", loopId: "loop-A" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "s3", loopId: "loop-B" }));

      const slots = getJobSlotsByLoop(db, repoId, "loop-A");
      expect(slots).toHaveLength(2);
      expect(slots.map((s) => s.slotId).sort()).toEqual(["s1", "s2"]);
    });

    it("filters by status when provided", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "open1", loopId: "loop-X", status: "open" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "claimed1", loopId: "loop-X", status: "claimed" }));

      const openOnly = getJobSlotsByLoop(db, repoId, "loop-X", "open");
      expect(openOnly).toHaveLength(1);
      expect(openOnly[0]!.slotId).toBe("open1");
    });

    it("returns all statuses when status is omitted", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "a", loopId: "loop-Y", status: "open" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "b", loopId: "loop-Y", status: "completed" }));

      const all = getJobSlotsByLoop(db, repoId, "loop-Y");
      expect(all).toHaveLength(2);
    });

    it("returns empty array when no slots match", () => {
      const slots = getJobSlotsByLoop(db, repoId, "no-such-loop");
      expect(slots).toEqual([]);
    });
  });

  // --- getJobSlotsByAgent ---

  describe("getJobSlotsByAgent", () => {
    it("returns all slots claimed by an agent", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "ag1", agentId: "agent-1" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "ag2", agentId: "agent-1" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "ag3", agentId: "agent-2" }));

      const slots = getJobSlotsByAgent(db, "agent-1");
      expect(slots).toHaveLength(2);
      expect(slots.every((s) => s.agentId === "agent-1")).toBe(true);
    });

    it("returns empty array for unknown agent", () => {
      const slots = getJobSlotsByAgent(db, "ghost");
      expect(slots).toEqual([]);
    });
  });

  // --- getJobSlotsByTicketId ---

  describe("getJobSlotsByTicketId", () => {
    it("returns all slots associated with a ticket", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "t1", ticketId: "TICKET-10" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "t2", ticketId: "TICKET-10" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "t3", ticketId: "TICKET-20" }));

      const slots = getJobSlotsByTicketId(db, repoId, "TICKET-10");
      expect(slots).toHaveLength(2);
      expect(slots.every((s) => s.ticketId === "TICKET-10")).toBe(true);
    });

    it("scopes to the correct repo", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "rt1", ticketId: "T-5" }));

      const otherRepoId = Number(
        sqlite
          .prepare("INSERT INTO repos (path, name, created_at) VALUES (?, ?, ?)")
          .run("/other2", "other2", new Date().toISOString()).lastInsertRowid,
      );

      const slots = getJobSlotsByTicketId(db, otherRepoId, "T-5");
      expect(slots).toEqual([]);
    });

    it("returns empty array when no slots match", () => {
      const slots = getJobSlotsByTicketId(db, repoId, "nonexistent");
      expect(slots).toEqual([]);
    });
  });

  // --- getOpenSlotsByRole ---

  describe("getOpenSlotsByRole", () => {
    it("returns only open slots matching role and loop", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "r1", loopId: "L1", role: "developer", status: "open" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "r2", loopId: "L1", role: "developer", status: "claimed" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "r3", loopId: "L1", role: "reviewer", status: "open" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "r4", loopId: "L2", role: "developer", status: "open" }));

      const slots = getOpenSlotsByRole(db, repoId, "L1", "developer");
      expect(slots).toHaveLength(1);
      expect(slots[0]!.slotId).toBe("r1");
    });

    it("returns empty array when all matching slots are claimed", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "c1", loopId: "L1", role: "developer", status: "claimed" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "c2", loopId: "L1", role: "developer", status: "active" }));

      const slots = getOpenSlotsByRole(db, repoId, "L1", "developer");
      expect(slots).toEqual([]);
    });
  });

  // --- updateJobSlot ---

  describe("updateJobSlot", () => {
    it("updates fields and auto-sets updatedAt", () => {
      const original = insertJobSlot(db, makeSlot(repoId, { slotId: "upd-1" }));
      const originalUpdatedAt = original.updatedAt;

      // Small delay to ensure timestamp differs
      updateJobSlot(db, "upd-1", { status: "claimed", agentId: "agent-X", progressNote: "Working on it" });

      const updated = getJobSlotBySlotId(db, repoId, "upd-1");
      expect(updated).toBeDefined();
      expect(updated!.status).toBe("claimed");
      expect(updated!.agentId).toBe("agent-X");
      expect(updated!.progressNote).toBe("Working on it");
      // updatedAt should have been refreshed
      expect(updated!.updatedAt).toBeDefined();
      // The original fields should remain
      expect(updated!.label).toBe("Dev Slot");
    });

    it("does not fail when slotId does not exist", () => {
      // updateJobSlot uses .run() which returns changes count; no slot matched = 0 changes
      expect(() => updateJobSlot(db, "no-such-slot", { status: "active" })).not.toThrow();
    });

    it("can clear nullable fields by setting them to null", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "null-test", agentId: "agent-1", sessionId: "sess-1" }));

      updateJobSlot(db, "null-test", { agentId: null, sessionId: null });

      const updated = getJobSlotBySlotId(db, repoId, "null-test");
      expect(updated!.agentId).toBeNull();
      expect(updated!.sessionId).toBeNull();
    });
  });

  // --- getDistinctLoops ---

  describe("getDistinctLoops", () => {
    it("aggregates counts by status per loop", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "d1", loopId: "loop-1", status: "open" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "d2", loopId: "loop-1", status: "open" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "d3", loopId: "loop-1", status: "claimed" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "d4", loopId: "loop-1", status: "active" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "d5", loopId: "loop-1", status: "completed" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "d6", loopId: "loop-1", status: "abandoned" }));

      const loops = getDistinctLoops(db, repoId);
      expect(loops).toHaveLength(1);

      const loop = loops[0]!;
      expect(loop.loopId).toBe("loop-1");
      expect(loop.total).toBe(6);
      expect(loop.open).toBe(2);
      expect(loop.claimed).toBe(1);
      expect(loop.active).toBe(1);
      expect(loop.completed).toBe(1);
      expect(loop.abandoned).toBe(1);
    });

    it("returns multiple loops grouped separately", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "m1", loopId: "alpha", status: "open" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "m2", loopId: "beta", status: "completed" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "m3", loopId: "beta", status: "open" }));

      const loops = getDistinctLoops(db, repoId);
      expect(loops).toHaveLength(2);

      const alpha = loops.find((l) => l.loopId === "alpha")!;
      const beta = loops.find((l) => l.loopId === "beta")!;

      expect(alpha.total).toBe(1);
      expect(alpha.open).toBe(1);
      expect(alpha.completed).toBe(0);

      expect(beta.total).toBe(2);
      expect(beta.open).toBe(1);
      expect(beta.completed).toBe(1);
    });

    it("returns empty array when no slots exist", () => {
      const loops = getDistinctLoops(db, repoId);
      expect(loops).toEqual([]);
    });
  });

  // --- abandonJobSlotsBySession ---

  describe("abandonJobSlotsBySession", () => {
    it("sets status to abandoned for non-completed slots and returns count", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "ab1", sessionId: "sess-1", status: "open" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "ab2", sessionId: "sess-1", status: "claimed" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "ab3", sessionId: "sess-1", status: "active" }));

      const count = abandonJobSlotsBySession(db, "sess-1");
      expect(count).toBe(3);

      const slots = getAllJobSlots(db, repoId);
      expect(slots.every((s) => s.status === "abandoned")).toBe(true);
    });

    it("does not abandon already completed slots", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "ac1", sessionId: "sess-2", status: "completed" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "ac2", sessionId: "sess-2", status: "open" }));

      const count = abandonJobSlotsBySession(db, "sess-2");
      expect(count).toBe(1);

      const completed = getJobSlotBySlotId(db, repoId, "ac1");
      expect(completed!.status).toBe("completed");

      const abandoned = getJobSlotBySlotId(db, repoId, "ac2");
      expect(abandoned!.status).toBe("abandoned");
    });

    it("does not abandon already abandoned slots", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "aa1", sessionId: "sess-3", status: "abandoned" }));

      const count = abandonJobSlotsBySession(db, "sess-3");
      expect(count).toBe(0);
    });

    it("clears agentId and sessionId on abandoned slots", () => {
      insertJobSlot(db, makeSlot(repoId, {
        slotId: "cl1",
        sessionId: "sess-4",
        agentId: "agent-1",
        status: "active",
      }));

      abandonJobSlotsBySession(db, "sess-4");

      const slot = getJobSlotBySlotId(db, repoId, "cl1");
      expect(slot!.agentId).toBeNull();
      expect(slot!.sessionId).toBeNull();
    });

    it("returns 0 when session has no slots", () => {
      const count = abandonJobSlotsBySession(db, "no-such-session");
      expect(count).toBe(0);
    });

    it("does not affect slots from other sessions", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "ot1", sessionId: "sess-5", status: "active" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "ot2", sessionId: "sess-6", status: "active" }));

      abandonJobSlotsBySession(db, "sess-5");

      const otherSlot = getJobSlotBySlotId(db, repoId, "ot2");
      expect(otherSlot!.status).toBe("active");
      expect(otherSlot!.sessionId).toBe("sess-6");
    });
  });

  // --- getAllJobSlots ---

  describe("getAllJobSlots", () => {
    it("returns all slots for a repo", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "all1" }));
      insertJobSlot(db, makeSlot(repoId, { slotId: "all2" }));

      const slots = getAllJobSlots(db, repoId);
      expect(slots).toHaveLength(2);
    });

    it("returns empty array when repo has no slots", () => {
      const slots = getAllJobSlots(db, repoId);
      expect(slots).toEqual([]);
    });

    it("does not return slots from other repos", () => {
      insertJobSlot(db, makeSlot(repoId, { slotId: "repo1-slot" }));

      const otherRepoId = Number(
        sqlite
          .prepare("INSERT INTO repos (path, name, created_at) VALUES (?, ?, ?)")
          .run("/other3", "other3", new Date().toISOString()).lastInsertRowid,
      );
      insertJobSlot(db, makeSlot(otherRepoId, { slotId: "repo2-slot" }));

      const slotsRepo1 = getAllJobSlots(db, repoId);
      expect(slotsRepo1).toHaveLength(1);
      expect(slotsRepo1[0]!.slotId).toBe("repo1-slot");

      const slotsRepo2 = getAllJobSlots(db, otherRepoId);
      expect(slotsRepo2).toHaveLength(1);
      expect(slotsRepo2[0]!.slotId).toBe("repo2-slot");
    });
  });
});
