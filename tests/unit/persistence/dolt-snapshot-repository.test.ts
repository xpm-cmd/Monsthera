import { describe, it, expect } from "vitest";
import type { Pool } from "mysql2/promise";
import { DoltSnapshotRepository } from "../../../src/persistence/dolt-snapshot-repository.js";
import type { EnvironmentSnapshot } from "../../../src/context/snapshot-schema.js";

interface SnapshotRowShape {
  id: string;
  agent_id: string;
  work_id: string | null;
  cwd: string;
  git_ref: string | Record<string, unknown> | null;
  files: string | unknown[] | null;
  runtimes: string | Record<string, unknown> | null;
  package_managers: string | unknown[] | null;
  lockfiles: string | unknown[] | null;
  memory: string | Record<string, unknown> | null;
  raw: string | null;
  captured_at: string | Date;
}

function callParseRow(
  repo: DoltSnapshotRepository,
  row: SnapshotRowShape,
): EnvironmentSnapshot {
  return (
    repo as unknown as { parseRow: (r: SnapshotRowShape) => EnvironmentSnapshot }
  ).parseRow.bind(repo)(row);
}

describe("DoltSnapshotRepository", () => {
  it("parses a row with all JSON columns as decoded objects", () => {
    const repo = new DoltSnapshotRepository({} as Pool);
    const snapshot = callParseRow(repo, {
      id: "s-abc123",
      agent_id: "agent-1",
      work_id: "w-123",
      cwd: "/app",
      git_ref: { branch: "main", sha: "deadbeef", dirty: false },
      files: ["package.json", "src/"],
      runtimes: { node: "22.0.0" },
      package_managers: ["pnpm"],
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "abc" }],
      memory: { totalMb: 16000, availableMb: 8000 },
      raw: "raw probe output",
      captured_at: "2026-04-19T00:00:00.000Z",
    });

    expect(snapshot.id).toBe("s-abc123");
    expect(snapshot.agentId).toBe("agent-1");
    expect(snapshot.workId).toBe("w-123");
    expect(snapshot.gitRef).toEqual({ branch: "main", sha: "deadbeef", dirty: false });
    expect(snapshot.files).toEqual(["package.json", "src/"]);
    expect(snapshot.runtimes).toEqual({ node: "22.0.0" });
    expect(snapshot.packageManagers).toEqual(["pnpm"]);
    expect(snapshot.lockfiles).toEqual([{ path: "pnpm-lock.yaml", sha256: "abc" }]);
    expect(snapshot.memory).toEqual({ totalMb: 16000, availableMb: 8000 });
    expect(snapshot.raw).toBe("raw probe output");
    expect(snapshot.capturedAt).toBe("2026-04-19T00:00:00.000Z");
  });

  it("parses a row where JSON columns arrive as strings", () => {
    const repo = new DoltSnapshotRepository({} as Pool);
    const snapshot = callParseRow(repo, {
      id: "s-str",
      agent_id: "agent-2",
      work_id: null,
      cwd: "/tmp",
      git_ref: JSON.stringify({ branch: "feature/x" }),
      files: JSON.stringify([]),
      runtimes: JSON.stringify({ python3: "3.11.5" }),
      package_managers: JSON.stringify(["pip"]),
      lockfiles: JSON.stringify([]),
      memory: null,
      raw: null,
      captured_at: "2026-04-19T01:02:03.456Z",
    });

    expect(snapshot.workId).toBeUndefined();
    expect(snapshot.gitRef).toEqual({ branch: "feature/x" });
    expect(snapshot.runtimes).toEqual({ python3: "3.11.5" });
    expect(snapshot.packageManagers).toEqual(["pip"]);
    expect(snapshot.files).toEqual([]);
    expect(snapshot.lockfiles).toEqual([]);
    expect(snapshot.memory).toBeUndefined();
    expect(snapshot.raw).toBeUndefined();
  });

  it("coerces captured_at from a Date instance to an ISO string", () => {
    const repo = new DoltSnapshotRepository({} as Pool);
    const snapshot = callParseRow(repo, {
      id: "s-date",
      agent_id: "agent-3",
      work_id: null,
      cwd: "/",
      git_ref: null,
      files: [],
      runtimes: {},
      package_managers: [],
      lockfiles: [],
      memory: null,
      raw: null,
      captured_at: new Date("2026-04-19T02:00:00.000Z"),
    });

    expect(snapshot.capturedAt).toBe("2026-04-19T02:00:00.000Z");
  });

  it("defaults collection fields when the column is null", () => {
    const repo = new DoltSnapshotRepository({} as Pool);
    const snapshot = callParseRow(repo, {
      id: "s-null",
      agent_id: "agent-4",
      work_id: null,
      cwd: "/app",
      git_ref: null,
      files: null,
      runtimes: null,
      package_managers: null,
      lockfiles: null,
      memory: null,
      raw: null,
      captured_at: "2026-04-19T03:00:00.000Z",
    });

    expect(snapshot.files).toEqual([]);
    expect(snapshot.runtimes).toEqual({});
    expect(snapshot.packageManagers).toEqual([]);
    expect(snapshot.lockfiles).toEqual([]);
    expect(snapshot.gitRef).toBeUndefined();
    expect(snapshot.memory).toBeUndefined();
  });
});
