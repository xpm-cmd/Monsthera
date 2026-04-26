import { describe, expect, it } from "vitest";
import { realCommandRunner } from "../../../src/ops/command-runner.js";

describe("realCommandRunner", () => {
  it("returns stdout/stderr on success", async () => {
    const result = await realCommandRunner({
      command: "node",
      args: ["-e", "process.stdout.write('hello'); process.stderr.write('warn');"],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdout).toBe("hello");
    expect(result.value.stderr).toBe("warn");
  });

  it("captures stderr in the error details when a command fails", async () => {
    const result = await realCommandRunner({
      command: "node",
      args: ["-e", "console.error('build broken: missing module foo'); process.exit(2);"],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("build broken: missing module foo");
    expect(result.error.details?.["stderr"]).toContain("build broken");
    expect(result.error.details?.["exitCode"]).toBe(2);
  });

  it("captures exit code for non-zero exits", async () => {
    const result = await realCommandRunner({
      command: "node",
      args: ["-e", "process.exit(7);"],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.["exitCode"]).toBe(7);
  });
});
