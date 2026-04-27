/* eslint-disable no-console */
import { parseRepoPath } from "./arg-helpers.js";
import { formatError } from "./formatters.js";
import { runSelfDoctor, type SelfDoctorReport } from "../ops/doctor.js";
import {
  executeSelfUpdate,
  inspectSelf,
  planSelfUpdate,
  prepareSelfUpdate,
  restartDolt,
  type SelfUpdateExecution,
  type SelfUpdateRollback,
} from "../ops/self-service.js";

function selfHelp(): string {
  return [
    "monsthera self <subcommand>",
    "",
    "SUBCOMMANDS",
    "  status             Inspect install, workspace, and managed process state",
    "  update --dry-run   Print the safe update plan and blockers",
    "  update --prepare   Create a workspace backup, migrate manifest, and print the update plan",
    "  update --execute   Run the safe update plan when there are no blockers",
    "                     Automatic rollback restores the workspace if a step fails after backup",
    "  restart [dolt]     Restart managed local Dolt daemon",
    "  doctor [--fix]     Diagnose blockers, stale metadata, and legacy pid files",
    "                     With --fix, adopt legacy pids and clean up stale metadata where safe",
    "",
    "OPTIONS",
    "  --repo, -r <path>  Workspace repository path (defaults to cwd)",
    "  --json             Emit machine-readable JSON",
    "  --force            Allow restart to stop an untrusted legacy process",
    "  --fix              Apply doctor fixes (only with subcommand 'doctor')",
    "",
  ].join("\n");
}

export async function handleSelf(args: string[]): Promise<void> {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(selfHelp());
    return;
  }

  const repoPath = parseRepoPath(args) ?? process.cwd();
  const asJson = args.includes("--json");

  switch (command) {
    case "status": {
      const result = await inspectSelf({ repoPath });
      if (!result.ok) {
        console.error(formatError(result.error));
        process.exit(1);
      }
      if (asJson) {
        process.stdout.write(JSON.stringify(result.value, null, 2) + "\n");
        return;
      }
      const s = result.value;
      process.stdout.write(
        [
          "Self",
          `Version: ${s.version}`,
          `Install: ${s.install.path}`,
          `Git: ${s.install.isGitCheckout ? `${s.install.branch ?? "(detached)"} @ ${shortSha(s.install.head)}` : "not a checkout"}`,
          `Upstream: ${shortSha(s.install.upstreamHead) ?? "unknown"}`,
          `Dirty: ${s.install.dirty ? "yes" : "no"}`,
          `Workspace: ${s.workspace.repoPath}`,
          `Workspace schema: ${s.workspace.schema.workspace ?? "none"} / supported ${s.workspace.schema.current}`,
          `Dolt: ${formatProcess(s.processes.dolt)}`,
          "",
        ].join("\n"),
      );
      return;
    }

    case "update": {
      if (args.includes("--execute")) {
        const result = await executeSelfUpdate({ repoPath });
        if (!result.ok) {
          if (asJson) {
            process.stdout.write(JSON.stringify({ ok: false, error: serializeError(result.error) }, null, 2) + "\n");
          } else {
            console.error(formatError(result.error));
            const rollback = result.error.details?.["rollback"] as SelfUpdateRollback | undefined;
            if (rollback) printRollback(rollback);
          }
          process.exit(1);
        }
        if (asJson) {
          process.stdout.write(JSON.stringify(result.value, null, 2) + "\n");
          return;
        }
        printExecution(result.value);
        return;
      }

      if (args.includes("--prepare")) {
        const result = await prepareSelfUpdate({ repoPath });
        if (!result.ok) {
          console.error(formatError(result.error));
          process.exit(1);
        }
        if (asJson) {
          process.stdout.write(JSON.stringify(result.value, null, 2) + "\n");
          return;
        }
        process.stdout.write(`Backup created: ${result.value.backup.path}\n`);
        printPlan(result.value.plan);
        return;
      }

      if (!args.includes("--dry-run")) {
        console.error("self update requires --dry-run, --prepare, or --execute");
        process.exit(1);
      }
      const result = await planSelfUpdate({ repoPath });
      if (!result.ok) {
        console.error(formatError(result.error));
        process.exit(1);
      }
      if (asJson) {
        process.stdout.write(JSON.stringify(result.value, null, 2) + "\n");
        return;
      }
      printPlan(result.value);
      return;
    }

    case "restart": {
      const service = args.find((arg, index) => index > 0 && !arg.startsWith("-")) ?? "dolt";
      if (service !== "dolt") {
        console.error(`Unknown self restart service: ${service}`);
        process.exit(1);
      }
      const result = await restartDolt({ force: args.includes("--force") });
      if (!result.ok) {
        console.error(formatError(result.error));
        process.exit(1);
      }
      if (asJson) {
        process.stdout.write(JSON.stringify(result.value, null, 2) + "\n");
        return;
      }
      process.stdout.write(
        [
          "Restarted Dolt",
          `Stopped previous: ${result.value.stopped.pid ? `pid ${result.value.stopped.pid}` : "none"}`,
          result.value.output,
          "",
        ].filter(Boolean).join("\n"),
      );
      return;
    }

    case "doctor": {
      const fix = args.includes("--fix");
      const report = await runSelfDoctor({ repoPath, fix });
      if (!report.ok) {
        console.error(formatError(report.error));
        process.exit(1);
      }
      if (asJson) {
        process.stdout.write(JSON.stringify(report.value, null, 2) + "\n");
      } else {
        printDoctor(report.value);
      }
      const blockers = report.value.findings.filter((f) => f.severity === "blocker").length;
      if (blockers > 0) process.exit(2);
      return;
    }

    default:
      console.error(`Unknown self subcommand: ${command}`);
      console.error('Run "monsthera self --help" for usage.');
      process.exit(1);
  }
}

