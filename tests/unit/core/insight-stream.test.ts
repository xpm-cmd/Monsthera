import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InsightStream } from "../../../src/core/insight-stream.js";

describe("InsightStream", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it("outputs info at normal verbosity", () => {
    const stream = new InsightStream("normal");
    stream.info("hello");
    expect(errorSpy).toHaveBeenCalledWith("[AGORA] hello");
  });

  it("suppresses info at quiet verbosity", () => {
    const stream = new InsightStream("quiet");
    stream.info("hello");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("outputs debug only at verbose", () => {
    const normal = new InsightStream("normal");
    normal.debug("dbg");
    expect(errorSpy).not.toHaveBeenCalled();

    const verbose = new InsightStream("verbose");
    verbose.debug("dbg");
    expect(errorSpy).toHaveBeenCalledWith("[AGORA] [debug] dbg");
  });

  it("always outputs warn and error", () => {
    const stream = new InsightStream("quiet");
    stream.warn("w");
    stream.error("e");
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
