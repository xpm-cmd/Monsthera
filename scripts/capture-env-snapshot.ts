#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Capture a sandbox environment snapshot and print the JSON payload expected by
 * the `record_environment_snapshot` MCP tool. Monsthera never runs shell
 * commands from the server; this helper runs client-side, collects the probes,
 * and emits JSON the agent can pipe into the tool.
 *
 * Usage:
 *   pnpm exec tsx scripts/capture-env-snapshot.ts --agent-id agent-1 [--work-id w-xxx]
 *
 * Output goes to stdout; diagnostics to stderr. Exits 0 even if probes fail —
 * the snapshot just omits the fields that could not be gathered.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

interface CliArgs {
  readonly agentId: string;
  readonly workId?: string;
  readonly cwd: string;
}

interface Snapshot {
  agentId: string;
  workId?: string;
  cwd: string;
  gitRef?: { branch?: string; sha?: string; dirty?: boolean };
  files: string[];
  runtimes: Record<string, string>;
  packageManagers: string[];
  lockfiles: { path: string; sha256: string }[];
  memory?: { totalMb: number; availableMb: number };
  raw?: string;
}

const RUNTIME_PROBES: readonly { name: string; cmd: string; args: readonly string[] }[] = [
  { name: "node", cmd: "node", args: ["--version"] },
  { name: "python3", cmd: "python3", args: ["--version"] },
  { name: "pnpm", cmd: "pnpm", args: ["--version"] },
  { name: "npm", cmd: "npm", args: ["--version"] },
  { name: "yarn", cmd: "yarn", args: ["--version"] },
  { name: "go", cmd: "go", args: ["version"] },
  { name: "rustc", cmd: "rustc", args: ["--version"] },
  { name: "java", cmd: "java", args: ["-version"] },
  { name: "gcc", cmd: "gcc", args: ["--version"] },
];

const PACKAGE_MANAGER_CANDIDATES = ["pnpm", "npm", "yarn", "pip", "pip3", "cargo", "go"] as const;

const LOCKFILE_CANDIDATES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "requirements.lock",
  "uv.lock",
] as const;

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let agentId: string | undefined;
  let workId: string | undefined;
  let cwd: string = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--agent-id" && next) {
      agentId = next;
      i += 1;
    } else if (flag === "--work-id" && next) {
      workId = next;
      i += 1;
    } else if (flag === "--cwd" && next) {
      cwd = next;
      i += 1;
    }
  }
  if (!agentId) {
    console.error("Missing required flag: --agent-id");
    process.exit(2);
  }
  return { agentId, workId, cwd };
}

function tryExec(cmd: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync(cmd, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 5_000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function normalizeVersion(raw: string): string {
  const match = raw.match(/\d[\w.+-]*/);
  return match ? match[0] : raw.slice(0, 64);
}

function collectRuntimes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const probe of RUNTIME_PROBES) {
    const raw = tryExec(probe.cmd, probe.args);
    if (raw) out[probe.name] = normalizeVersion(raw);
  }
  return out;
}

function collectPackageManagers(): string[] {
  return PACKAGE_MANAGER_CANDIDATES.filter((mgr) => tryExec(mgr, ["--version"]) !== null);
}

function collectGitRef(cwd: string): Snapshot["gitRef"] | undefined {
  const branch = tryExec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = tryExec("git", ["-C", cwd, "rev-parse", "HEAD"]);
  const statusRaw = tryExec("git", ["-C", cwd, "status", "--porcelain"]);
  if (branch === null && sha === null && statusRaw === null) return undefined;
  const ref: NonNullable<Snapshot["gitRef"]> = {};
  if (branch) ref.branch = branch;
  if (sha) ref.sha = sha;
  if (statusRaw !== null) ref.dirty = statusRaw.length > 0;
  return ref;
}

function collectFiles(cwd: string): string[] {
  try {
    return fs
      .readdirSync(cwd, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, 200);
  } catch {
    return [];
  }
}

function collectLockfiles(cwd: string): Snapshot["lockfiles"] {
  const lockfiles: Snapshot["lockfiles"] = [];
  for (const candidate of LOCKFILE_CANDIDATES) {
    const full = path.join(cwd, candidate);
    try {
      const data = fs.readFileSync(full);
      const sha256 = createHash("sha256").update(data).digest("hex");
      lockfiles.push({ path: candidate, sha256 });
    } catch {
      // missing lockfile — skip
    }
  }
  return lockfiles;
}

function collectMemory(): Snapshot["memory"] | undefined {
  try {
    // Linux: /proc/meminfo is the most portable source without shelling out.
    const raw = fs.readFileSync("/proc/meminfo", "utf-8");
    const totalMatch = raw.match(/^MemTotal:\s+(\d+)\s+kB/m);
    const availMatch = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!totalMatch || !availMatch) return undefined;
    return {
      totalMb: Math.round(Number(totalMatch[1]) / 1024),
      availableMb: Math.round(Number(availMatch[1]) / 1024),
    };
  } catch {
    return undefined;
  }
}

function main(): void {
  const args = parseArgs();
  const snapshot: Snapshot = {
    agentId: args.agentId,
    ...(args.workId !== undefined && { workId: args.workId }),
    cwd: args.cwd,
    files: collectFiles(args.cwd),
    runtimes: collectRuntimes(),
    packageManagers: collectPackageManagers(),
    lockfiles: collectLockfiles(args.cwd),
  };
  const gitRef = collectGitRef(args.cwd);
  if (gitRef) snapshot.gitRef = gitRef;
  const memory = collectMemory();
  if (memory) snapshot.memory = memory;
  process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
}

main();