function printPlan(plan: { readonly steps: readonly string[]; readonly blockers: readonly string[] }): void {
  process.stdout.write("Self update plan\n");
  if (plan.blockers.length > 0) {
    process.stdout.write("Blockers:\n");
    for (const blocker of plan.blockers) process.stdout.write(`  - ${blocker}\n`);
  } else {
    process.stdout.write("Blockers: none\n");
  }
  process.stdout.write("Steps:\n");
  for (const step of plan.steps) process.stdout.write(`  - ${step}\n`);
}

function printExecution(result: SelfUpdateExecution): void {
  process.stdout.write("Self update complete\n");
  process.stdout.write(`Backup: ${result.backup.path}\n`);
  process.stdout.write("Steps:\n");
  for (const step of result.steps) {
    const suffix = step.output ? ` - ${firstLine(step.output)}` : "";
    process.stdout.write(`  - ${step.status}: ${step.name}${suffix}\n`);
  }
}

function printRollback(rollback: SelfUpdateRollback): void {
  process.stderr.write("\nRollback report\n");
  process.stderr.write(`  Backup: ${rollback.backupPath}\n`);
  process.stderr.write(`  Workspace restored: ${rollback.performed ? "yes" : "no"}\n`);
  if (rollback.restored.length > 0) {
    process.stderr.write(`  Restored: ${rollback.restored.join(", ")}\n`);
  }
  if (rollback.skipped.length > 0) {
    process.stderr.write(`  Skipped (not in backup): ${rollback.skipped.join(", ")}\n`);
  }
  process.stderr.write(`  Dolt restarted: ${rollback.doltRestarted ? "yes" : "no"}\n`);
  if (rollback.errors.length > 0) {
    process.stderr.write("  Rollback errors:\n");
    for (const e of rollback.errors) process.stderr.write(`    - ${e}\n`);
  }
}

function printDoctor(report: SelfDoctorReport): void {
  process.stdout.write("Self doctor\n");
  process.stdout.write(`Install: ${report.installPath}\n`);
  process.stdout.write(`Workspace: ${report.repoPath}\n`);
  process.stdout.write(`Healthy: ${report.healthy ? "yes" : "no"}\n`);
  if (report.findings.length === 0) {
    process.stdout.write("Findings: none\n");
    return;
  }
  process.stdout.write("Findings:\n");
  for (const f of report.findings) {
    process.stdout.write(`  - [${f.severity}] ${f.id}: ${f.message}\n`);
    if (f.fixable) {
      const fixedLabel = f.fixed === true ? "fixed" : f.fixError ? `fix failed: ${f.fixError}` : "fixable";
      process.stdout.write(`      ${fixedLabel}\n`);
    }
    if (f.hint) process.stdout.write(`      hint: ${f.hint}\n`);
  }
  if (report.fixesAttempted > 0) {
    process.stdout.write(`Fixes: ${report.fixesApplied}/${report.fixesAttempted} applied\n`);
  }
}

function shortSha(value: string | undefined): string | undefined {
  return value ? value.slice(0, 7) : undefined;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
}

function formatProcess(process: { readonly pid: number | null; readonly running: boolean; readonly trusted: boolean; readonly source: string; readonly reason?: string }): string {
  if (!process.pid) return "not managed";
  const suffix = process.reason ? ` (${process.reason})` : "";
  return `${process.running ? "running" : "stale"} pid ${process.pid}, ${process.trusted ? "trusted" : "untrusted"}, ${process.source}${suffix}`;
}

function serializeError(error: { code: string; message: string; details?: Record<string, unknown> }): Record<string, unknown> {
  return { code: error.code, message: error.message, details: error.details };
}
