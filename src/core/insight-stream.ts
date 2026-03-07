/**
 * Terminal Insight Stream — writes [AGORA] messages to stderr
 * (stdout is reserved for MCP stdio transport).
 */

export type Verbosity = "quiet" | "normal" | "verbose";

export class InsightStream {
  constructor(private verbosity: Verbosity) {}

  /** Always shown (unless quiet) */
  info(msg: string): void {
    if (this.verbosity !== "quiet") {
      console.error(`[AGORA] ${msg}`);
    }
  }

  /** Only shown at normal or verbose */
  detail(msg: string): void {
    if (this.verbosity !== "quiet") {
      console.error(`[AGORA] ${msg}`);
    }
  }

  /** Only shown at verbose */
  debug(msg: string): void {
    if (this.verbosity === "verbose") {
      console.error(`[AGORA] [debug] ${msg}`);
    }
  }

  /** Always shown */
  warn(msg: string): void {
    console.error(`[AGORA] ⚠ ${msg}`);
  }

  /** Always shown */
  error(msg: string): void {
    console.error(`[AGORA] ✗ ${msg}`);
  }
}
