import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  backupWorkspace,
  inspectWorkspace,
  migrateWorkspace,
  restoreWorkspace,
} from "../../../src/workspace/service.js";
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from "../../../src/workspace/manifest.js";

async function tempRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "monsthera-workspace-"));
}

describe("workspace service", () => {
  it("reports missing manifest as compatible status", async () => {
    const repo = await tempRepo();
    const result = await inspectWorkspace(repo);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schema.manifestExists).toBe(false);
    expect(result.value.schema.compatible).toBe(true);
    expect(result.value.paths.knowledgeRoot).toBe(path.join(repo, "knowledge"));
  });

  it("creates an idempotent workspace manifest", async () => {
    const repo = await tempRepo();

    const first = await migrateWorkspace(repo);
    const second = await migrateWorkspace(repo);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.created).toBe(true);
    expect(second.value.created).toBe(false);
    expect(second.value.manifest.workspaceSchemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION);
  });

  it("backs up and restores portable workspace data", async () => {
    const repo = await tempRepo();
    await fs.mkdir(path.join(repo, "knowledge", "notes"), { recursive: true });
    await fs.writeFile(path.join(repo, "knowledge", "notes", "one.md"), "hello\n", "utf-8");
    await fs.mkdir(path.join(repo, ".monsthera", "dolt", "monsthera"), { recursive: true });
    await fs.writeFile(path.join(repo, ".monsthera", "dolt", "monsthera", "db.txt"), "dolt\n", "utf-8");

    const backup = await backupWorkspace(repo);
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    expect(backup.value.included).toContain("knowledge");
    expect(backup.value.included).toContain("dolt");

    await fs.rm(path.join(repo, "knowledge"), { recursive: true, force: true });
    await fs.rm(path.join(repo, ".monsthera", "dolt"), { recursive: true, force: true });

    const denied = await restoreWorkspace(repo, backup.value.path);
    expect(denied.ok).toBe(false);

    const restored = await restoreWorkspace(repo, backup.value.path, { force: true });
    expect(restored.ok).toBe(true);
    expect(await fs.readFile(path.join(repo, "knowledge", "notes", "one.md"), "utf-8")).toBe("hello\n");
    expect(await fs.readFile(path.join(repo, ".monsthera", "dolt", "monsthera", "db.txt"), "utf-8")).toBe("dolt\n");
  });
});
