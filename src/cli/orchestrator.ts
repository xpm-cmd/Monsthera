import type { InsightStream } from "../core/insight-stream.js";
import type { AgoraConfig } from "../core/config.js";
import { runOrchestrator, type OrchestratorConfig } from "../orchestrator/loop.js";
import {
  createSharedContext,
  createOrchestratorCallbacks,
  getArg,
} from "./shared-orchestrator.js";

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
  const spawnCommand = getArg(args, "--spawn-command");

  const shared = createSharedContext(config, insight);
  const callbacks = createOrchestratorCallbacks(config, insight, shared, { spawnCommand, llmFallback });

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
