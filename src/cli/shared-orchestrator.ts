import type { InsightStream } from "../core/insight-stream.js";
import type { AgoraConfig } from "../core/config.js";
import type { AgoraContext } from "../core/context.js";
import type { OrchestratorCallbacks } from "../orchestrator/loop.js";
import { createAgoraContextLoader } from "../core/context-loader.js";
import { createAgoraServer } from "../server.js";
import { getToolRunner, type ToolRunner } from "../tools/tool-runner.js";
import { recordDashboardEvent } from "../core/events.js";
import { cleanupOrphanedWorktrees } from "../git/worktree.js";
import * as queries from "../db/queries.js";
import { spawn } from "node:child_process";

export interface SharedOrchestratorContext {
  getContext: () => Promise<AgoraContext>;
  runner: ToolRunner;
}

export function createSharedContext(
  config: AgoraConfig,
  insight: InsightStream,
): SharedOrchestratorContext {
  let context: AgoraContext | null = null;
  const baseGetContext = createAgoraContextLoader(config, insight, { startLifecycleSweep: false });
  const getContext = async () => {
    context ??= await baseGetContext();
    return context;
  };

  const server = createAgoraServer(config, { insight, getContext });
  const runner = getToolRunner(server);

  return { getContext, runner };
}

export function createOrchestratorCallbacks(
  config: AgoraConfig,
  insight: InsightStream,
  shared: SharedOrchestratorContext,
  options: { spawnCommand?: string; llmFallback?: boolean },
): OrchestratorCallbacks {
  let resolvedContext: AgoraContext | null = null;

  return {
    callTool: async (name, params) => {
      const result = await shared.runner.callTool(name, params);
      if (!result.ok) {
        throw new Error(`Tool ${name} failed: ${result.message ?? result.errorCode}`);
      }
      return result.result;
    },
    spawnProcess: options.spawnCommand
      ? async (worktreePath, ticketId) => {
          const expanded = options.spawnCommand!
            .replaceAll("{ticketId}", ticketId)
            .replaceAll("{worktreePath}", worktreePath);
          const parts = expanded.split(/\s+/);
          const child = spawn(parts[0]!, parts.slice(1), {
            cwd: worktreePath,
            stdio: "ignore",
            detached: true,
          });
          child.unref();
          return { pid: child.pid ?? 0, ticketId, sessionId: `spawn-${ticketId}` };
        }
      : async (worktreePath, ticketId) => {
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
          return { pid: child.pid ?? 0, ticketId, sessionId: `spawn-${ticketId}` };
        },
    killProcess: async (pid) => {
      try { process.kill(pid); } catch { /* may already be dead */ }
    },
    log: (level, msg) => {
      if (level === "error") insight.error(msg);
      else if (level === "warn") insight.warn(msg);
      else insight.info(msg);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onProblem: options.llmFallback
      ? async (problem) => {
          insight.warn(`Problem: ${problem.kind} — ${JSON.stringify(problem)}`);
          return { action: "skip" };
        }
      : undefined,
    onEvent: (event) => {
      insight.info(`[convoy] ${event.type}`);
      if (resolvedContext) {
        try {
          const { type: _t, ...data } = event as unknown as Record<string, unknown>;
          recordDashboardEvent(resolvedContext.db, resolvedContext.repoId, {
            type: mapConvoyEventType(event.type),
            data,
          });
        } catch { /* non-fatal */ }
      }
      // Lazy resolve context on first event
      if (!resolvedContext) {
        shared.getContext().then((ctx) => { resolvedContext = ctx; }).catch(() => {});
      }
    },
    cleanupWorktrees: async () => {
      try {
        const ctx = await shared.getContext();
        const active = queries.getActiveSessions(ctx.db).map((s) => s.id);
        const result = await cleanupOrphanedWorktrees(config.repoPath, new Set(active));
        if (result.removed.length > 0) {
          insight.info(`Cleaned up ${result.removed.length} orphaned worktree(s)`);
        }
      } catch { /* non-fatal */ }
    },
  };
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
    default: return "convoy_started";
  }
}

export function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}
