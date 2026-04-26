/* eslint-disable no-console */
import { parseFlag, parsePositional, parseRepoPath } from "./arg-helpers.js";
import { formatError } from "./formatters.js";
import {
  backupWorkspace,
  inspectWorkspace,
  migrateWorkspace,
  restoreWorkspace,
} from "../workspace/service.js";

function workspaceHelp(): string {
  return [
    "monsthera workspace <subcommand>",
    "",
    "SUBCOMMANDS",
    "  status                  Inspect portable workspace paths and schema compatibility",
    "  migrate                 Create or update .monsthera/manifest.json",
    "  backup                  Copy portable workspace data into .monsthera/backups/",
    "  restore <backup-path>   Restore a backup; requires --force",
    "",
    "OPTIONS",
    "  --repo, -r <path>       Repository path (defaults to cwd)",
    "  --json                  Emit machine-readable JSON",
    "  --force                 Required for restore",
    "",
  ].join("\n");
}

export async function handleWorkspace(args: string[]): Promise<void> {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(workspaceHelp());
    return;
  }

  const repoPath = parseRepoPath(args) ?? process.cwd();
  const asJson = args.includes("--json");

  switch (command) {
    case "status": {
      const result = await inspectWorkspace(repoPath);
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
          "Workspace",
          `Repo: ${s.repoPath}`,
          `Manifest: ${s.schema.manifestExists ? "present" : "missing"}`,
          `Schema: ${s.schema.workspace ?? "none"} / supported ${s.schema.current}`,
          `Compatible: ${s.schema.compatible ? "yes" : "no"}`,
          `Version: ${s.version.lastOpenedBy ?? "unknown"} (current ${s.version.current})`,
          `Knowledge: ${s.paths.knowledgeRoot}`,
          `Dolt: ${s.paths.doltDataDir}`,
          `Backups: ${s.paths.backupRoot}`,
          `Config: ${s.config.valid ? "valid" : `invalid - ${s.config.error}`}`,
          "",
        ].join("\n"),
      );
      return;
    }

    case "migrate": {
      const result = await migrateWorkspace(repoPath);
      if (!result.ok) {
        console.error(formatError(result.error));
        process.exit(1);
      }
      if (asJson) {
        process.stdout.write(JSON.stringify(result.value, null, 2) + "\n");
        return;
      }
      process.stdout.write(
        `${result.value.created ? "Created" : "Updated"} workspace manifest (schema ${result.value.manifest.workspaceSchemaVersion}).\n`,
      );
      return;
    }

    case "backup": {
      const result = await backupWorkspace(repoPath);
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
          `Backup created: ${result.value.path}`,
          `Included: ${result.value.included.length ? result.value.included.join(", ") : "none"}`,
          `Skipped: ${result.value.skipped.length ? result.value.skipped.join(", ") : "none"}`,
          "",
        ].join("\n"),
      );
      return;
    }

    case "restore": {
      const backupPath = parsePositional(args.slice(1), 0) ?? parseFlag(args, "--backup");
      if (!backupPath) {
        console.error("Missing required argument: <backup-path>");
        process.exit(1);
      }
      const result = await restoreWorkspace(repoPath, backupPath, { force: args.includes("--force") });
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
          `Restored backup: ${result.value.backupId}`,
          `Restored: ${result.value.restored.length ? result.value.restored.join(", ") : "none"}`,
          `Skipped: ${result.value.skipped.length ? result.value.skipped.join(", ") : "none"}`,
          "",
        ].join("\n"),
      );
      return;
    }

    default:
      console.error(`Unknown workspace subcommand: ${command}`);
      console.error('Run "monsthera workspace --help" for usage.');
      process.exit(1);
  }
}
