/* eslint-disable no-console */
import { loadConfig } from "../core/config.js";
import { createContainer } from "../core/container.js";
import type { MonstheraContainer } from "../core/container.js";

// ─── Arg-parsing helpers ─────────────────────────────────────────────────────

export function parseFlag(args: string[], flag: string, short?: string): string | undefined {
  const idx = args.findIndex((a) => a === flag || (short && a === short));
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

export function requireFlag(args: string[], flag: string, short?: string): string {
  const value = parseFlag(args, flag, short);
  if (!value) {
    throw new Error(`Missing required flag: ${flag}`);
  }
  return value;
}

export function parsePositional(args: string[], index: number): string | undefined {
  // Skip flag pairs (--key value) and return positional args
  let pos = 0;
  for (let i = 0; i < args.length; i++) {
    const arg: string | undefined = args[i];
    if (arg === undefined || arg.startsWith("-")) {
      if (arg !== undefined) i++; // skip value of the flag
      continue;
    }
    if (pos === index) return arg;
    pos++;
  }
  return undefined;
}

export function parseRepoPath(args: string[]): string | undefined {
  return parseFlag(args, "--repo", "-r");
}

export function parseCommaSeparated(args: string[], flag: string, short?: string): string[] | undefined {
  const value = parseFlag(args, flag, short);
  if (!value) return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── Container helper ────────────────────────────────────────────────────────

export async function withContainer<T>(args: string[], fn: (container: MonstheraContainer) => Promise<T>): Promise<T> {
  const repoPath = parseRepoPath(args) ?? process.cwd();
  const configResult = loadConfig(repoPath);
  if (!configResult.ok) {
    console.error(`Config error: ${configResult.error.message}`);
    console.error("Fix .monsthera/config.json or use 'monsthera serve' which falls back to defaults.");
    process.exit(1);
  }
  const container = await createContainer(configResult.value);
  try {
    return await fn(container);
  } finally {
    await container.dispose();
  }
}
