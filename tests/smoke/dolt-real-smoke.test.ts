import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql from "mysql2/promise";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import {
  createDoltPool,
  closePool,
  initializeSchema,
  DoltSearchIndexRepository,
  DoltOrchestrationRepository,
  DoltSnapshotRepository,
} from "../../src/persistence/index.js";
import { workId } from "../../src/core/types.js";
import { SnapshotService } from "../../src/context/snapshot-service.js";
import { snapshot_ready } from "../../src/work/guards.js";
import type { WorkArticle } from "../../src/work/repository.js";
import { createLogger } from "../../src/core/logger.js";

// w-arq1yroe regression pin: force a host timezone east of UTC so the
// "UTC digits stored in Dolt are read back as local time" bug class cannot
// pass unnoticed on UTC CI hosts. The module body runs before any test, and
// mysql2 consults the process timezone at row-decode time, so this is early
// enough. Instants (Date.now / epoch math) are timezone-independent, so the
// pre-existing smoke assertions are unaffected.
process.env["TZ"] = "Australia/Sydney";

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
const SMOKE_LOGGER = createLogger({ level: "warn", domain: "smoke" });

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

  // ── w-arq1yroe: capturedAt must survive the Dolt roundtrip as the same
  // instant. Dolt stores the UTC wall-clock digits verbatim; before the fix,
  // mysql2 (default timezone "local") re-read those digits as host-local
  // time, shifting every snapshot by the UTC offset (−10h on AEST hosts).

  it("environment-snapshot roundtrip: capturedAt is the same instant (w-arq1yroe)", async () => {
    const repo = new DoltSnapshotRepository(pool);
    const recorded = await repo.record({
      agentId: "agent-smoke-tz",
      workId: "w-smoke-tz",
      cwd: "/tmp/smoke",
      files: [],
      runtimes: { node: "22.0.0" },
      packageManagers: ["pnpm"],
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "sha-smoke" }],
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const latest = await repo.findLatestByWork("w-smoke-tz");
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value?.capturedAt).toBe(recorded.value.capturedAt);
  });

  it("a fresh snapshot reads back with ageSeconds ≈ 0 and stale=false", async () => {
    const service = new SnapshotService({
      repo: new DoltSnapshotRepository(pool),
      logger: SMOKE_LOGGER,
      maxAgeMinutes: 30,
    });
    const recorded = await service.record({ agentId: "agent-smoke-age", cwd: "/tmp/smoke" });
    expect(recorded.ok).toBe(true);

    const latest = await service.getLatest({ agentId: "agent-smoke-age" });
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value).not.toBeNull();
    expect(latest.value!.ageSeconds).toBeLessThanOrEqual(5);
    expect(latest.value!.stale).toBe(false);
  });

  it("snapshot_ready guard passes with a fresh snapshot and matching lockfiles (ADR-006)", async () => {
    const service = new SnapshotService({
      repo: new DoltSnapshotRepository(pool),
      logger: SMOKE_LOGGER,
      maxAgeMinutes: 30,
    });
    const recorded = await service.record({
      agentId: "agent-smoke-guard",
      workId: "w-smoke-guard",
      cwd: "/tmp/smoke",
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "sha-head" }],
    });
    expect(recorded.ok).toBe(true);

    // snapshot_ready only reads `article.id`; a minimal stub keeps the smoke focused.
    const article = { id: workId("w-smoke-guard") } as WorkArticle;
    const ready = await snapshot_ready(article, {
      snapshotService: service,
      headLockfileHashes: { "pnpm-lock.yaml": "sha-head" },
    });
    expect(ready).toBe(true);
  });

  it("orchestration-event createdAt is a string after the roundtrip", async () => {
    const repo = new DoltOrchestrationRepository(pool);
    const logged = await repo.logEvent({
      workId: workId("w-smoke-tz-evt1"),
      eventType: "phase_advanced",
      agentId: undefined,
      details: {},
    });
    expect(logged.ok).toBe(true);
    if (!logged.ok) return;

    const events = await repo.findByWorkId(workId("w-smoke-tz-evt1"));
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const read = events.value.find((e) => e.id === logged.value.id);
    expect(read).toBeDefined();
    expect(typeof read!.createdAt).toBe("string");
  });

  it("orchestration-event createdAt survives the roundtrip as the same instant", async () => {
    const repo = new DoltOrchestrationRepository(pool);
    const logged = await repo.logEvent({
      workId: workId("w-smoke-tz-evt2"),
      eventType: "phase_advanced",
      agentId: undefined,
      details: {},
    });
    expect(logged.ok).toBe(true);
    if (!logged.ok) return;

    const events = await repo.findByWorkId(workId("w-smoke-tz-evt2"));
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const read = events.value.find((e) => e.id === logged.value.id);
    expect(read).toBeDefined();

    // created_at is TIMESTAMP(0): sub-second precision is lost in the
    // roundtrip. The timezone bug shifted instants by whole hours, so a
    // 2-second tolerance pins it without flaking on truncation.
    const deltaMs = Math.abs(
      new Date(read!.createdAt).getTime() - new Date(logged.value.createdAt).getTime(),
    );
    expect(deltaMs).toBeLessThan(2000);
  });

  it("search_embeddings.updated_at is written with UTC wall-clock digits", async () => {
    const repo = new DoltSearchIndexRepository(pool);
    const indexed = await repo.indexArticle(
      "k-smoke-tz",
      "tz probe",
      "embedding timezone probe body",
      "knowledge",
    );
    expect(indexed.ok).toBe(true);
    const storedEmb = await repo.storeEmbedding("k-smoke-tz", [0.25, 0.5]);
    expect(storedEmb.ok).toBe(true);

    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT CAST(updated_at AS CHAR) AS chr FROM search_embeddings WHERE doc_id = 'k-smoke-tz'",
    );
    // The column holds bare digits; reinterpreting them as UTC must land on
    // "now". Local digits (the CURRENT_TIMESTAMP default on an AEST server)
    // would be off by the UTC offset.
    const digits = String(rows[0]?.["chr"]);
    const asUtcInstant = new Date(`${digits.replace(" ", "T")}Z`).getTime();
    expect(Math.abs(asUtcInstant - Date.now())).toBeLessThan(10_000);
  });
});
