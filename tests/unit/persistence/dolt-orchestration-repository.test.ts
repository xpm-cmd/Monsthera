import { describe, it, expect } from "vitest";
import type { Pool } from "mysql2/promise";
import { DoltOrchestrationRepository } from "../../../src/persistence/dolt-orchestration-repository.js";

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
});
