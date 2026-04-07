import { describe, it, expect, vi } from "vitest";
import { createLogger, type LogEntry, type LogLevel } from "../../../src/core/logger.js";

function captureLogger(level?: LogLevel, domain?: string) {
  const entries: LogEntry[] = [];
  const logger = createLogger({
    level,
    domain,
    output: (entry) => entries.push(entry),
  });
  return { logger, entries };
}

describe("createLogger()", () => {
  it("creates a logger with default level info", () => {
    const { logger, entries } = captureLogger();
    logger.debug("should not appear");
    logger.info("should appear");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("should appear");
  });

  it("emits JSON-serializable entries to output function", () => {
    const { logger, entries } = captureLogger();
    logger.info("hello world");
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // Verify it's JSON-serializable
    expect(() => JSON.stringify(entry)).not.toThrow();
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("hello world");
  });

  it("filters debug messages at info level", () => {
    const { logger, entries } = captureLogger("info");
    logger.debug("debug msg");
    expect(entries).toHaveLength(0);
  });

  it("emits all levels at debug level", () => {
    const { logger, entries } = captureLogger("debug");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("log entries contain a valid ISO 8601 timestamp", () => {
    const { logger, entries } = captureLogger();
    logger.info("timestamped");
    const entry = entries[0]!;
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(isNaN(new Date(entry.timestamp).getTime())).toBe(false);
  });

  it("log entries contain domain when set", () => {
    const { logger, entries } = captureLogger("info", "my-domain");
    logger.info("with domain");
    expect(entries[0]!.domain).toBe("my-domain");
  });

  it("log entries do not include domain when not set", () => {
    const { logger, entries } = captureLogger("info");
    logger.info("no domain");
    expect(entries[0]!.domain).toBeUndefined();
  });

  it("child logger inherits parent domain", () => {
    const { logger, entries } = captureLogger("info", "parent-domain");
    const child = logger.child({ service: "svc" });
    child.info("from child");
    expect(entries[0]!.domain).toBe("parent-domain");
  });

  it("child logger merges additional context into entries", () => {
    const { logger, entries } = captureLogger("info");
    const child = logger.child({ requestId: "req-123", userId: "user-456" });
    child.info("child message");
    expect(entries[0]!.requestId).toBe("req-123");
    expect(entries[0]!.userId).toBe("user-456");
  });

  it("child logger can override domain", () => {
    const { logger, entries } = captureLogger("info", "original");
    const child = logger.child({ domain: "overridden" });
    child.info("new domain");
    expect(entries[0]!.domain).toBe("overridden");
  });

  it("error level is always emitted even at info level", () => {
    const { logger, entries } = captureLogger("info");
    logger.error("critical error");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("error");
  });

  it("custom output captures entries for assertions", () => {
    const captured: LogEntry[] = [];
    const logger = createLogger({
      output: (entry) => captured.push(entry),
    });
    logger.info("test capture", { extra: "data" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.extra).toBe("data");
    expect(captured[0]!.level).toBe("info");
  });

  it("context passed to log methods is merged into entry", () => {
    const { logger, entries } = captureLogger("info");
    logger.warn("with context", { traceId: "t-789", count: 42 });
    expect(entries[0]!.traceId).toBe("t-789");
    expect(entries[0]!.count).toBe(42);
  });

  it("default output writes to process.stderr", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ level: "info" });
    logger.info("stderr test");
    expect(writeSpy).toHaveBeenCalledOnce();
    const written = writeSpy.mock.calls[0]![0] as string;
    expect(written).toContain('"message":"stderr test"');
    expect(written.endsWith("\n")).toBe(true);
    writeSpy.mockRestore();
  });
});
