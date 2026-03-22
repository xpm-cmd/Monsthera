#!/usr/bin/env node
/**
 * Quick test: run Phase A of the simulation loop.
 * Usage: npx tsx scripts/run-sim-test.mts
 */

import { runSimulation } from "../src/simulation/runner.js";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/db/schema.js";
import { resolve } from "node:path";

const repoPath = process.cwd();
const dbPath = resolve(repoPath, ".monsthera/monsthera.db");
const sqlite = new Database(dbPath);
const db = drizzle(sqlite, { schema });

const repo = db.select().from(schema.repos).limit(1).all();
if (!repo.length) { console.error("No repo found"); process.exit(1); }
const repoId = repo[0]!.id;

console.log("repoId:", repoId, "| repoPath:", repoPath);

const result = await runSimulation({
  db, sqlite, repoId, repoPath,
  phase: "A",
  targetCorpusSize: 30,
  realWorkBatchSize: 5,
  skipRealWork: true,
  outputPath: resolve(repoPath, ".monsthera/simulation-results.jsonl"),
  onProgress: (ev) => console.log(`[sim] Phase ${ev.phase}:`, ev.message),
});

console.log("\n=== Result ===");
console.log("runId:", result.runId);
console.log("phases:", result.phasesRun);
console.log("corpus:", result.corpus?.descriptors.length ?? 0, "tickets");
console.log("rejected:", result.corpus?.rejections.length ?? 0);

if (result.corpus?.descriptors.length) {
  const d = result.corpus.descriptors;
  const bySource = { backlog: 0, auto: 0, manual: 0 };
  for (const t of d) {
    if (t.source === "backlog_atomized") bySource.backlog++;
    else if (t.source === "auto_detected") bySource.auto++;
    else bySource.manual++;
  }
  console.log("sources:", bySource);
  console.log("\nSample tickets:");
  for (const t of d.slice(0, 8)) {
    console.log(` - [${t.suggestedModel}] ${t.title}`);
  }
}

sqlite.close();
