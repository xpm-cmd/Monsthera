/**
 * Terminal Insight Stream — writes [MONSTHERA] messages to stderr
 * (stdout is reserved for MCP stdio transport).
 */

export type Verbosity = "quiet" | "normal" | "verbose";

export class InsightStream {
  constructor(private verbosity: Verbosity) {}

  /** Always shown (unless quiet) */
  info(msg: string): void {
    if (this.verbosity !== "quiet") {
      console.error(`[MONSTHERA] ${msg}`);
    }
  }

  /** Only shown at verbose */
  detail(msg: string): void {
    if (this.verbosity === "verbose") {
      console.error(`[MONSTHERA] ${msg}`);
    }
  }

  /** Only shown at verbose */
  debug(msg: string): void {
    if (this.verbosity === "verbose") {
      console.error(`[MONSTHERA] [debug] ${msg}`);
    }
  }

  /** Always shown */
  warn(msg: string): void {
    console.error(`[MONSTHERA] ⚠ ${msg}`);
  }

  /** Always shown */
  error(msg: string): void {
    console.error(`[MONSTHERA] ✗ ${msg}`);
  }
}
