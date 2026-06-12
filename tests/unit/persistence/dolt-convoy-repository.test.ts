import { describe, it, expect, vi } from "vitest";
import type { Pool } from "mysql2/promise";
import { DoltConvoyRepository } from "../../../src/persistence/dolt-convoy-repository.js";
import { convoyId } from "../../../src/core/types.js";

function poolMock(rows: unknown[]): Pool {
  return { execute: vi.fn().mockResolvedValue([rows, []]) } as unknown as Pool;
}

describe("DoltConvoyRepository", () => {
  it("coerces created_at/completed_at driver Dates to ISO strings (w-arq1yroe)", async () => {
    const repo = new DoltConvoyRepository(
      poolMock([
        {
          id: "c-tz1",
          lead_work_id: "w-lead",
          member_work_ids: JSON.stringify(["w-lead", "w-m1"]),
          goal: "ship the fix",
          status: "completed",
          target_phase: "implementation",
          created_at: new Date("2026-06-11T13:02:54.000Z"),
          completed_at: new Date("2026-06-11T14:00:00.000Z"),
        },
      ]),
    );

    const found = await repo.findById(convoyId("c-tz1"));
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.createdAt).toBe("2026-06-11T13:02:54.000Z");
    expect(found.value.completedAt).toBe("2026-06-11T14:00:00.000Z");
  });
});
