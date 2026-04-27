import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StorageError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";

const execFileAsync = promisify(execFile);

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBufferBytes?: number;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (spec: CommandSpec) => Promise<Result<CommandResult, StorageError>>;

const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;

interface ExecError {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly signal?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

export const realCommandRunner: CommandRunner = async (spec) => {
  try {
    const { stdout, stderr } = await execFileAsync(spec.command, [...spec.args], {
      cwd: spec.cwd,
      timeout: spec.timeoutMs,
      env: spec.env,
      maxBuffer: spec.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
      encoding: "utf-8",
    });
    return ok({ stdout, stderr });
  } catch (error) {
    const e = (error ?? {}) as ExecError;
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    const stdout = typeof e.stdout === "string" ? e.stdout.trim() : "";
    const code = typeof e.code === "number" || typeof e.code === "string" ? e.code : undefined;
    const signal = typeof e.signal === "string" ? e.signal : undefined;
    const summary = stderr || stdout || (typeof e.message === "string" ? e.message : String(error));
    return err(
      new StorageError(`${spec.command} ${spec.args.join(" ")} failed: ${truncate(summary, 400)}`, {
        cwd: spec.cwd,
        exitCode: code,
        signal,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      }),
    );
  }
};

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function combineOutput(result: CommandResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}
