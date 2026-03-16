import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock queries before importing server
vi.mock("../../../src/db/queries.js", () => ({
  listWorkGroups: vi.fn(),
  getWorkGroupTickets: vi.fn(),
}));

import { buildConvoyStatus } from "../../../src/dashboard/server.js";
import * as queries from "../../../src/db/queries.js";
import type { DashboardDeps } from "../../../src/dashboard/api.js";

const mockListWorkGroups = vi.mocked(queries.listWorkGroups);
const mockGetWorkGroupTickets = vi.mocked(queries.getWorkGroupTickets);

function fakeDeps(): DashboardDeps {
  return { db: {} as DashboardDeps["db"], repoId: 1, repoPath: "/test", bus: {} as DashboardDeps["bus"], globalDb: null };
}

const NOW = "2026-03-16T12:00:00Z";

function makeWorkGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    repoId: 1,
    groupId: "WG-test001",
    title: "Test Group",
    description: null,
    status: "open",
    createdBy: "agent-1",
    tagsJson: null,
    createdAt: NOW,
    updatedAt: NOW,
    currentWave: 0,
    integrationBranch: "agora/convoy/WG-test001",
    wavePlanJson: JSON.stringify({ waves: [["TKT-a", "TKT-b"], ["TKT-c"]] }),
    launchedAt: NOW,
    ...overrides,
  };
}

function makeTicketRow(ticketId: string, waveStatus = "dispatched", assigneeAgentId: string | null = null) {
  return {
    work_group_tickets: { id: 1, workGroupId: 1, ticketId: 1, addedAt: NOW, waveNumber: 0, waveStatus: waveStatus ?? "pending" },
    tickets: { id: 1, ticketId, assigneeAgentId, status: "approved" },
  } as unknown as ReturnType<typeof queries.getWorkGroupTickets>[number];
}

describe("buildConvoyStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns launched convoy with correct wave structure", () => {
    mockListWorkGroups.mockReturnValue([makeWorkGroup({ currentWave: 1 })] as never);
    mockGetWorkGroupTickets.mockReturnValue([
      makeTicketRow("TKT-a", "merged"),
      makeTicketRow("TKT-b", "merged"),
      makeTicketRow("TKT-c", "dispatched"),
    ] as never);

    const result = buildConvoyStatus(fakeDeps());
    expect(result).toHaveLength(1);
    const convoy = result[0]!;
    expect(convoy.groupId).toBe("WG-test001");
    expect(convoy.status).toBe("active");
    expect(convoy.totalWaves).toBe(2);
    expect(convoy.currentWave).toBe(1);
    expect(convoy.waves).toHaveLength(2);
    // Wave 0 is completed (currentWave=1 > 0)
    expect(convoy.waves[0]!.status).toBe("completed");
    // Wave 1 is active (currentWave=1 === 1)
    expect(convoy.waves[1]!.status).toBe("active");
  });

  it("filters by groupId when provided", () => {
    mockListWorkGroups.mockReturnValue([
      makeWorkGroup({ id: 1, groupId: "WG-aaa" }),
      makeWorkGroup({ id: 2, groupId: "WG-bbb" }),
    ] as never);
    mockGetWorkGroupTickets.mockReturnValue([] as never);

    const result = buildConvoyStatus(fakeDeps(), "WG-aaa");
    expect(result).toHaveLength(1);
    expect(result[0]!.groupId).toBe("WG-aaa");
  });

  it("empty result when no convoys launched", () => {
    mockListWorkGroups.mockReturnValue([makeWorkGroup({ launchedAt: null })] as never);

    const result = buildConvoyStatus(fakeDeps());
    expect(result).toHaveLength(0);
  });

  it("wave status: completed/active/pending based on currentWave", () => {
    mockListWorkGroups.mockReturnValue([
      makeWorkGroup({
        currentWave: 1,
        wavePlanJson: JSON.stringify({ waves: [["TKT-a"], ["TKT-b"], ["TKT-c"]] }),
      }),
    ] as never);
    mockGetWorkGroupTickets.mockReturnValue([] as never);

    const result = buildConvoyStatus(fakeDeps());
    const waves = result[0]!.waves;
    expect(waves[0]!.status).toBe("completed");
    expect(waves[1]!.status).toBe("active");
    expect(waves[2]!.status).toBe("pending");
  });

  it("ticket status from waveStatus field", () => {
    mockListWorkGroups.mockReturnValue([
      makeWorkGroup({
        currentWave: 0,
        wavePlanJson: JSON.stringify({ waves: [["TKT-a", "TKT-b"]] }),
      }),
    ] as never);
    mockGetWorkGroupTickets.mockReturnValue([
      makeTicketRow("TKT-a", "merged", "agent-1"),
      makeTicketRow("TKT-b", "in_progress", "agent-2"),
    ] as never);

    const result = buildConvoyStatus(fakeDeps());
    const tickets = result[0]!.waves[0]!.tickets;
    expect(tickets[0]).toMatchObject({ ticketId: "TKT-a", status: "merged", agentId: "agent-1" });
    expect(tickets[1]).toMatchObject({ ticketId: "TKT-b", status: "in_progress", agentId: "agent-2" });
  });

  it("completed convoy has status completed", () => {
    mockListWorkGroups.mockReturnValue([makeWorkGroup({ status: "completed" })] as never);
    mockGetWorkGroupTickets.mockReturnValue([] as never);

    const result = buildConvoyStatus(fakeDeps());
    expect(result[0]!.status).toBe("completed");
  });
});
