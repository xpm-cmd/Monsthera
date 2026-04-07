import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { main } from "../../../src/cli/main.js";
import { VERSION } from "../../../src/core/constants.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  return new Promise(async (resolve) => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await fn();
    } finally {
      process.stdout.write = orig;
    }
    resolve(chunks.join(""));
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CLI main()", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Prevent process.exit from actually exiting
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--version prints VERSION to stdout", async () => {
    const output = await captureStdout(() => main(["--version"]));
    expect(output.trim()).toBe(VERSION);
  });

  it("-v prints VERSION to stdout", async () => {
    const output = await captureStdout(() => main(["-v"]));
    expect(output.trim()).toBe(VERSION);
  });

  it("--help prints usage summary to stdout", async () => {
    const output = await captureStdout(() => main(["--help"]));
    expect(output).toContain("monsthera");
    expect(output).toContain("serve");
    expect(output).toContain("status");
  });

  it("-h prints usage summary to stdout", async () => {
    const output = await captureStdout(() => main(["-h"]));
    expect(output).toContain("USAGE");
    expect(output).toContain("COMMANDS");
  });

  it("no args prints help to stdout", async () => {
    const output = await captureStdout(() => main([]));
    expect(output).toContain("monsthera");
  });

  it("unknown command prints error and exits with code 1", async () => {
    await main(["unknownxyz"]);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown command: unknownxyz"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("unknown command suggests --help", async () => {
    await main(["badcommand"]);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--help"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("status command prints JSON status to stdout", async () => {
    const output = await captureStdout(() => main(["status"]));
    // Should be parseable JSON
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("uptime");
    expect(parsed).toHaveProperty("subsystems");
    expect(parsed.version).toBe(VERSION);
  });
});
