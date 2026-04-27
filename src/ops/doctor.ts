import * as path from "node:path";
import type { StorageError, ValidationError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { ok } from "../core/result.js";
import { migrateWorkspace } from "../workspace/service.js";
import {
  adoptLegacyPidFile,
  cleanupStaleMetadata,
  type ManagedProcessKind,
} from "./process-registry.js";
import { realCommandRunner } from "./command-runner.js";
import { inspectSelf, type SelfServiceOptions, type SelfStatus } from "./self-service.js";

export type DoctorSeverity = "blocker" | "warning" | "info";

export interface DoctorFinding {
  readonly id: string;
  readonly severity: DoctorSeverity;
  readonly message: string;
  readonly fixable: boolean;
  readonly fixed?: boolean;
  readonly fixError?: string;
  readonly hint?: string;
}

export interface SelfDoctorReport {
  readonly installPath: string;
  readonly repoPath: string;
  readonly status: SelfStatus;
  readonly findings: DoctorFinding[];
  readonly fixesApplied: number;
  readonly fixesAttempted: number;
  readonly healthy: boolean;
}

export interface DoctorOptions extends SelfServiceOptions {
  readonly fix?: boolean;
}

export async function runSelfDoctor(
  options: DoctorOptions = {},
): Promise<Result<SelfDoctorReport, StorageError>> {
  const runner = options.runner ?? realCommandRunner;
  const fix = options.fix === true;

  const status = await inspectSelf({ ...options, runner });
  if (!status.ok) return status;

  const installPath = path.resolve(options.installPath ?? status.value.install.path);
  const repoPath = path.resolve(options.repoPath ?? status.value.workspace.repoPath);

  const findings: DoctorFinding[] = [];

  // Install integrity
  if (!status.value.install.isGitCheckout) {
    findings.push({
      id: "install.not-git",
      severity: "blocker",
      message: "Installation is not a git checkout; self update cannot fast-forward",
      fixable: false,
      hint: "Reinstall via the published install script (git clone) to enable updates",
    });
  } else if (status.value.install.dirty === true) {
    findings.push({
      id: "install.dirty",
      severity: "blocker",
      message: "Installation working tree has local changes; self update would refuse to fast-forward",
      fixable: false,
      hint: "Commit or stash changes inside the install checkout, then retry",
    });
  }

  // Workspace manifest
  if (!status.value.workspace.schema.manifestExists) {
    const finding: DoctorFinding = {
      id: "workspace.no-manifest",
      severity: "warning",
      message: "Workspace manifest is missing (.monsthera/manifest.json); will be created on first migrate",
      fixable: true,
    };
    if (fix) {
      const migrated = await migrateWorkspace(repoPath);
      if (migrated.ok) {
        findings.push({ ...finding, fixed: true });
      } else {
        findings.push({ ...finding, fixed: false, fixError: migrated.error.message });
      }
    } else {
      findings.push(finding);
    }
  } else if (status.value.workspace.schema.compatible === false) {
    findings.push({
      id: "workspace.schema-future",
      severity: "blocker",
      message: `Workspace schema ${status.value.workspace.schema.workspace} is newer than supported ${status.value.workspace.schema.current}`,
      fixable: false,
      hint: "Upgrade Monsthera to a build that supports this schema, or restore from a compatible backup",
    });
  }

  // Dolt process metadata
  const dolt = status.value.processes.dolt;
  await applyDoltFindings(installPath, dolt, fix, findings, "dolt");

  const fixesAttempted = findings.filter((f) => f.fixable && fix).length;
  const fixesApplied = findings.filter((f) => f.fixed === true).length;
  const healthy = !findings.some(
    (f) => f.severity === "blocker" || (f.severity === "warning" && f.fixed !== true),
  );

  return ok({
    installPath,
    repoPath,
    status: status.value,
    findings,
    fixesAttempted,
    fixesApplied,
    healthy,
  });
}

async function applyDoltFindings(
  installPath: string,
  dolt: SelfStatus["processes"]["dolt"],
  fix: boolean,
  findings: DoctorFinding[],
  kind: ManagedProcessKind,
): Promise<void> {
  if (dolt.pid === null) return;

  if (dolt.source === "legacy-pid") {
    const finding: DoctorFinding = {
      id: "dolt.legacy-pid",
      severity: "warning",
      message: dolt.running
        ? `Dolt is tracked by legacy .pid file (pid ${dolt.pid}); JSON metadata is missing`
        : `Legacy .pid file points at a dead process (pid ${dolt.pid})`,
      fixable: true,
      hint: dolt.running
        ? "self doctor --fix will adopt the legacy pid into trusted JSON metadata"
        : "self doctor --fix will remove the stale legacy .pid file",
    };
    if (fix) {
      const adopted = await adoptLegacyPidFile(installPath, kind);
      if (adopted.ok) {
        findings.push({ ...finding, fixed: true });
      } else if (adopted.error.details?.["action"] === "removed") {
        // Cleanup of a dead legacy pid is itself a successful fix.
        findings.push({ ...finding, fixed: true });
      } else {
        findings.push({ ...finding, fixed: false, fixError: extractMessage(adopted.error) });
      }
    } else {
      findings.push(finding);
    }
    return;
  }

  if (!dolt.running) {
    const finding: DoctorFinding = {
      id: "dolt.stale-metadata",
      severity: "warning",
      message: `Dolt metadata references a dead process (pid ${dolt.pid})`,
      fixable: true,
      hint: "self doctor --fix will remove the stale metadata so the process can be cleanly restarted",
    };
    if (fix) {
      const cleaned = await cleanupStaleMetadata(installPath, kind);
      if (cleaned.ok && cleaned.value.removed) {
        findings.push({ ...finding, fixed: true });
      } else if (cleaned.ok) {
        findings.push({ ...finding, fixed: false, fixError: "process appeared running on second look" });
      } else {
        findings.push({ ...finding, fixed: false, fixError: cleaned.error.message });
      }
    } else {
      findings.push(finding);
    }
    return;
  }

  if (!dolt.trusted) {
    findings.push({
      id: "dolt.untrusted",
      severity: "blocker",
      message: `Dolt is running (pid ${dolt.pid}) but command does not match metadata (${dolt.reason ?? "no reason"})`,
      fixable: false,
      hint: "Stop Dolt manually (kill ${pid}), remove .monsthera/run/dolt.json, then restart with self restart dolt",
    });
  }
}

function extractMessage(error: StorageError | ValidationError): string {
  return error.message;
}
