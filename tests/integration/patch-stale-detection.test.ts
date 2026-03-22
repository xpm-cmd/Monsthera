import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as queries from "../../src/db/queries.js";
import { registerPatchTools } from "../../src/tools/patch-tools.js";
import { registerTicketTools } from "../../src/tools/ticket-tools.js";
import { validatePatch } from "../../src/patches/validator.js";
import { CoordinationBus } from "../../src/coordination/bus.js";
import { createTestDb, seedAgent } from "../fixtures/test-db.js";
import { FakeServer } from "../fixtures/fake-server.js";

vi.mock("../../src/git/operations.js", () => ({
  getHead: vi.fn().mockResolvedValue("abc1234"),
}));

vi.mock("../../src/patches/validator.js", () => ({
  validatePatch: vi.fn(),
}));

describe("patch stale detection", () => {
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  let bus: CoordinationBus;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);

    seedAgent(db, "agent-dev", "session-dev", {
      role: "developer",
      trustTier: "A",
    });

    server = new FakeServer();
    registerTicketTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      repoPath: "/test",
      config: {
        registrationAuth: { enabled: false, observerOpenRegistration: true, roleTokens: {} },
        governance: {
          nonVotingRoles: ["facilitator"],
          modelDiversity: { strict: false, maxVotersPerModel: 10 },
          reviewerIndependence: { strict: false, identityKey: "agent" },
          backlogPlanningGate: { enforce: false, minIterations: 1, requiredDistinctModels: 1 },
          requireBinding: false,
          autoAdvance: false,
          autoAdvanceExcludedTags: [],
        },
        ticketQuorum: { enabled: false, requiredPasses: 1, vetoSpecializations: [] },
      },
      insight: { info: () => undefined, warn: () => undefined, debug: () => undefined },
      bus,
      searchRouter: { rebuildTicketFts: () => {}, searchTickets: () => [] },
    } as any));
    registerPatchTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      repoPath: "/test",
      insight: { info: () => undefined, warn: () => undefined, debug: () => undefined },
      bus,
    } as any));

    vi.mocked(validatePatch).mockResolvedValue({
      proposalId: "P-001",
      valid: true,
      stale: false,
      currentHead: "abc1234",
      dryRunResult: {
        feasible: true,
        touchedPaths: ["src/main.ts"],
        policyViolations: [],
        secretWarnings: [],
        reindexScope: 1,
      },
    });
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  it("accepts patch when baseCommit matches HEAD", async () => {
    vi.mocked(validatePatch).mockResolvedValue({
      proposalId: "P-001",
      valid: true,
      stale: false,
      currentHead: "abc1234",
      dryRunResult: {
        feasible: true,
        touchedPaths: ["src/main.ts"],
        policyViolations: [],
        secretWarnings: [],
        reindexScope: 1,
      },
    });

    const result = await handler("propose_patch")({
      baseCommit: "abc1234",
      diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new",
      message: "fix bug",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.proposalId).toBeTruthy();
    expect(payload.stale).toBe(false);
  });

  it("rejects patch when baseCommit is stale (HEAD changed)", async () => {
    vi.mocked(validatePatch).mockResolvedValue({
      proposalId: "P-002",
      valid: false,
      stale: true,
      currentHead: "def5678",
      dryRunResult: {
        feasible: false,
        touchedPaths: ["src/main.ts"],
        policyViolations: [],
        secretWarnings: [],
        reindexScope: 1,
      },
    });

    const result = await handler("propose_patch")({
      baseCommit: "old_commit",
      diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new",
      message: "stale patch",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.stale).toBe(true);
    expect(payload.currentHead).toBe("def5678");
  });

  it("lists patches and shows correct states", async () => {
    vi.mocked(validatePatch).mockResolvedValue({
      proposalId: "P-003",
      valid: true,
      stale: false,
      currentHead: "abc1234",
      dryRunResult: {
        feasible: true,
        touchedPaths: ["src/main.ts"],
        policyViolations: [],
        secretWarnings: [],
        reindexScope: 1,
      },
    });

    const proposeResult = await handler("propose_patch")({
      baseCommit: "abc1234",
      diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new",
      message: "add feature",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(proposeResult.isError).not.toBe(true);

    const listResult = await handler("list_patches")({
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(listResult.isError).not.toBe(true);
    const listPayload = JSON.parse(listResult.content[0].text);
    expect(listPayload.patches.length).toBeGreaterThanOrEqual(1);

    const proposed = listPayload.patches.find(
      (p: { proposalId: string }) => p.proposalId === "P-003",
    );
    expect(proposed).toBeDefined();
    expect(proposed.state).toBe("validated");
  });
});
