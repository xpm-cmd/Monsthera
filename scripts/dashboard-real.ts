/**
 * Dashboard preview using the REAL Monsthera database.
 * Connects to .monsthera/monsthera.db and shows live data on :3141.
 */
import { basename } from "node:path";
import { initDatabase } from "../src/db/init.js";
import * as queries from "../src/db/queries.js";
import { CoordinationBus } from "../src/coordination/bus.js";
import { startDashboard } from "../src/dashboard/server.js";
import { InsightStream } from "../src/core/insight-stream.js";

const repoPath = process.argv[2] || process.cwd();
const repoName = basename(repoPath);
const insight = new InsightStream("normal");

const { db } = initDatabase({ repoPath, monstheraDir: ".monsthera", dbName: "monsthera.db" });
const { id: repoId } = queries.upsertRepo(db, repoPath, repoName);
const bus = new CoordinationBus("hub-spoke");

startDashboard({ db, repoId, repoPath, bus }, 3141, insight);
console.log(`Dashboard (real DB) running on http://localhost:3141 for ${repoPath}`);
