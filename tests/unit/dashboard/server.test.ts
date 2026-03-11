import { describe, expect, it } from "vitest";
import {
  getDashboardReadToolName,
  summarizeDashboardReadInput,
  summarizeDashboardReadOutput,
} from "../../../src/dashboard/server.js";

describe("dashboard read telemetry helpers", () => {
  it("canonicalizes dashboard read tool names for special routes", () => {
    expect(getDashboardReadToolName("overview")).toBe("dashboard.read.overview");
    expect(getDashboardReadToolName("tickets/TKT-12345678")).toBe("dashboard.read.tickets.detail");
    expect(getDashboardReadToolName("tickets/metrics")).toBe("dashboard.read.tickets.metrics");
    expect(getDashboardReadToolName("search/debug")).toBe("dashboard.read.search.debug");
    expect(getDashboardReadToolName("dependency-graph")).toBe("dashboard.read.dependency_graph");
    expect(getDashboardReadToolName("knowledge-graph")).toBe("dashboard.read.knowledge_graph");
    expect(getDashboardReadToolName("export/audit")).toBe("dashboard.read.export.audit");
  });

  it("summarizes input without leaking query values", () => {
    const url = new URL("http://localhost:3141/api/search/debug?query=secret+token&scope=src%2F&limit=10");

    expect(summarizeDashboardReadInput("search/debug", url)).toEqual({
      route: "search/debug",
      queryKeys: ["limit", "query", "scope"],
    });
    expect(summarizeDashboardReadInput("tickets/TKT-12345678", new URL("http://localhost:3141/api/tickets/TKT-12345678"))).toEqual({
      route: "tickets/:ticketId",
      queryKeys: [],
    });
  });

  it("summarizes outputs by shape instead of storing full payloads", () => {
    expect(summarizeDashboardReadOutput([{ id: 1 }, { id: 2 }])).toEqual({
      shape: "array",
      count: 2,
    });
    expect(summarizeDashboardReadOutput({ totalAgents: 4, activeSessions: 2, extra: true })).toEqual({
      shape: "object",
      keys: ["activeSessions", "extra", "totalAgents"],
    });
    expect(summarizeDashboardReadOutput(null)).toEqual({ shape: "null" });
  });
});
