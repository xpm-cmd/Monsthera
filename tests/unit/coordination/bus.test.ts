import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoordinationBus } from "../../../src/coordination/bus.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";

describe("CoordinationBus", () => {
  let bus: CoordinationBus;
  let tempDir: string | null = null;

  beforeEach(() => {
    bus = new CoordinationBus("hub-spoke");
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("sends and retrieves broadcast messages", () => {
    bus.send({ from: "agent-1", to: null, type: "broadcast", payload: { msg: "hello" } });

    const msgs = bus.getMessages("agent-2");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.type).toBe("broadcast");
    expect(msgs[0]!.payload).toEqual({ msg: "hello" });
  });

  it("sends direct messages visible only to target, not sender", () => {
    bus.send({ from: "agent-1", to: "agent-2", type: "task_claim", payload: { file: "a.ts" } });

    expect(bus.getMessages("agent-2")).toHaveLength(1);
    expect(bus.getMessages("agent-1")).toHaveLength(0); // sender doesn't see own directs
    expect(bus.getMessages("agent-3")).toHaveLength(0); // third party doesn't
  });

  it("mesh topology shows all messages to everyone", () => {
    const meshBus = new CoordinationBus("mesh");
    meshBus.send({ from: "agent-1", to: "agent-2", type: "task_claim", payload: {} });

    expect(meshBus.getMessages("agent-3")).toHaveLength(1);
  });

  it("filters by since timestamp", () => {
    // Use a past timestamp so messages created "now" are after it
    const past = new Date(Date.now() - 60_000).toISOString();
    bus.send({ from: "a", to: null, type: "broadcast", payload: { n: 1 } });
    bus.send({ from: "a", to: null, type: "broadcast", payload: { n: 2 } });

    // Both messages should be after 'past'
    const msgs = bus.getMessages("b", past);
    expect(msgs).toHaveLength(2);

    // With no since, all are returned
    expect(bus.getMessages("b")).toHaveLength(2);
  });

  it("trims old messages beyond maxHistory", () => {
    const smallBus = new CoordinationBus("hub-spoke", 5);
    for (let i = 0; i < 10; i++) {
      smallBus.send({ from: "a", to: null, type: "broadcast", payload: { i } });
    }
    expect(smallBus.getMessages("b").length).toBeLessThanOrEqual(5);
  });

  it("reports topology", () => {
    expect(bus.getTopology()).toBe("hub-spoke");
    const meshBus = new CoordinationBus("mesh");
    expect(meshBus.getTopology()).toBe("mesh");
  });

  it("shares coordination messages across bus instances via SQLite", () => {
    tempDir = mkdtempSync(join(tmpdir(), "agora-bus-"));
    const dbPath = join(tempDir, "agora.db");

    const sqliteA = new Database(dbPath);
    const sqliteB = new Database(dbPath);
    sqliteA.pragma("journal_mode = WAL");
    sqliteB.pragma("journal_mode = WAL");

    sqliteA.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE coordination_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, message_id TEXT NOT NULL UNIQUE, from_agent_id TEXT NOT NULL, to_agent_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    `);

    const dbA = drizzle(sqliteA, { schema });
    const dbB = drizzle(sqliteB, { schema });
    const repoId = queries.upsertRepo(dbA, "/test", "test").id;

    const sharedA = new CoordinationBus("hub-spoke", 200, dbA, repoId);
    const sharedB = new CoordinationBus("hub-spoke", 200, dbB, repoId);

    sharedA.send({ from: "agent-1", to: null, type: "status_update", payload: { domain: "ticket", ticketId: "TKT-1" } });

    const messages = sharedB.getMessages("agent-2");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload).toMatchObject({ domain: "ticket", ticketId: "TKT-1" });

    sqliteA.close();
    sqliteB.close();
  });
});
