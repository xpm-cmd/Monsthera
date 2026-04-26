import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectManagedProcess,
  legacyPidPath,
  writeProcessMetadata,
} from "../../../src/ops/process-registry.js";

async function tempRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "monsthera-process-"));
}

describe("process registry", () => {
  it("reports missing process metadata as not managed", async () => {
    const repo = await tempRepo();
    const result = await inspectManagedProcess(repo, "dolt");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pid).toBeNull();
    expect(result.value.running).toBe(false);
    expect(result.value.trusted).toBe(true);
    expect(result.value.source).toBe("missing");
  });

  it("reads JSON metadata for a running process", async () => {
    const repo = await tempRepo();
    const write = await writeProcessMetadata(repo, {
      kind: "dolt",
      pid: process.pid,
      command: [process.execPath],
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    });
    expect(write.ok).toBe(true);

    const result = await inspectManagedProcess(repo, "dolt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pid).toBe(process.pid);
    expect(result.value.running).toBe(true);
    expect(result.value.source).toBe("json");
  });

  it("marks a running JSON-managed process untrusted when command validation fails", async () => {
    const repo = await tempRepo();
    const write = await writeProcessMetadata(repo, {
      kind: "dolt",
      pid: process.pid,
      command: ["definitely-not-the-current-command"],
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    });
    expect(write.ok).toBe(true);

    const result = await inspectManagedProcess(repo, "dolt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.running).toBe(true);
    expect(result.value.trusted).toBe(false);
    expect(result.value.reason).toBeTruthy();
  });

  it("keeps legacy pid files readable but untrusted", async () => {
    const repo = await tempRepo();
    await fs.mkdir(path.dirname(legacyPidPath(repo, "dolt")), { recursive: true });
    await fs.writeFile(legacyPidPath(repo, "dolt"), `${process.pid}\n`, "utf-8");

    const result = await inspectManagedProcess(repo, "dolt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pid).toBe(process.pid);
    expect(result.value.running).toBe(true);
    expect(result.value.trusted).toBe(false);
    expect(result.value.source).toBe("legacy-pid");
  });
});
