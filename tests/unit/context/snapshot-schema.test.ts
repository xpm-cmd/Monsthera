import { describe, it, expect } from "vitest";
import { validateRecordSnapshotInput } from "../../../src/context/snapshot-schema.js";

describe("validateRecordSnapshotInput", () => {
  it("accepts a realistic snapshot payload and applies defaults", () => {
    const result = validateRecordSnapshotInput({
      agentId: "agent-1",
      workId: "w-0ieze72s",
      cwd: "/home/user/project",
      gitRef: { branch: "main", sha: "abc123", dirty: false },
      files: ["README.md", "package.json"],
      runtimes: { node: "20.11.0", python3: "3.11.4" },
      packageManagers: ["pnpm"],
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "deadbeef" }],
      memory: { totalMb: 16_000, availableMb: 8_000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agentId).toBe("agent-1");
    expect(result.value.workId).toBe("w-0ieze72s");
    expect(result.value.files).toHaveLength(2);
    expect(result.value.runtimes["node"]).toBe("20.11.0");
  });

  it("fills defaulted arrays/records when omitted", () => {
    const result = validateRecordSnapshotInput({ agentId: "agent-1", cwd: "/tmp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([]);
    expect(result.value.runtimes).toEqual({});
    expect(result.value.packageManagers).toEqual([]);
    expect(result.value.lockfiles).toEqual([]);
    expect(result.value.memory).toBeUndefined();
    expect(result.value.gitRef).toBeUndefined();
  });

  it("rejects missing required fields", () => {
    const result = validateRecordSnapshotInput({ cwd: "/tmp" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects non-string runtime versions", () => {
    const result = validateRecordSnapshotInput({
      agentId: "agent-1",
      cwd: "/tmp",
      runtimes: { node: 20 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects negative memory values", () => {
    const result = validateRecordSnapshotInput({
      agentId: "agent-1",
      cwd: "/tmp",
      memory: { totalMb: -1, availableMb: 100 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects lockfile entries missing sha256", () => {
    const result = validateRecordSnapshotInput({
      agentId: "agent-1",
      cwd: "/tmp",
      lockfiles: [{ path: "pnpm-lock.yaml" }],
    });
    expect(result.ok).toBe(false);
  });
});
