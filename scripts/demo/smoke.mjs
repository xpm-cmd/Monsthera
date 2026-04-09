#!/usr/bin/env node

import { access, readdir, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.PORT ?? 4124);
const doltHost = process.env.MONSTHERA_DOLT_HOST ?? "127.0.0.1";
const doltPort = process.env.MONSTHERA_DOLT_PORT ?? "3306";
const doltDatabase = process.env.MONSTHERA_DOLT_DATABASE ?? "monsthera";
const sqlitePath = process.env.MONSTHERA_V2_SOURCE ?? path.join(rootDir, ".monsthera", "monsthera.db");
const workDir = path.join(rootDir, "knowledge", "work-articles");
const knowledgeDir = path.join(rootDir, "knowledge", "notes");
const dashboardEnv = {
  ...process.env,
  MONSTHERA_DOLT_ENABLED: "true",
  MONSTHERA_DOLT_HOST: doltHost,
  MONSTHERA_DOLT_PORT: doltPort,
  MONSTHERA_DOLT_DATABASE: doltDatabase,
};
const baseUrl = `http://127.0.0.1:${port}`;

function step(message) {
  process.stdout.write(`\n==> ${message}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function countMarkdownFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.status === 200 || res.status === 503) {
        return;
      }
    } catch {
      // Keep polling until the dashboard is ready.
    }
    await delay(500);
  }
  throw new Error(`Dashboard did not become ready at ${baseUrl} within 60s`);
}

async function apiRequest(apiPath, options = {}, expectedStatus = 200) {
  const init = { ...options };
  if (init.body !== undefined) {
    init.headers = { "Content-Type": "application/json", ...(init.headers ?? {}) };
    init.body = JSON.stringify(init.body);
  }

  const res = await fetch(`${baseUrl}${apiPath}`, init);
  const contentType = res.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text().catch(() => "");

  if (res.status !== expectedStatus) {
    throw new Error(`${init.method ?? "GET"} ${apiPath} expected ${expectedStatus}, got ${res.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }

  return payload;
}

async function stopChild(child) {
  if (!child?.pid) return;

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }

  await delay(2_000);

  try {
    process.kill(-child.pid, 0);
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Process group already exited.
  }
}

let dashboard;
let knowledgeId = null;
let blockerId = null;
let workId = null;
let smokeToken = null;
let baselineKnowledgeCount = null;
let baselineWorkCount = null;

