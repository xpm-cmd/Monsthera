import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSandbox, registerSandboxAgent, type SandboxContext } from "../../../src/simulation/harness.js";
import { TelemetryTracker } from "../../../src/simulation/telemetry.js";
import {
  computeScorecard,
  appendResult,
  readResults,
  computeDeltas,
  type MetricsInput,
} from "../../../src/simulation/metrics.js";
import type { SimulationResult } from "../../../src/simulation/types.js";

describe("metrics", () => {
  let sandbox: SandboxContext;
  let tempDir: string;
  let telemetry: TelemetryTracker;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agora-metrics-"));
    sandbox = createSandbox({ repoPath: tempDir });
    telemetry = new TelemetryTracker();
  });

  afterEach(async () => {
    sandbox.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeMetricsInput(overrides?: Partial<MetricsInput>): MetricsInput {
    return {
      db: sandbox.db,
      repoId: sandbox.repoId,
      telemetry,
      ticketRetrievalPrecision5: 0.8,
      codeRetrievalPrecision5: 0.7,
      testPassRate: 1.0,
      regressionRate: 0.0,
      mergeSuccessRate: 1.0,
      workflowOverheadPct: 0.1,
      ...overrides,
    };
  }

  describe("computeScorecard", () => {
    it("returns valid scorecard with no tickets", () => {
      const scorecard = computeScorecard(makeMetricsInput());

      expect(scorecard.velocity.avgTimeToResolveMs).toBe(0);
      expect(scorecard.velocity.avgTimeInReviewMs).toBe(0);
      expect(scorecard.autonomy.firstPassSuccessRate).toBe(0);
      expect(scorecard.quality.testPassRate).toBe(1.0);
      expect(scorecard.cost.note).toBe("operational estimate, not accounting-grade");
      expect(scorecard.compositeScore).toBeGreaterThanOrEqual(0);
      expect(scorecard.compositeScore).toBeLessThanOrEqual(1);
    });

    it("computes velocity from resolved tickets", () => {
      const { agentId, sessionId } = registerSandboxAgent(sandbox, "dev-1");
      const baseTime = Date.now();

      // Create a ticket
      sandbox.sqlite
        .prepare([
          "INSERT INTO tickets (",
          "  repo_id, ticket_id, title, description, status,",
          "  creator_agent_id, creator_session_id, commit_sha, created_at, updated_at",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join("\n"))
        .run(
          sandbox.repoId, "TKT-vel01", "Velocity test", "desc", "resolved",
          agentId, sessionId, "sha1",
          new Date(baseTime).toISOString(),
          new Date(baseTime + 60_000).toISOString(),
        );

      const ticketRow = sandbox.sqlite
        .prepare("SELECT id FROM tickets WHERE ticket_id = 'TKT-vel01'")
        .get() as { id: number };

      // Record history: created → in_progress → resolved (60s)
      sandbox.sqlite
        .prepare(
          "INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(ticketRow.id, null, "in_progress", agentId, sessionId, new Date(baseTime + 10_000).toISOString());
      sandbox.sqlite
        .prepare(
          "INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(ticketRow.id, "in_progress", "resolved", agentId, sessionId, new Date(baseTime + 60_000).toISOString());

      const scorecard = computeScorecard(makeMetricsInput());

      expect(scorecard.velocity.avgTimeToResolveMs).toBe(60_000);
    });

    it("computes segment-aware time-in-review", () => {
      const { agentId, sessionId } = registerSandboxAgent(sandbox, "dev-review");
      const baseTime = Date.now();

      sandbox.sqlite
        .prepare([
          "INSERT INTO tickets (",
          "  repo_id, ticket_id, title, description, status,",
          "  creator_agent_id, creator_session_id, commit_sha, created_at, updated_at",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join("\n"))
        .run(
          sandbox.repoId, "TKT-review01", "Review test", "desc", "resolved",
          agentId, sessionId, "sha1",
          new Date(baseTime).toISOString(),
          new Date(baseTime + 120_000).toISOString(),
        );

      const ticketRow = sandbox.sqlite
        .prepare("SELECT id FROM tickets WHERE ticket_id = 'TKT-review01'")
        .get() as { id: number };

      // Two review rounds: 10s + 20s = 30s total in review
      const transitions = [
        { from: null, to: "in_progress", offset: 0 },
        { from: "in_progress", to: "in_review", offset: 30_000 },        // enter review (round 1)
        { from: "in_review", to: "ready_for_commit", offset: 40_000 },   // exit review (10s)
        { from: "ready_for_commit", to: "in_review", offset: 60_000 },   // re-enter review (round 2)
        { from: "in_review", to: "ready_for_commit", offset: 80_000 },   // exit review (20s)
        { from: "ready_for_commit", to: "resolved", offset: 120_000 },
      ];

      for (const t of transitions) {
        sandbox.sqlite
          .prepare(
            "INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(ticketRow.id, t.from, t.to, agentId, sessionId, new Date(baseTime + t.offset).toISOString());
      }

      const scorecard = computeScorecard(makeMetricsInput());

      // 10s + 20s = 30s average in review (only 1 ticket)
      expect(scorecard.velocity.avgTimeInReviewMs).toBe(30_000);
    });

    it("computes first-pass success rate", () => {
      const { agentId, sessionId } = registerSandboxAgent(sandbox, "dev-fp");
      const baseTime = Date.now();

      // Ticket 1: resolved on first pass (in_review once, no blocked)
      sandbox.sqlite
        .prepare([
          "INSERT INTO tickets (",
          "  repo_id, ticket_id, title, description, status,",
          "  creator_agent_id, creator_session_id, commit_sha, created_at, updated_at",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join("\n"))
        .run(
          sandbox.repoId, "TKT-fp01", "First pass 1", "desc", "resolved",
          agentId, sessionId, "sha1",
          new Date(baseTime).toISOString(), new Date(baseTime).toISOString(),
        );

      const t1 = (sandbox.sqlite.prepare("SELECT id FROM tickets WHERE ticket_id = 'TKT-fp01'").get() as any).id;
      sandbox.sqlite.prepare(
        "INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(t1, null, "in_review", agentId, sessionId, new Date(baseTime).toISOString());
      sandbox.sqlite.prepare(
        "INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(t1, "in_review", "resolved", agentId, sessionId, new Date(baseTime + 10_000).toISOString());

      // Ticket 2: resolved but entered in_review twice (not first-pass)
      sandbox.sqlite
        .prepare([
          "INSERT INTO tickets (",
          "  repo_id, ticket_id, title, description, status,",
          "  creator_agent_id, creator_session_id, commit_sha, created_at, updated_at",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join("\n"))
        .run(
          sandbox.repoId, "TKT-fp02", "First pass 2", "desc", "resolved",
          agentId, sessionId, "sha1",
          new Date(baseTime).toISOString(), new Date(baseTime).toISOString(),
        );

      const t2 = (sandbox.sqlite.prepare("SELECT id FROM tickets WHERE ticket_id = 'TKT-fp02'").get() as any).id;
      sandbox.sqlite.prepare(
        "INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(t2, null, "in_review", agentId, sessionId, new Date(baseTime).toISOString());
      sandbox.sqlite.prepare(
        "INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(t2, "in_review", "in_progress", agentId, sessionId, new Date(baseTime + 5_000).toISOString());
      sandbox.sqlite.prepare(
        "INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(t2, "in_progress", "in_review", agentId, sessionId, new Date(baseTime + 10_000).toISOString());
      sandbox.sqlite.prepare(
        "INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(t2, "in_review", "resolved", agentId, sessionId, new Date(baseTime + 15_000).toISOString());

      const scorecard = computeScorecard(makeMetricsInput());

      // 1 of 2 tickets succeeded on first pass
      expect(scorecard.autonomy.firstPassSuccessRate).toBe(0.5);
    });

    it("integrates telemetry into cost KPIs", () => {
      telemetry.startTicket("c-1", "haiku", "TKT-1");
      telemetry.addPayload("c-1", 5000, 3000);
      telemetry.completeTicket("c-1", "resolved");

      telemetry.startTicket("c-2", "sonnet", "TKT-2");
      telemetry.addPayload("c-2", 10000, 8000);
      telemetry.completeTicket("c-2", "resolved");

      const scorecard = computeScorecard(makeMetricsInput());

      // avg payload = (5000+3000 + 10000+8000) / 2 = 13000
      expect(scorecard.cost.avgPayloadCharsPerTicket).toBe(13000);
      expect(scorecard.cost.haikuSuccessRate).toBe(1.0);
      expect(scorecard.cost.sonnetSuccessRate).toBe(1.0);
      expect(scorecard.cost.modelDistribution.haiku).toBe(1);
      expect(scorecard.cost.modelDistribution.sonnet).toBe(1);
    });

    it("composite score is between 0 and 1", () => {
      telemetry.startTicket("c-1", "haiku");
      telemetry.addPayload("c-1", 5000, 3000);
      telemetry.completeTicket("c-1", "resolved");

      const scorecard = computeScorecard(makeMetricsInput());

      expect(scorecard.compositeScore).toBeGreaterThanOrEqual(0);
      expect(scorecard.compositeScore).toBeLessThanOrEqual(1);
    });
  });

  describe("JSONL persistence", () => {
    it("appends and reads results", async () => {
      const outputPath = join(tempDir, "results.jsonl");

      const result1: SimulationResult = {
        runId: "sim-001",
        timestamp: new Date().toISOString(),
        gitCommit: "abc123",
        corpusSize: 50,
        durationMs: 30000,
        sources: { backlog: 10, autoDetected: 35, manual: 5 },
        phasesRun: ["A", "B"],
        velocity: { avgTimeToResolveMs: 60000, avgTimeInReviewMs: 10000, workflowOverheadPct: 0.15 },
        autonomy: { firstPassSuccessRate: 0.9, councilApprovalRate: 0.95, mergeSuccessRate: 1.0 },
        quality: { testPassRate: 1.0, regressionRate: 0.0, ticketRetrievalPrecision5: 0.8, codeRetrievalPrecision5: 0.7 },
        cost: { avgPayloadCharsPerTicket: 15000, haikuSuccessRate: 0.85, sonnetSuccessRate: 0.95, escalationCount: 3, modelDistribution: { haiku: 40, sonnet: 10 }, note: "estimate" },
        compositeScore: 0.82,
        deltas: null,
      };

      const result2: SimulationResult = {
        ...result1,
        runId: "sim-002",
        compositeScore: 0.85,
      };

      await appendResult(outputPath, result1);
      await appendResult(outputPath, result2);

      const results = await readResults(outputPath);

      expect(results).toHaveLength(2);
      expect(results[0]!.runId).toBe("sim-001");
      expect(results[1]!.runId).toBe("sim-002");
    });

    it("returns empty array for missing file", async () => {
      const results = await readResults(join(tempDir, "nonexistent.jsonl"));
      expect(results).toHaveLength(0);
    });

    it("each line is valid JSON", async () => {
      const outputPath = join(tempDir, "valid.jsonl");
      const result: SimulationResult = {
        runId: "sim-json",
        timestamp: new Date().toISOString(),
        gitCommit: "abc",
        corpusSize: 10,
        durationMs: 1000,
        sources: { backlog: 0, autoDetected: 10, manual: 0 },
        phasesRun: ["A"],
        velocity: { avgTimeToResolveMs: 0, avgTimeInReviewMs: 0, workflowOverheadPct: 0 },
        autonomy: { firstPassSuccessRate: 0, councilApprovalRate: 0, mergeSuccessRate: 0 },
        quality: { testPassRate: 0, regressionRate: 0, ticketRetrievalPrecision5: 0, codeRetrievalPrecision5: 0 },
        cost: { avgPayloadCharsPerTicket: 0, haikuSuccessRate: 0, sonnetSuccessRate: 0, escalationCount: 0, modelDistribution: { haiku: 0, sonnet: 0 }, note: "test" },
        compositeScore: 0,
        deltas: null,
      };

      await appendResult(outputPath, result);

      const raw = await readFile(outputPath, "utf8");
      const lines = raw.trim().split("\n");
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe("computeDeltas", () => {
    it("returns null when no previous run", () => {
      const scorecard = computeScorecard(makeMetricsInput());
      const deltas = computeDeltas(scorecard, null);
      expect(deltas).toBeNull();
    });

    it("computes per-dimension deltas", () => {
      const prev = computeScorecard(makeMetricsInput({
        testPassRate: 0.9,
        regressionRate: 0.05,
        workflowOverheadPct: 0.2,
      }));

      const current = computeScorecard(makeMetricsInput({
        testPassRate: 1.0,
        regressionRate: 0.0,
        workflowOverheadPct: 0.1,
      }));

      const deltas = computeDeltas(current, prev);

      expect(deltas).not.toBeNull();
      // Quality improved (better test pass, lower regression)
      expect(deltas!.quality).toBeGreaterThan(0);
      // Velocity improved (lower overhead)
      expect(deltas!.velocity).toBeGreaterThan(0);
    });
  });
});
