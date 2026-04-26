import { describe, expect, it } from "vitest";
import { ok, err } from "../../../src/core/result.js";
import { ConfigurationError, StorageError } from "../../../src/core/errors.js";
import { runMigrations, type WorkspaceMigration } from "../../../src/workspace/migrations.js";
import type { WorkspaceManifest } from "../../../src/workspace/manifest.js";

function manifest(version: number): WorkspaceManifest {
  return {
    workspaceSchemaVersion: version,
    createdBy: "test",
    lastOpenedBy: "test",
    portableData: { knowledgeRoot: "knowledge", doltDataDir: ".monsthera/dolt" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("runMigrations", () => {
  it("is a no-op when from === to", async () => {
    const m = manifest(1);
    const result = await runMigrations(m, "/tmp", 1, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspaceSchemaVersion).toBe(1);
  });

  it("rejects when manifest is newer than target", async () => {
    const m = manifest(3);
    const result = await runMigrations(m, "/tmp", 2, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect(result.error.message).toContain("downgrade");
  });

  it("rejects when no migration is registered for an intermediate version", async () => {
    const m = manifest(1);
    // No migration for v1 → v2.
    const result = await runMigrations(m, "/tmp", 2, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect(result.error.message).toContain("v1 to v2");
  });

  it("runs registered migrations in order from→to", async () => {
    const log: string[] = [];
    const v1to2: WorkspaceMigration = {
      fromVersion: 1,
      description: "v1 → v2",
      run: async (input) => {
        log.push("v1→v2");
        return ok({ ...input, workspaceSchemaVersion: 2 });
      },
    };
    const v2to3: WorkspaceMigration = {
      fromVersion: 2,
      description: "v2 → v3",
      run: async (input) => {
        log.push("v2→v3");
        return ok({ ...input, workspaceSchemaVersion: 3 });
      },
    };

    const result = await runMigrations(manifest(1), "/tmp", 3, { 1: v1to2, 2: v2to3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspaceSchemaVersion).toBe(3);
    expect(log).toEqual(["v1→v2", "v2→v3"]);
  });

  it("aborts on the first migration error", async () => {
    const log: string[] = [];
    const v1to2: WorkspaceMigration = {
      fromVersion: 1,
      description: "v1 → v2 (broken)",
      run: async () => {
        log.push("v1→v2");
        return err(new StorageError("simulated failure"));
      },
    };
    const v2to3: WorkspaceMigration = {
      fromVersion: 2,
      description: "v2 → v3",
      run: async (input) => {
        log.push("v2→v3");
        return ok({ ...input, workspaceSchemaVersion: 3 });
      },
    };

    const result = await runMigrations(manifest(1), "/tmp", 3, { 1: v1to2, 2: v2to3 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("simulated failure");
    expect(log).toEqual(["v1→v2"]);
  });

  it("rejects a migration that does not advance the schema version", async () => {
    const buggy: WorkspaceMigration = {
      fromVersion: 1,
      description: "v1 → v1 (forgot to bump)",
      run: async (input) => ok({ ...input, workspaceSchemaVersion: 1 }),
    };

    const result = await runMigrations(manifest(1), "/tmp", 2, { 1: buggy });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("did not advance");
  });
});
