/* eslint-disable no-console */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

// ─── Content-input helper ────────────────────────────────────────────────────

/**
 * Resolve article/work content from a combination of `--content`,
 * `--content-file`, and `--edit`. Exactly one mode (or none) may be used:
 *
 *   - `--content <body>`          : literal body (unchanged legacy path)
 *   - `--content-file <path>`     : read body from disk — avoids shell
 *                                   heredoc escaping bugs with backticks
 *   - `--edit`                    : open `$EDITOR` on a seeded scratch file
 *                                   (optional `seed` provides the initial
 *                                   buffer, e.g. `generateInitialContent`).
 *
 * Returns `undefined` when no mode is set, so callers can treat the field
 * as optional. Throws with a user-facing message when the flags conflict
 * or a file cannot be read — `main()` catches and prints.
 */
export function readContentInput(args: string[], options?: { seed?: string }): string | undefined {
  const content = parseFlag(args, "--content");
  const contentFile = parseFlag(args, "--content-file");
  const edit = args.includes("--edit");

  const set = [content !== undefined, contentFile !== undefined, edit].filter(Boolean).length;
  if (set === 0) return undefined;
  if (set > 1) {
    throw new Error("--content, --content-file, and --edit are mutually exclusive");
  }
  if (content !== undefined) return content;
  if (contentFile !== undefined) {
    try {
      return fs.readFileSync(path.resolve(contentFile), "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read --content-file "${contentFile}": ${msg}`);
    }
  }
  return openEditorForContent(options?.seed ?? "");
}

function openEditorForContent(seed: string): string {
  const editor = process.env.EDITOR ?? process.env.VISUAL;
  if (!editor) {
    throw new Error("--edit requires $EDITOR or $VISUAL to be set");
  }
  const tmp = path.join(os.tmpdir(), `monsthera-edit-${randomUUID()}.md`);
  fs.writeFileSync(tmp, seed, "utf-8");
  try {
    const parts = editor.split(/\s+/).filter(Boolean);
    const cmd = parts[0];
    if (!cmd) {
      throw new Error("--edit: $EDITOR is empty after parsing");
    }
    const rest = parts.slice(1);
    const res = spawnSync(cmd, [...rest, tmp], { stdio: "inherit" });
    if (res.status !== 0) {
      throw new Error(`--edit: editor "${editor}" exited with status ${res.status ?? "unknown"}`);
    }
    return fs.readFileSync(tmp, "utf-8");
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
  }
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
