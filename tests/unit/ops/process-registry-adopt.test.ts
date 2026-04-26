import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptLegacyPidFile,
  cleanupStaleMetadata,
  inspectManagedProcess,
  legacyPidPath,
  processMetadataPath,
  writeProcessMetadata,
} from "../../../src/ops/process-registry.js";
import { ErrorCode } from "../../../src/core/errors.js";

const cleanups: string[] = [];

async function tempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-adopt-"));
  cleanups.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("adoptLegacyPidFile", () => {
  it("returns a validation error when there is no legacy pid file", async () => {
    const repo = await tempRepo();
    const result = await adoptLegacyPidFile(repo, "dolt");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("removes a stale legacy pid file pointing at a dead process", async () => {
    const repo = await tempRepo();
    const legacy = legacyPidPath(repo, "dolt");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, "1\n", "utf-8");

    const result = await adoptLegacyPidFile(repo, "dolt");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(result.error.details?.["action"]).toBe("removed");

    await expect(fs.access(legacy)).rejects.toBeTruthy();
  });

  it("promotes a live legacy pid into trusted JSON metadata", async () => {
    const repo = await tempRepo();
    const legacy = legacyPidPath(repo, "dolt");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, `${process.pid}\n`, "utf-8");

    const adopt = await adoptLegacyPidFile(repo, "dolt");
    expect(adopt.ok).toBe(true);
    if (!adopt.ok) return;
    expect(adopt.value.metadata.pid).toBe(process.pid);
    expect(adopt.value.metadata.kind).toBe("dolt");
    expect(adopt.value.metadata.command.length).toBeGreaterThan(0);

    await expect(fs.access(legacy)).rejects.toBeTruthy();
    await expect(fs.access(processMetadataPath(repo, "dolt"))).resolves.toBeUndefined();

    const inspected = await inspectManagedProcess(repo, "dolt");
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.source).toBe("json");
    expect(inspected.value.running).toBe(true);
  });
});

describe("stopManagedProcess", () => {
  it("treats a dead process as already stopped (tolerates ESRCH)", async () => {
    const repo = await tempRepo();
    const deadPid = 0x7ffffffe;
    await writeProcessMetadata(repo, {
      kind: "dolt",
      pid: deadPid,
      command: ["dolt", "sql-server"],
      cwd: repo,
      startedAt: new Date().toISOString(),
    });

    const { stopManagedProcess } = await import("../../../src/ops/process-registry.js");
    const result = await stopManagedProcess(repo, "dolt");
    // PID is dead so inspect reports running=false; stop is a noop and returns ok.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.running).toBe(false);
  });
});

describe("cleanupStaleMetadata", () => {
  it("is a no-op when no metadata exists", async () => {
    const repo = await tempRepo();
    const result = await cleanupStaleMetadata(repo, "dolt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removed).toBe(false);
    expect(result.value.source).toBe("missing");
  });

  it("does not remove metadata for a live process", async () => {
    const repo = await tempRepo();
    await writeProcessMetadata(repo, {
      kind: "dolt",
      pid: process.pid,
      command: [process.execPath],
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    });

    const result = await cleanupStaleMetadata(repo, "dolt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removed).toBe(false);
  });

  it("removes metadata pointing at a dead process", async () => {
    const repo = await tempRepo();
    const deadPid = 0x7ffffffe;
    await writeProcessMetadata(repo, {
      kind: "dolt",
      pid: deadPid,
      command: ["/nonexistent/dolt-binary"],
      cwd: repo,
      startedAt: new Date().toISOString(),
    });

    const removed = await cleanupStaleMetadata(repo, "dolt");
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.removed).toBe(true);

    await expect(fs.access(processMetadataPath(repo, "dolt"))).rejects.toBeTruthy();
  });
});
