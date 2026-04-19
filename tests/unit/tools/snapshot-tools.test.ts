import { describe, it, expect } from "vitest";
import {
  snapshotToolDefinitions,
  handleSnapshotTool,
} from "../../../src/tools/snapshot-tools.js";
import { SnapshotService } from "../../../src/context/snapshot-service.js";
import { InMemorySnapshotRepository } from "../../../src/context/snapshot-in-memory-repository.js";
import type { Logger } from "../../../src/core/logger.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

function createService() {
  return new SnapshotService({
    repo: new InMemorySnapshotRepository(),
    logger: noopLogger,
    maxAgeMinutes: 30,
  });
}

function parseResponseText(text: string): unknown {
  return JSON.parse(text);
}

describe("snapshotToolDefinitions", () => {
  it("returns three tools with non-empty name, description, and schema", () => {
    const defs = snapshotToolDefinitions();
    expect(defs).toHaveLength(3);
    for (const def of defs) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema.type).toBe("object");
    }
  });

  it("exposes the expected tool names", () => {
    const names = snapshotToolDefinitions().map((d) => d.name).sort();
    expect(names).toEqual([
      "compare_environment_snapshots",
      "get_latest_environment_snapshot",
      "record_environment_snapshot",
    ]);
  });
});

describe("handleSnapshotTool — record_environment_snapshot", () => {
  it("records a valid snapshot and returns id + capturedAt", async () => {
    const service = createService();
    const res = await handleSnapshotTool(
      "record_environment_snapshot",
      { agentId: "agent-1", cwd: "/tmp" },
      service,
    );
    expect(res.isError).toBeFalsy();
    const block = res.content[0];
    if (!block || block.type !== "text") throw new Error("expected text content");
    const body = parseResponseText(block.text) as { id: string; capturedAt: string };
    expect(body.id).toMatch(/^s-/);
    expect(typeof body.capturedAt).toBe("string");
  });

  it("rejects oversized raw blobs at the tool boundary", async () => {
    const service = createService();
    const res = await handleSnapshotTool(
      "record_environment_snapshot",
      { agentId: "agent-1", cwd: "/tmp", raw: "x".repeat(600_000) },
      service,
    );
    expect(res.isError).toBe(true);
  });

  it("surfaces ValidationError from the service for bad input", async () => {
    const service = createService();
    const res = await handleSnapshotTool(
      "record_environment_snapshot",
      { cwd: "/tmp" },
      service,
    );
    expect(res.isError).toBe(true);
  });
});

describe("handleSnapshotTool — get_latest_environment_snapshot", () => {
  it("returns snapshot:null when nothing has been recorded", async () => {
    const service = createService();
    const res = await handleSnapshotTool(
      "get_latest_environment_snapshot",
      { agentId: "nobody" },
      service,
    );
    expect(res.isError).toBeFalsy();
    const block = res.content[0];
    if (!block || block.type !== "text") throw new Error("expected text content");
    const body = parseResponseText(block.text) as { snapshot: unknown };
    expect(body.snapshot).toBeNull();
  });

  it("returns the recorded snapshot with ageSeconds + stale", async () => {
    const service = createService();
    await service.record({ agentId: "agent-1", cwd: "/tmp" });
    const res = await handleSnapshotTool(
      "get_latest_environment_snapshot",
      { agentId: "agent-1" },
      service,
    );
    expect(res.isError).toBeFalsy();
    const block = res.content[0];
    if (!block || block.type !== "text") throw new Error("expected text content");
    const body = parseResponseText(block.text) as {
      snapshot: { agentId: string; cwd: string };
      ageSeconds: number;
      stale: boolean;
    };
    expect(body.snapshot.agentId).toBe("agent-1");
    expect(body.snapshot.cwd).toBe("/tmp");
    expect(body.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(body.stale).toBe(false);
  });

  it("rejects when neither agentId nor workId is provided", async () => {
    const service = createService();
    const res = await handleSnapshotTool(
      "get_latest_environment_snapshot",
      {},
      service,
    );
    expect(res.isError).toBe(true);
  });
});

describe("handleSnapshotTool — compare_environment_snapshots", () => {
  it("returns a diff for two known snapshots", async () => {
    const service = createService();
    const left = await service.record({ agentId: "agent-1", cwd: "/a" });
    const right = await service.record({ agentId: "agent-1", cwd: "/b" });
    if (!left.ok || !right.ok) throw new Error("seed failed");
    const res = await handleSnapshotTool(
      "compare_environment_snapshots",
      { leftId: left.value.id, rightId: right.value.id },
      service,
    );
    expect(res.isError).toBeFalsy();
    const block = res.content[0];
    if (!block || block.type !== "text") throw new Error("expected text content");
    const diff = parseResponseText(block.text) as { cwdChanged: boolean };
    expect(diff.cwdChanged).toBe(true);
  });

  it("requires both leftId and rightId", async () => {
    const service = createService();
    const res = await handleSnapshotTool(
      "compare_environment_snapshots",
      { leftId: "s-only-one" },
      service,
    );
    expect(res.isError).toBe(true);
  });
});

describe("handleSnapshotTool — unknown", () => {
  it("returns NOT_FOUND for unknown tool names", async () => {
    const service = createService();
    const res = await handleSnapshotTool("frobnicate_snapshot", {}, service);
    expect(res.isError).toBe(true);
  });
});
