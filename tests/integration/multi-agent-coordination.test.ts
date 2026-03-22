import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as queries from "../../src/db/queries.js";
import { registerAgentTools } from "../../src/tools/agent-tools.js";
import { registerCoordinationTools } from "../../src/tools/coordination-tools.js";
import { CoordinationBus } from "../../src/coordination/bus.js";
import { createTestDb, seedAgent } from "../fixtures/test-db.js";
import { FakeServer } from "../fixtures/fake-server.js";

describe("multi-agent coordination", () => {
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  let bus: CoordinationBus;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);

    seedAgent(db, "agent-dev", "session-dev", { role: "developer" });
    seedAgent(db, "agent-review", "session-review", { role: "reviewer" });

    server = new FakeServer();
    registerAgentTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      repoPath: "/test",
      config: { registrationAuth: { enabled: false, observerOpenRegistration: true, roleTokens: {} }, claimEnforceMode: "advisory" },
      insight: { info: () => undefined, warn: () => undefined, debug: () => undefined },
      bus,
    } as any));
    registerCoordinationTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      repoPath: "/test",
      config: { registrationAuth: { enabled: false, observerOpenRegistration: true, roleTokens: {} }, claimEnforceMode: "advisory" },
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

  it("agent claims files and they are visible", async () => {
    const claimResult = await handler("claim_files")({
      agentId: "agent-dev",
      sessionId: "session-dev",
      paths: ["src/main.ts", "src/utils.ts"],
    });
    const claimData = JSON.parse(claimResult.content[0].text);
    expect(claimData.claimed).toEqual(["src/main.ts", "src/utils.ts"]);

    const statusResult = await handler("agent_status")({
      agentId: "agent-dev",
      detailed: true,
    });
    const statusData = JSON.parse(statusResult.content[0].text);
    expect(statusData.sessions).toBeDefined();
    const activeSessions = statusData.sessions.filter(
      (s: { state: string }) => s.state === "active",
    );
    const claimedFiles = activeSessions.flatMap((s: { claimedFilesJson: string | null }) => {
      try {
        return JSON.parse(s.claimedFilesJson || "[]") as string[];
      } catch {
        return [];
      }
    });
    expect(claimedFiles).toContain("src/main.ts");
    expect(claimedFiles).toContain("src/utils.ts");
  });

  it("agent sends coordination message and receiver polls it", async () => {
    const sendResult = await handler("send_coordination")({
      type: "task_claim",
      payload: { task: "implement auth" },
      to: "agent-review",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const sendData = JSON.parse(sendResult.content[0].text);
    expect(sendData.sent).toBe(true);

    const pollResult = await handler("poll_coordination")({
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const pollData = JSON.parse(pollResult.content[0].text);
    expect(pollData.count).toBeGreaterThanOrEqual(1);
    const taskMsg = pollData.messages.find(
      (m: { from: string; type: string }) => m.from === "agent-dev" && m.type === "task_claim",
    );
    expect(taskMsg).toBeDefined();
    expect(taskMsg.from).toBe("agent-dev");
    expect(taskMsg.type).toBe("task_claim");
  });

  it("broadcast message is visible to all agents", async () => {
    const sendResult = await handler("send_coordination")({
      type: "broadcast",
      payload: { info: "starting deploy" },
      to: null,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const sendData = JSON.parse(sendResult.content[0].text);
    expect(sendData.sent).toBe(true);

    const pollResult = await handler("poll_coordination")({
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const pollData = JSON.parse(pollResult.content[0].text);
    expect(pollData.count).toBeGreaterThanOrEqual(1);
    const broadcastMsg = pollData.messages.find(
      (m: { from: string; type: string }) => m.from === "agent-dev" && m.type === "broadcast",
    );
    expect(broadcastMsg).toBeDefined();
  });

  it("end_session disconnects and releases claims", async () => {
    // First claim some files
    await handler("claim_files")({
      agentId: "agent-dev",
      sessionId: "session-dev",
      paths: ["src/main.ts"],
    });

    // End the session
    const endResult = await handler("end_session")({
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const endData = JSON.parse(endResult.content[0].text);
    expect(endData.ended).toBe(true);

    // Verify agent session is disconnected
    const statusResult = await handler("agent_status")({
      agentId: "agent-dev",
      detailed: true,
    });
    const statusData = JSON.parse(statusResult.content[0].text);
    const disconnected = statusData.sessions.find(
      (s: { id: string; state: string }) => s.id === "session-dev",
    );
    expect(disconnected).toBeDefined();
    expect(disconnected.state).toBe("disconnected");
  });
});
