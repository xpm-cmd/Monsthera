/**
 * `agora swarm` — End-to-end autonomous orchestration command.
 *
 * Chains 3 phases: Genesis (ticket creation) → Planning (planning gate) → Convoy (dev + council + merge).
 * All agents coordinate through the same Agora instance (shared SQLite DB + MCP tools).
 */

import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type { InsightStream } from "../core/insight-stream.js";
import type { AgoraConfig } from "../core/config.js";
import { runOrchestrator, type OrchestratorConfig } from "../orchestrator/loop.js";
import type { ToolRunner } from "../tools/tool-runner.js";
import {
  createSharedContext,
  createOrchestratorCallbacks,
  getArg,
  type SharedOrchestratorContext,
} from "./shared-orchestrator.js";
import { parseTicketsFile } from "../swarm/tickets-parser.js";
import { ensureDefaultWorkflows } from "../swarm/default-workflows.js";

function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function cmdSwarm(
  config: AgoraConfig,
  insight: InsightStream,
  args: string[],
): Promise<void> {
  const goal = getArg(args, "--goal");
  const specPath = getArg(args, "--spec");
  const ticketsFile = getArg(args, "--tickets-file");
  let groupId = getArg(args, "--group");
  const maxAgents = parseInt(getArg(args, "--agents") ?? "5", 10);
  const maxTickets = parseInt(getArg(args, "--max-tickets") ?? "20", 10);
  const testCommand = getArg(args, "--test-command");
  const testTimeoutMs = parseInt(getArg(args, "--test-timeout") ?? "120000", 10);
  const pollIntervalMs = parseInt(getArg(args, "--poll-interval") ?? "10000", 10);
  const planningTimeoutMs = parseInt(getArg(args, "--planning-timeout") ?? "1800000", 10);
  const skipPlanning = args.includes("--skip-planning");
  const spawnCommand = getArg(args, "--spawn-command");
  const llmFallback = args.includes("--llm-fallback");
  const maxRetries = parseInt(getArg(args, "--max-retries") ?? "1", 10);
  const dryRun = args.includes("--dry-run");

  if (!goal && !groupId && !ticketsFile) {
    insight.error("Usage: agora swarm --goal TEXT [--spec PATH] [--tickets-file PATH] | --group WG-xxx");
    insight.error("  --goal TEXT          High-level goal description");
    insight.error("  --tickets-file PATH  Pre-structured tickets (JSON or markdown)");
    insight.error("  --group WG-xxx       Resume from existing work group");
    insight.error("  --agents N           Max concurrent agents (default: 5)");
    insight.error("  --skip-planning      Skip planning phase");
    insight.error("  --dry-run            Show decomposition without creating");
    insight.error("  --test-command CMD   Test command for merge validation");
    process.exit(1);
  }

  const startedAt = Date.now();
  const shared = createSharedContext(config, insight);

  // Register as facilitator
  const regRaw = await shared.runner.callTool("register_agent", {
    name: "swarm-orchestrator",
    desiredRole: "facilitator",
  });
  const regResult = asRecord(regRaw.result ?? regRaw);
  const agentId = String(regResult.agentId ?? "swarm-orch");
  const sessionId = String(regResult.sessionId ?? "session-swarm");
  insight.info("Registered as " + agentId);

  // ─── PHASE 1: GENESIS ───
  if (ticketsFile || (goal && !groupId)) {
    insight.info("=== Phase 1: Genesis ===");
    groupId = await runGenesis(shared, insight, {
      goal, specPath, ticketsFile, maxTickets, dryRun, agentId, sessionId,
    });
    if (dryRun) return;
  }

  if (!groupId) {
    insight.error("No work group. Provide --group or --tickets-file.");
    process.exit(1);
  }

  const startPhase = (ticketsFile || goal)
    ? 2
    : await detectStartPhase(shared.runner, agentId, sessionId, insight);

  // ─── PHASE 2: PLANNING ───
  if (!skipPlanning && startPhase <= 2) {
    insight.info("=== Phase 2: Planning ===");
    const created = await ensureDefaultWorkflows(config.repoPath);
    if (created.length > 0) insight.info("Created workflows: " + created.join(", "));
    await runPlanningPhase(shared, insight, config, agentId, sessionId, planningTimeoutMs, pollIntervalMs);
  }

  // ─── PHASE 3: CONVOY ───
  insight.info("=== Phase 3: Convoy ===");
  const callbacks = createOrchestratorCallbacks(config, insight, shared, { spawnCommand, llmFallback });
  const orchConfig: OrchestratorConfig = {
    groupId, maxConcurrentAgents: maxAgents, testCommand, testTimeoutMs,
    pollIntervalMs, llmFallback, maxRetries, repoPath: config.repoPath,
  };

  const result = await runOrchestrator(orchConfig, callbacks);

  // ─── REPORT ───
  const durationMs = Date.now() - startedAt;
  insight.info("=== Swarm Complete ===");
  insight.info("  Duration: " + Math.round(durationMs / 1000) + "s");
  insight.info("  Waves: " + result.wavesCompleted + "/" + result.totalWaves);
  insight.info("  Merged: " + result.mergedTickets.length + " tickets");
  if (result.skippedTickets.length > 0) insight.warn("  Skipped: " + result.skippedTickets.join(", "));
  if (result.failedTickets.length > 0) insight.error("  Failed: " + result.failedTickets.join(", "));
  insight.info("  Final merged to main: " + result.finalMerged);

  try { await shared.runner.callTool("end_session", { agentId, sessionId }); } catch { /* ok */ }
}

