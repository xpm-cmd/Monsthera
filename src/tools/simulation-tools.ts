/**
 * MCP tool registration for `run_simulation`.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgoraContext } from "../core/context.js";
import { runSimulation, type RunnerConfig, type ProgressEvent } from "../simulation/runner.js";

type GetContext = () => Promise<AgoraContext>;

export function registerSimulationTools(server: McpServer, getContext: GetContext): void {
  server.tool(
    "run_simulation",
    "Run the Agora self-improvement simulation loop. Generates atomic tickets from the codebase, measures infrastructure quality in a sandbox, optionally executes real work, and persists KPI results as JSONL.",
    {
      targetCorpusSize: z.number().int().min(1).max(1000).default(200)
        .describe("Max tickets to generate (default 200)"),
      realWorkBatchSize: z.number().int().min(1).max(100).default(50)
        .describe("Max tickets to process in real work phase (default 50)"),
      skipRealWork: z.boolean().default(true)
        .describe("Skip Phase C real work execution (default true)"),
      phase: z.enum(["all", "A", "B", "C", "D"]).default("all")
        .describe("Which phase to run: all, A (generate), B (sandbox), C (real work), D (persist)"),
      outputPath: z.string().default(".agora/simulation-results.jsonl")
        .describe("JSONL output path relative to repo root"),
    },
    async ({ targetCorpusSize, realWorkBatchSize, skipRealWork, phase, outputPath }) => {
      const c = await getContext();
      const { resolve } = await import("node:path");

      const progressLog: string[] = [];
      const onProgress = (event: ProgressEvent) => {
        progressLog.push(`[sim] Phase ${event.phase}: ${event.message}`);
      };

      const config: RunnerConfig = {
        db: c.db,
        sqlite: c.sqlite,
        repoId: c.repoId,
        repoPath: c.repoPath,
        phase: phase as RunnerConfig["phase"],
        targetCorpusSize,
        realWorkBatchSize,
        skipRealWork,
        outputPath: resolve(c.repoPath, outputPath),
        onProgress,
      };

      const result = await runSimulation(config);

      const output = {
        runId: result.runId,
        phasesRun: result.phasesRun,
        corpusSize: result.corpus?.descriptors.length ?? 0,
        rejected: result.corpus?.rejections.length ?? 0,
        compositeScore: result.result?.compositeScore ?? null,
        deltas: result.result?.deltas ?? null,
        summary: result.summary,
        progressLog,
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(output, null, 2),
        }],
      };
    },
  );
}
