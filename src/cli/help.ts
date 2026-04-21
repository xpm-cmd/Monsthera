// Shared per-subcommand --help plumbing. Each subcommand handler
// declares a HelpEntry next to its flag parsing, and the caller
// short-circuits out of the handler before any requireFlag() runs.
//
// Output mirrors the top-level `monsthera --help` style: USAGE block,
// optional positional/flag tables, optional examples. Help goes to
// stdout because `--help` is a successful request, not an error.

export interface HelpFlag {
  readonly name: string; // e.g. "--title <t>", "--tags t1,t2"
  readonly required?: boolean;
  readonly description: string;
  readonly default?: string;
}

export interface HelpPositional {
  readonly name: string; // e.g. "<id>"
  readonly description: string;
}

export interface HelpEntry {
  readonly command: string; // e.g. "monsthera knowledge create"
  readonly summary: string; // one-line description
  readonly usage: string; // verbatim USAGE line (after the command)
  readonly positional?: readonly HelpPositional[];
  readonly flags?: readonly HelpFlag[];
  readonly examples?: readonly string[];
  readonly notes?: readonly string[];
}

/**
 * Returns true when `--help` or `-h` appears anywhere in `args`.
 * Callers must check this BEFORE invoking requireFlag / parsePositional
 * validation so users can discover a subcommand's interface without
 * having to satisfy every required flag first.
 */
export function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/**
 * Format a HelpEntry into the canonical monsthera help block and write
 * it to stdout. Callers should `return` after this — help is a terminal
 * action for the subcommand.
 */
export function printSubcommandHelp(entry: HelpEntry): void {
  const lines: string[] = [];
  lines.push(`${entry.command} — ${entry.summary}`);
  lines.push("");
  lines.push("USAGE");
  lines.push(`  ${entry.command} ${entry.usage}`.trimEnd());
  lines.push("");

  if (entry.positional && entry.positional.length > 0) {
    lines.push("ARGUMENTS");
    for (const pos of entry.positional) {
      lines.push(`  ${pad(pos.name, 20)} ${pos.description}`);
    }
    lines.push("");
  }

  if (entry.flags && entry.flags.length > 0) {
    lines.push("FLAGS");
    for (const flag of entry.flags) {
      const required = flag.required ? " (required)" : "";
      const defaultSuffix =
        flag.default !== undefined ? ` [default: ${flag.default}]` : "";
      lines.push(`  ${pad(flag.name, 32)} ${flag.description}${required}${defaultSuffix}`);
    }
    lines.push("");
  }

  if (entry.notes && entry.notes.length > 0) {
    lines.push("NOTES");
    for (const note of entry.notes) {
      lines.push(`  ${note}`);
    }
    lines.push("");
  }

  if (entry.examples && entry.examples.length > 0) {
    lines.push("EXAMPLES");
    for (const example of entry.examples) {
      lines.push(`  ${example}`);
    }
    lines.push("");
  }

  process.stdout.write(lines.join("\n"));
}

/**
 * Group-level help (e.g. `monsthera knowledge --help`) — a short
 * command → summary table plus a pointer to per-subcommand help.
 */
export interface HelpGroup {
  readonly command: string; // e.g. "monsthera knowledge"
  readonly summary: string;
  readonly subcommands: readonly { readonly name: string; readonly summary: string }[];
}

export function printGroupHelp(group: HelpGroup): void {
  const lines: string[] = [];
  lines.push(`${group.command} — ${group.summary}`);
  lines.push("");
  lines.push("SUBCOMMANDS");
  for (const sub of group.subcommands) {
    lines.push(`  ${pad(sub.name, 12)} ${sub.summary}`);
  }
  lines.push("");
  lines.push(`Run "${group.command} <subcommand> --help" for per-subcommand flags.`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value + " ";
  return value + " ".repeat(width - value.length);
}