// ─── Phase 1: Genesis ────────────────────────────────────────────────────────

interface GenesisOptions {
  goal?: string; specPath?: string; ticketsFile?: string;
  maxTickets: number; dryRun: boolean; agentId: string; sessionId: string;
}

async function runGenesis(
  shared: SharedOrchestratorContext, insight: InsightStream, opts: GenesisOptions,
): Promise<string | undefined> {
  const { goal, specPath, ticketsFile, maxTickets, dryRun, agentId, sessionId } = opts;

  const tickets = ticketsFile ? parseTicketsFile(ticketsFile) : [];
  if (tickets.length === 0) {
    insight.error("No tickets parsed. Provide --tickets-file with valid content.");
    process.exit(1);
  }

  if (specPath) {
    const specContent = readFileSync(specPath, "utf-8");
    await shared.runner.callTool("store_knowledge", {
      type: "context", scope: "repo", title: goal ?? "Design Spec",
      content: specContent.slice(0, 8000), tags: ["swarm", "spec"], agentId, sessionId,
    }).catch(() => {});
    insight.info("Stored spec as knowledge");
  }

  const proposedTasks = tickets.map((t) => ({
    title: t.title, description: t.description, rationale: t.rationale,
    severity: t.severity, priority: t.priority, tags: t.tags,
    dependsOn: t.dependsOn, affectedPaths: t.affectedPaths,
  }));

  // Validate
  const dryResult = await shared.runner.callTool("decompose_goal", {
    goal: goal ?? "Swarm", proposedTasks, maxTickets, dryRun: true, agentId, sessionId,
  });
  const dryData = asRecord(dryResult.result ?? dryResult);
  for (const w of asStringArray(dryData.warnings)) insight.warn("  " + w);
  insight.info("Validated " + tickets.length + " tickets");

  if (dryRun) return undefined;

  // Persist
  const persistResult = await shared.runner.callTool("decompose_goal", {
    goal: goal ?? "Swarm", proposedTasks, maxTickets, dryRun: false, agentId, sessionId,
  });
  const persistData = asRecord(persistResult.result ?? persistResult);
  const ticketIds = asStringArray(persistData.createdTicketIds);
  insight.info("Created " + ticketIds.length + " tickets");

  const wgResult = await shared.runner.callTool("create_work_group", {
    title: goal ?? "Swarm Work Group",
    description: "Auto-generated by agora swarm",
    tags: ["swarm"], ticketIds, agentId, sessionId,
  });
  const groupId = String(asRecord(wgResult.result ?? wgResult).groupId ?? "");
  insight.info("Work group: " + groupId);

  await shared.runner.callTool("compute_waves", { groupId, agentId, sessionId });
  insight.info("Waves computed");
  return groupId;
}

// ─── Phase 2: Planning ───────────────────────────────────────────────────────

async function runPlanningPhase(
  shared: SharedOrchestratorContext, insight: InsightStream, config: AgoraConfig,
  agentId: string, sessionId: string, timeoutMs: number, pollIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const children: ChildProcess[] = [];

  try {
    const agora = process.argv[1] ?? "agora";

    const planner = spawn("node", [agora, "loop", "plan", "--watch", "--limit", "50",
      "--interval-ms", String(pollIntervalMs)],
      { cwd: config.repoPath, stdio: "ignore", detached: true });
    planner.unref();
    children.push(planner);
    insight.info("Planner spawned (pid=" + planner.pid + ")");

    const council = spawn("node", [agora, "loop", "council", "--watch",
      "--specialization", "architect", "--limit", "50",
      "--interval-ms", String(pollIntervalMs)],
      { cwd: config.repoPath, stdio: "ignore", detached: true });
    council.unref();
    children.push(council);
    insight.info("Council spawned (pid=" + council.pid + ")");

    let lastLog = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      const raw = await shared.runner.callTool("list_tickets", { agentId, sessionId });
      const data = asRecord(raw.result ?? raw);
      const all = Array.isArray(data.tickets) ? data.tickets as Array<Record<string, unknown>> : [];
      const pending = all.filter((t) => t.status === "backlog" || t.status === "technical_analysis").length;
      const approved = all.filter((t) =>
        t.status !== "backlog" && t.status !== "technical_analysis" && t.status !== "wont_fix").length;

      if (pending === 0) {
        insight.info("All " + approved + " tickets approved. Planning complete.");
        break;
      }
      if (Date.now() - lastLog > 30000) {
        insight.info("Planning: " + approved + " approved, " + pending + " pending (" +
          Math.round((deadline - Date.now()) / 1000) + "s left)");
        lastLog = Date.now();
      }
    }
    if (Date.now() >= deadline) insight.warn("Planning timed out. Continuing with approved tickets.");
  } finally {
    for (const c of children) {
      try { if (c.pid) process.kill(c.pid); } catch { /* ok */ }
    }
  }
}

// ─── Auto-detect Phase ───────────────────────────────────────────────────────

async function detectStartPhase(
  runner: ToolRunner, agentId: string, sessionId: string, insight: InsightStream,
): Promise<2 | 3> {
  const raw = await runner.callTool("list_tickets", { agentId, sessionId });
  const data = asRecord(raw.result ?? raw);
  const all = Array.isArray(data.tickets) ? data.tickets as Array<Record<string, unknown>> : [];
  const pending = all.filter((t) => t.status === "backlog" || t.status === "technical_analysis").length;

  if (pending > 0) {
    insight.info(pending + " tickets need planning — Phase 2");
    return 2;
  }
  insight.info("All tickets approved — Phase 3");
  return 3;
}
