/**
 * Golden-set mining helper (H2 régimen tooling).
 *
 * Runs candidate queries through the EXACT provider call the eval harness
 * uses (`searchService.buildContextPack` with the case's mode/type, limit 10)
 * and prints the ranked ids+titles, so expected/forbidden picks for new
 * golden cases are grounded in the live engine instead of guesses.
 *
 * Usage:
 *   pnpm exec tsx scripts/mine-golden-cases.mts <candidates.json>
 *
 * where <candidates.json> is an array of { query, mode?, type? } objects
 * (same shape as golden cases, minus the verdict fields).
 */
import * as fs from "node:fs";
import { loadConfig } from "../src/core/config.js";
import { createContainer } from "../src/core/container.js";

const candidatesPath = process.argv[2];
if (!candidatesPath) {
  console.error("usage: tsx scripts/mine-golden-cases.mts <candidates.json>");
  process.exit(1);
}

const CANDIDATES = JSON.parse(fs.readFileSync(candidatesPath, "utf-8")) as {
  query: string;
  mode?: string;
  type?: string;
}[];

const config = loadConfig(process.cwd());
if (!config.ok) {
  console.error("config failed", config.error);
  process.exit(1);
}
const container = await createContainer(config.value);
try {
  for (const c of CANDIDATES) {
    const res = await container.searchService.buildContextPack({
      query: c.query,
      mode: c.mode ?? "general",
      type: c.type ?? "all",
      limit: 10,
    });
    console.log(`\n### [${c.type ?? "all"}/${c.mode ?? "general"}] "${c.query}"`);
    if (!res.ok) {
      console.log("  ERROR:", res.error.message);
      continue;
    }
    res.value.items.forEach((item: { id: string; title: string; score: number }, i: number) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${item.id}  ${item.title.slice(0, 90)}  (${item.score.toFixed(2)})`);
    });
  }
} finally {
  await container.shutdown?.();
}
process.exit(0);
