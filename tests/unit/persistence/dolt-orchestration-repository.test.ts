import { describe, it, expect, vi } from "vitest";
import type { Pool } from "mysql2/promise";
import { DoltOrchestrationRepository } from "../../../src/persistence/dolt-orchestration-repository.js";
import { timestamp } from "../../../src/core/types.js";

describe("DoltOrchestrationRepository", () => {
  it("parses JSON details when the driver returns a string", () => {
    const repo = new DoltOrchestrationRepository({} as Pool);
    const parseEventRow = (repo as unknown as {
      parseEventRow: (row: {
        id: string;
        work_id: string;
        event_type: string;
        agent_id?: string | null;
        details: string | Record<string, unknown> | null;
        created_at: string;
      }) => { details: Record<string, unknown> };
    }).parseEventRow.bind(repo);

    const event = parseEventRow({
      id: "evt-1",
      work_id: "w-1",
      event_type: "phase_advanced",
      agent_id: null,
      details: "{\"to\":\"review\"}",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    expect(event.details).toEqual({ to: "review" });
  });

  it("accepts already-decoded JSON details from the driver", () => {
    const repo = new DoltOrchestrationRepository({} as Pool);
    const parseEventRow = (repo as unknown as {
      parseEventRow: (row: {
        id: string;
        work_id: string;
        event_type: string;
        agent_id?: string | null;
        details: string | Record<string, unknown> | null;
        created_at: string;
      }) => { details: Record<string, unknown> };
    }).parseEventRow.bind(repo);

    const event = parseEventRow({
      id: "evt-2",
      work_id: "w-2",
      event_type: "dependency_blocked",
      agent_id: "agent-1",
      details: { blockedById: "w-1" },
      created_at: "2026-01-01T00:00:00.000Z",
    });

    expect(event.details).toEqual({ blockedById: "w-1" });
  });

  describe("findInWindow", () => {
    function poolMock(rows: unknown[] = []) {
      const execute = vi.fn().mockResolvedValue([rows, []]);
      return { pool: { execute } as unknown as Pool, execute };
    }

    it("emits BETWEEN-bounded SQL ordered ascending by created_at", async () => {
      const { pool, execute } = poolMock();
      const repo = new DoltOrchestrationRepository(pool);
      const start = timestamp("2026-05-13T00:00:00.000Z");
      const end = timestamp("2026-05-13T01:00:00.000Z");

      await repo.findInWindow(start, end);

      expect(execute).toHaveBeenCalledTimes(1);
      const [sql, params] = execute.mock.calls[0]!;
      expect(sql).toMatch(/BETWEEN \? AND \?/);
      expect(sql).toMatch(/ORDER BY created_at ASC/);
      expect(sql).not.toMatch(/LIMIT/);
      expect(params).toEqual([start, end]);
    });

    it("adds LIMIT clause and binds the limit when provided", async () => {
      const { pool, execute } = poolMock();
      const repo = new DoltOrchestrationRepository(pool);
      const start = timestamp("2026-05-13T00:00:00.000Z");
      const end = timestamp("2026-05-13T01:00:00.000Z");

      await repo.findInWindow(start, end, 42);

      const [sql, params] = execute.mock.calls[0]!;
      expect(sql).toMatch(/LIMIT \?/);
      expect(params).toEqual([start, end, 42]);
    });

    it("maps rows through parseEventRow so the JSON details column is decoded", async () => {
      const { pool } = poolMock([
        {
          id: "evt-99",
          work_id: "w-99",
          event_type: "phase_advanced",
          agent_id: null,
          details: "{\"to\":\"done\"}",
          created_at: "2026-05-13T00:30:00.000Z",
        },
      ]);
      const repo = new DoltOrchestrationRepository(pool);

      const result = await repo.findInWindow(
        timestamp("2026-05-13T00:00:00.000Z"),
        timestamp("2026-05-13T01:00:00.000Z"),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.details).toEqual({ to: "done" });
    });
  });
});
