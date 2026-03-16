import type { InsightStream } from "../core/insight-stream.js";
import type { AgoraConfig } from "../core/config.js";
import type { AgoraContext } from "../core/context.js";
import { runOrchestrator, type OrchestratorCallbacks, type OrchestratorConfig } from "../orchestrator/loop.js";
import { createAgoraContextLoader } from "../core/context-loader.js";
import { createAgoraServer } from "../server.js";
import { getToolRunner } from "../tools/tool-runner.js";
import { recordDashboardEvent } from "../dashboard/events.js";
import { cleanupOrphanedWorktrees } from "../git/worktree.js";
import * as queries from "../db/queries.js";
import { spawn } from "node:child_process";

export async function cmdOrchestrate(
  config: AgoraConfig,
  insight: InsightStream,
  args: string[],
): Promise<void> {
  const groupId = getArg(args, "--group");
  if (!groupId) {
    insight.error("--group WG-xxx is required");
    process.exit(1);
  }

  const maxConcurrentAgents = parseInt(getArg(args, "--agents") ?? "3", 10);
  const testCommand = getArg(args, "--test-command");
  const testTimeoutMs = parseInt(getArg(args, "--test-timeout") ?? "120000", 10);
  const pollIntervalMs = parseInt(getArg(args, "--poll-interval") ?? "10000", 10);
  const llmFallback = args.includes("--llm-fallback");
  const maxRetries = parseInt(getArg(args, "--max-retries") ?? "1", 10);

  let context: AgoraContext | null = null;
  const baseGetContext = createAgoraContextLoader(config, insight, { startLifecycleSweep: false });
  const getContext = async () => {
    context ??= await baseGetContext();
    return context;
  };

  const server = createAgoraServer(config, { insight, getContext });
  const runner = getToolRunner(server);

  const orchConfig: OrchestratorConfig = {
    groupId,
    maxConcurrentAgents,
    testCommand,
    testTimeoutMs,
    pollIntervalMs,
    llmFallback,
    maxRetries,
    repoPath: config.repoPath,
  };

  const callbacks: OrchestratorCallbacks = {
    callTool: async (name, params) => {
      const result = await runner.callTool(name, params);
      if (!result.ok) {
        throw new Error(`Tool ${name} failed: ${result.message ?? result.errorCode}`);
      }
      return result.result;
    },
    spawnProcess: async (worktreePath, ticketId) => {
      const child = spawn("node", [
        process.argv[1] ?? "agora",
        "loop", "dev",
        "--ticket", ticketId,
        "--limit", "1",
      ], {
        cwd: worktreePath,
        stdio: "ignore",
        detached: true,
      });
      child.unref();

      return {
        pid: child.pid ?? 0,
        ticketId,
        sessionId: `spawn-${ticketId}`,
      };
    },
    killProcess: async (pid) => {
      try {
        process.kill(pid);
      } catch {
        // process may already be dead
      }
    },
    log: (level, msg) => {
      if (level === "error") insight.error(msg);
      else if (level === "warn") insight.warn(msg);
      else insight.info(msg);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onProblem: llmFallback
      ? async (problem) => {
          insight.warn(`Problem: ${problem.kind} — ${JSON.stringify(problem)}`);
          return { action: "skip" };
        }
      : undefined,
    onEvent: (event) => {
      insight.info(`[convoy] ${event.type}`);
      if (context) {
        try {
          recordDashboardEvent(context.db, context.repoId, {
            type: mapConvoyEventType(event.type),
            data: event as unknown as Record<string, unknown>,
          });
        } catch {
          // non-fatal
        }
      }
    },
    cleanupWorktrees: async () => {
      try {
        const ctx = await getContext();
        const active = queries.getActiveSessions(ctx.db).map((s) => s.id);
        const result = await cleanupOrphanedWorktrees(config.repoPath, new Set(active));
        if (result.removed.length > 0) {
          insight.info(`Cleaned up ${result.removed.length} orphaned worktree(s)`);
        }
      } catch {
        // non-fatal
      }
    },
  };

  insight.info(`Starting orchestration for ${groupId} (max ${maxConcurrentAgents} agents)`);
  const result = await runOrchestrator(orchConfig, callbacks);

  insight.info("=== Orchestration Complete ===");
  insight.info(`  Waves: ${result.wavesCompleted}/${result.totalWaves}`);
  insight.info(`  Merged: ${result.mergedTickets.length} tickets`);
  if (result.skippedTickets.length > 0) {
    insight.warn(`  Skipped: ${result.skippedTickets.join(", ")}`);
  }
  if (result.failedTickets.length > 0) {
    insight.error(`  Failed: ${result.failedTickets.join(", ")}`);
  }
  insight.info(`  Final merged to main: ${result.finalMerged}`);
  insight.info(`  Duration: ${result.durationMs}ms`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

type ConvoyEventType = "convoy_started" | "convoy_wave_started" | "convoy_agent_spawned"
  | "convoy_agent_finished" | "convoy_wave_advanced" | "convoy_completed";

function mapConvoyEventType(eventType: string): ConvoyEventType {
  switch (eventType) {
    case "convoy_started": return "convoy_started";
    case "wave_started": return "convoy_wave_started";
    case "agent_spawned": return "convoy_agent_spawned";
    case "agent_finished": return "convoy_agent_finished";
    case "wave_advanced": return "convoy_wave_advanced";
    case "convoy_completed": return "convoy_completed";
    default: return "convoy_started"; // fallback
  }
}