try {
  const doltBinary = path.join(rootDir, ".monsthera", "bin", "dolt");

  if (!(await pathExists(doltBinary))) {
    step("Installing local Dolt");
    await runCommand("pnpm", ["dolt:install"]);
  }

  step("Starting Dolt daemon");
  await runCommand("pnpm", ["dolt:start:daemon"]);

  const workCount = await countMarkdownFiles(workDir);
  const knowledgeCount = await countMarkdownFiles(knowledgeDir);
  if (workCount === 0 && knowledgeCount === 0 && await pathExists(sqlitePath)) {
    step("Migrating Markdown corpus from the local v2 SQLite database");
    await runCommand("pnpm", ["exec", "tsx", "src/bin.ts", "migrate", "--mode", "execute", "--scope", "all", "--source", sqlitePath]);
  }

  step("Reindexing search");
  await runCommand("pnpm", ["exec", "tsx", "src/bin.ts", "reindex"], { env: dashboardEnv });

  step(`Starting dashboard on ${baseUrl}`);
  dashboard = spawn("pnpm", ["exec", "tsx", "src/bin.ts", "dashboard", "--port", String(port)], {
    cwd: rootDir,
    env: dashboardEnv,
    stdio: "inherit",
    detached: true,
  });
  dashboard.unref();
  dashboard.once("error", (error) => {
    process.stderr.write(`dashboard process error: ${String(error)}\n`);
  });
  await waitForServer();

  step("Validating runtime endpoints");
  const status = await apiRequest("/api/status");
  const runtime = await apiRequest("/api/system/runtime");
  assert(status.version, "status endpoint did not return a version");
  assert(runtime.storage?.doltEnabled === true, "runtime endpoint did not report Dolt enabled");
  assert(Array.isArray(runtime.integrations), "runtime endpoint did not return integrations");
  baselineKnowledgeCount = status.stats?.knowledgeArticleCount ?? null;
  baselineWorkCount = status.stats?.workArticleCount ?? null;

  smokeToken = `demo-smoke-${Date.now()}`;

  step("Creating and indexing a knowledge article");
  const knowledge = await apiRequest("/api/knowledge", {
    method: "POST",
    body: {
      title: `${smokeToken} knowledge`,
      category: "demo",
      content: `# ${smokeToken}\n\nThis article validates dashboard CRUD and search sync.`,
      tags: ["demo", "smoke"],
      codeRefs: ["src/dashboard/index.ts"],
    },
  }, 201);
  knowledgeId = knowledge.id;
  const knowledgeSearch = await apiRequest(`/api/search?q=${encodeURIComponent(smokeToken)}&limit=20`);
  assert(knowledgeSearch.some((result) => result.id === knowledgeId), "knowledge article was not searchable after creation");

  step("Creating work articles and linking a blocker");
  const blocker = await apiRequest("/api/work", {
    method: "POST",
    body: {
      title: `${smokeToken} blocker`,
      template: "bugfix",
      priority: "medium",
      author: "agent-smoke",
      content: "## Objective\nUnblock the dependent work.\n\n## Steps to Reproduce\n1. Reproduce blocker\n\n## Acceptance Criteria\n- [ ] blocker resolved",
    },
  }, 201);
  blockerId = blocker.id;

  const work = await apiRequest("/api/work", {
    method: "POST",
    body: {
      title: `${smokeToken} work`,
      template: "feature",
      priority: "high",
      author: "agent-smoke",
      content: [
        "## Objective",
        "Ship the smoke-test work item.",
        "",
        "## Context",
        "Exercise the dashboard workflow.",
        "",
        "## Acceptance Criteria",
        "- [ ] lifecycle completed",
        "",
        "## Scope",
        "Keep this work item isolated to the smoke test.",
        "",
        "## Implementation",
        "Validated through the dashboard API.",
      ].join("\n"),
    },
  }, 201);
  workId = work.id;

  await apiRequest(`/api/work/${encodeURIComponent(workId)}`, {
    method: "PATCH",
    body: {
      assignee: "agent-smoke-owner",
      references: [knowledgeId],
      codeRefs: ["src/work/service.ts", "src/dashboard/index.ts"],
    },
  });

  const workSearch = await apiRequest(`/api/search?q=${encodeURIComponent(`${smokeToken} work`)}&limit=20`);
  assert(workSearch.some((result) => result.id === workId), "work article was not searchable after creation");

  const dependencyAdded = await apiRequest(`/api/work/${encodeURIComponent(workId)}/dependencies`, {
    method: "POST",
    body: { blockedById: blockerId },
  });
  assert(dependencyAdded.blockedBy.includes(blockerId), "work dependency was not added");

  const runtimeAfterDependency = await apiRequest("/api/system/runtime");
  assert(
    runtimeAfterDependency.recentEvents.some((event) => event.workId === workId && event.eventType === "dependency_blocked"),
    "dependency event was not recorded",
  );

  const dependencyRemoved = await apiRequest(`/api/work/${encodeURIComponent(workId)}/dependencies?blockedById=${encodeURIComponent(blockerId)}`, {
    method: "DELETE",
  });
  assert(!dependencyRemoved.blockedBy.includes(blockerId), "work dependency was not removed");

  step("Walking the work article through the lifecycle");
  const enrichment = await apiRequest(`/api/work/${encodeURIComponent(workId)}/advance`, {
    method: "POST",
    body: { phase: "enrichment" },
  });
  assert(enrichment.phase === "enrichment", "work did not advance to enrichment");

  const enriched = await apiRequest(`/api/work/${encodeURIComponent(workId)}/enrichment`, {
    method: "POST",
    body: { role: "architecture", status: "contributed" },
  });
  assert(enriched.enrichmentRoles.some((role) => role.role === "architecture" && role.status === "contributed"), "enrichment contribution was not recorded");

  const implementation = await apiRequest(`/api/work/${encodeURIComponent(workId)}/advance`, {
    method: "POST",
    body: { phase: "implementation" },
  });
  assert(implementation.phase === "implementation", "work did not advance to implementation");

  await apiRequest(`/api/work/${encodeURIComponent(workId)}/reviewers`, {
    method: "POST",
    body: { reviewerAgentId: "reviewer-smoke" },
  });

  const review = await apiRequest(`/api/work/${encodeURIComponent(workId)}/advance`, {
    method: "POST",
    body: { phase: "review" },
  });
  assert(review.phase === "review", "work did not advance to review");

  const reviewed = await apiRequest(`/api/work/${encodeURIComponent(workId)}/review`, {
    method: "POST",
    body: { reviewerAgentId: "reviewer-smoke", status: "approved" },
  });
  assert(reviewed.reviewers.some((reviewer) => reviewer.agentId === "reviewer-smoke" && reviewer.status === "approved"), "review approval was not recorded");

  const done = await apiRequest(`/api/work/${encodeURIComponent(workId)}/advance`, {
    method: "POST",
    body: { phase: "done" },
  });
  assert(done.phase === "done", "work did not advance to done");

  const runtimeAfterDone = await apiRequest("/api/system/runtime");
  assert(
    runtimeAfterDone.recentEvents.some((event) => event.workId === workId && event.eventType === "phase_advanced"),
    "phase advancement events were not visible in runtime audit data",
  );

  step("Smoke flow completed successfully");
} finally {
  try {
    step("Cleaning up smoke data");

    if (knowledgeId) {
      await apiRequest(`/api/knowledge/${encodeURIComponent(knowledgeId)}`, { method: "DELETE" }).catch(() => {});
    }
    if (blockerId) {
      await apiRequest(`/api/work/${encodeURIComponent(blockerId)}`, { method: "DELETE" }).catch(() => {});
    }
    if (workId) {
      await rm(path.join(workDir, `${workId}.md`), { force: true }).catch(() => {});
    }

    const cleanupReindex = await apiRequest("/api/search/reindex", { method: "POST", body: {} }).catch(async () => {
      await runCommand("pnpm", ["exec", "tsx", "src/bin.ts", "reindex"], { env: dashboardEnv }).catch(() => {});
      return null;
    });

    if (knowledgeId) {
      await apiRequest(`/api/knowledge/${encodeURIComponent(knowledgeId)}`, {}, 404);
    }
    if (blockerId) {
      await apiRequest(`/api/work/${encodeURIComponent(blockerId)}`, {}, 404);
    }
    if (workId) {
      await apiRequest(`/api/work/${encodeURIComponent(workId)}`, {}, 404);
    }

    if (cleanupReindex && baselineKnowledgeCount !== null && baselineWorkCount !== null) {
      assert(cleanupReindex.knowledgeCount === baselineKnowledgeCount, "knowledge count did not return to the baseline after cleanup");
      assert(cleanupReindex.workCount === baselineWorkCount, "work count did not return to the baseline after cleanup");
    }
  } finally {
    await stopChild(dashboard);
  }
}
