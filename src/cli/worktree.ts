import type { InsightStream } from "../core/insight-stream.js";
import type { AgoraConfig } from "../core/config.js";
import { createAgoraContextLoader } from "../core/context-loader.js";
import * as queries from "../db/queries.js";
import { cleanupOrphanedWorktrees } from "../git/worktree.js";

export async function cmdWorktree(
  config: AgoraConfig,
  insight: InsightStream,
  args: string[],
): Promise<void> {
  const subcommand = args[0];
  if (subcommand !== "cleanup") {
    insight.error("Usage: agora worktree cleanup [--dry-run]");
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");

  const getContext = createAgoraContextLoader(config, insight, { startLifecycleSweep: false });
  const context = await getContext();
  const activeSessions = queries.getActiveSessions(context.db).map((s) => s.id);

  insight.info(`Active sessions: ${activeSessions.length}`);
  const result = await cleanupOrphanedWorktrees(config.repoPath, new Set(activeSessions), { dryRun });

  if (result.removed.length === 0) {
    insight.info("No orphaned worktrees found.");
  } else {
    const verb = dryRun ? "Would remove" : "Removed";
    for (const sid of result.removed) {
      insight.info(`  ${verb}: ${sid}`);
    }
  }
  for (const { sessionId, error } of result.errors) {
    insight.warn(`  Error removing ${sessionId}: ${error}`);
  }
}
