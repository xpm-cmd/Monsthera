import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import {
  createDoltPool,
  closePool,
  initializeSchema,
  DoltSearchIndexRepository,
  DoltOrchestrationRepository,
} from "../../src/persistence/index.js";
import { workId } from "../../src/core/types.js";

/**
 * F1 (audit follow-up) — the four Dolt repositories were exercised only
 * against mocks. This is ONE real happy path against a live Dolt
 * sql-server: schema init, a search-document roundtrip, and an
 * orchestration-event roundtrip, inside an EPHEMERAL database that is
 * created and dropped by the test (the live `monsthera` database is never
 * touched).
 *
 * Opt-in by design: it needs a running daemon, so CI and normal local
 * runs skip it. Run with:
 *
 *   MONSTHERA_DOLT_SMOKE=1 pnpm vitest run tests/smoke/dolt-real-smoke.test.ts
 */

const SMOKE = process.env["MONSTHERA_DOLT_SMOKE"] === "1";
const HOST = process.env["MONSTHERA_DOLT_HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["MONSTHERA_DOLT_PORT"] ?? 3306);

const SMOKE_DB = `monsthera_smoke_${randomUUID().slice(0, 8)}`;

describe.skipIf(!SMOKE)("real Dolt smoke (opt-in: MONSTHERA_DOLT_SMOKE=1)", () => {
  let admin: mysql.Connection;
  let pool: Pool;

  beforeAll(async () => {
    admin = await mysql.createConnection({ host: HOST, port: PORT, user: "root" });
    await admin.query(`CREATE DATABASE \`${SMOKE_DB}\``);
    pool = createDoltPool({ host: HOST, port: PORT, database: SMOKE_DB });
  });

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${SMOKE_DB}\``);
      await admin.end();
    }
  });

  it("initializes the schema on a real Dolt database", async () => {
    const result = await initializeSchema(pool);
    expect(result.ok).toBe(true);
  });

  it("search-document roundtrip: index, find via real SQL, remove", async () => {
    const repo = new DoltSearchIndexRepository(pool);

    const indexed = await repo.indexArticle(
      "k-smoke001",
      "Dolt smoke probe article",
      "A body about ephemeral smoke probing of the real database.",
      "knowledge",
    );
    expect(indexed.ok).toBe(true);

    const hits = await repo.search({ query: "ephemeral smoke probing", type: "knowledge", limit: 5, offset: 0 });
    expect(hits.ok).toBe(true);
    if (!hits.ok) return;
    expect(hits.value.map((h) => h.id)).toContain("k-smoke001");

    const removed = await repo.removeArticle("k-smoke001");
    expect(removed.ok).toBe(true);

    const afterRemove = await repo.search({ query: "ephemeral smoke probing", type: "knowledge", limit: 5, offset: 0 });
    expect(afterRemove.ok).toBe(true);
    if (!afterRemove.ok) return;
    expect(afterRemove.value.map((h) => h.id)).not.toContain("k-smoke001");
  });

  it("orchestration-event roundtrip: log and read back", async () => {
    const repo = new DoltOrchestrationRepository(pool);

    const logged = await repo.logEvent({
      workId: workId("w-smoke001"),
      eventType: "phase_advanced",
      agentId: undefined,
      details: { to: "review", smoke: true },
    });
    expect(logged.ok).toBe(true);
    if (!logged.ok) return;

    const events = await repo.findByWorkId(workId("w-smoke001"));
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.some((e) => e.id === logged.value.id)).toBe(true);
    expect(events.value[0]?.details).toMatchObject({ smoke: true });
  });
});
