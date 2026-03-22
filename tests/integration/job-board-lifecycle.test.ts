import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJobTools } from "../../src/tools/job-tools.js";
import { CoordinationBus } from "../../src/coordination/bus.js";
import { createTestDb, seedAgent } from "../fixtures/test-db.js";
import { FakeServer } from "../fixtures/fake-server.js";
import * as queries from "../../src/db/queries.js";

describe("job board lifecycle", () => {
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  let bus: CoordinationBus;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);

    seedAgent(db, "agent-fac", "session-fac", { name: "Facilitator", role: "facilitator", trustTier: "A" });
    seedAgent(db, "agent-dev", "session-dev", { name: "Developer", role: "developer", trustTier: "A" });

    server = new FakeServer();
    registerJobTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      repoPath: "/test",
      config: {
        registrationAuth: { enabled: false, observerOpenRegistration: true, roleTokens: {} },
        claimEnforceMode: "advisory",
      },
      insight: { info: () => undefined, warn: () => undefined, debug: () => undefined },
      bus,
    } as any));
  });

  afterEach(() => {
    sqlite.close();
  });

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  function parse(result: { content: Array<{ type: string; text: string }> }) {
    return JSON.parse(result.content[0]!.text);
  }

  it("creates a loop from template and lists open slots", async () => {
    const createResult = await handler("create_loop")({
      loopId: "test-loop",
      template: "small-team",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });
    expect(createResult.isError).not.toBe(true);

    const createData = parse(createResult);
    expect(createData.slotsCreated).toBeGreaterThan(0);

    const listResult = await handler("list_jobs")({
      loopId: "test-loop",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });
    expect(listResult.isError).not.toBe(true);

    const listData = parse(listResult);
    expect(listData.slots.length).toBe(createData.slotsCreated);
    for (const slot of listData.slots) {
      expect(slot.status).toBe("open");
    }
  });

  it("developer claims a job slot", async () => {
    await handler("create_loop")({
      loopId: "test-loop",
      template: "small-team",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });

    const listResult = await handler("list_jobs")({
      loopId: "test-loop",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });
    const listData = parse(listResult);
    const devSlot = listData.slots.find((s: { role: string }) => s.role === "developer");
    expect(devSlot).toBeDefined();

    const claimResult = await handler("claim_job")({
      slotId: devSlot.slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(claimResult.isError).not.toBe(true);

    const claimData = parse(claimResult);
    expect(claimData.claimed).toBe(true);
    expect(typeof claimData.systemPrompt).toBe("string");
  });

  it("updates job progress and completes", async () => {
    await handler("create_loop")({
      loopId: "test-loop",
      template: "small-team",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });

    const listResult = await handler("list_jobs")({
      loopId: "test-loop",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });
    const devSlot = parse(listResult).slots.find((s: { role: string }) => s.role === "developer");

    await handler("claim_job")({
      slotId: devSlot.slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const progressResult = await handler("update_job_progress")({
      slotId: devSlot.slotId,
      status: "active",
      progressNote: "working on it",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(progressResult.isError).not.toBe(true);

    const progressData = parse(progressResult);
    expect(progressData.updated).toBe(true);
    expect(progressData.status).toBe("active");

    const completeResult = await handler("complete_job")({
      slotId: devSlot.slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(completeResult.isError).not.toBe(true);

    const completeData = parse(completeResult);
    expect(completeData.completed).toBe(true);
  });

  it("prevents double-claiming a slot", async () => {
    await handler("create_loop")({
      loopId: "test-loop",
      template: "small-team",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });

    const listResult = await handler("list_jobs")({
      loopId: "test-loop",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });
    const devSlot = parse(listResult).slots.find((s: { role: string }) => s.role === "developer");

    await handler("claim_job")({
      slotId: devSlot.slotId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    seedAgent(db, "agent-dev2", "session-dev2", { name: "Developer 2", role: "developer", trustTier: "A" });

    const secondClaim = await handler("claim_job")({
      slotId: devSlot.slotId,
      agentId: "agent-dev2",
      sessionId: "session-dev2",
    });

    expect(secondClaim.isError).toBe(true);
  });
});
