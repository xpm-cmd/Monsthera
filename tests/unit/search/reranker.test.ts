import { describe, it, expect } from "vitest";
import { ok, err } from "../../../src/core/result.js";
import type { Result } from "../../../src/core/result.js";
import { type MonstheraError, StorageError } from "../../../src/core/errors.js";
import type { TextGenerator } from "../../../src/core/text-generator.js";
import {
  StubReranker,
  CrossEncoderReranker,
  parseRerankScores,
  type RerankCandidate,
} from "../../../src/search/reranker.js";

const cands: readonly RerankCandidate[] = [
  { id: "a", text: "A" },
  { id: "b", text: "B" },
];

function fakeGenerator(opts: {
  output?: string;
  failGenerate?: boolean;
  healthy?: boolean;
}): TextGenerator {
  return {
    modelName: "fake",
    async generate(): Promise<Result<string, MonstheraError>> {
      return opts.failGenerate ? err(new StorageError("generate boom")) : ok(opts.output ?? "{}");
    },
    async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
      return opts.healthy === false ? err(new StorageError("down")) : ok({ ready: true });
    },
  };
}

describe("StubReranker", () => {
  it("returns the neutral multiplier 1.0 for every candidate", async () => {
    const res = await new StubReranker().rerank("q", cands);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([
      { id: "a", score: 1 },
      { id: "b", score: 1 },
    ]);
  });
});

describe("parseRerankScores", () => {
  it("parses the documented {scores:[...]} shape", () => {
    const out = parseRerankScores('{"scores":[{"id":"a","score":0.5},{"id":"b","score":0.9}]}', cands);
    expect(out).toEqual([
      { id: "a", score: 0.5 },
      { id: "b", score: 0.9 },
    ]);
  });

  it("accepts a bare array too", () => {
    expect(parseRerankScores('[{"id":"a","score":1},{"id":"b","score":0}]', cands)).toEqual([
      { id: "a", score: 1 },
      { id: "b", score: 0 },
    ]);
  });

  it("clamps scores into [0,1]", () => {
    expect(parseRerankScores('[{"id":"a","score":5},{"id":"b","score":-3}]', cands)).toEqual([
      { id: "a", score: 1 },
      { id: "b", score: 0 },
    ]);
  });

  it("fills omitted candidates with 0 and ignores unknown ids", () => {
    expect(parseRerankScores('[{"id":"a","score":0.7},{"id":"zzz","score":0.9}]', cands)).toEqual([
      { id: "a", score: 0.7 },
      { id: "b", score: 0 },
    ]);
  });

  it("strips ```json fences before parsing", () => {
    expect(parseRerankScores('```json\n{"scores":[{"id":"a","score":0.3}]}\n```', cands)).toEqual([
      { id: "a", score: 0.3 },
      { id: "b", score: 0 },
    ]);
  });

  it("returns null for non-JSON output", () => {
    expect(parseRerankScores("the documents are all great", cands)).toBeNull();
  });

  it("returns null when no known id is scored", () => {
    expect(parseRerankScores('[{"id":"zzz","score":0.5}]', cands)).toBeNull();
  });
});

describe("CrossEncoderReranker", () => {
  it("scores candidates from valid LLM JSON", async () => {
    const rr = new CrossEncoderReranker(
      fakeGenerator({ output: JSON.stringify({ scores: [{ id: "a", score: 0.9 }, { id: "b", score: 0.2 }] }) }),
    );
    const res = await rr.rerank("q", cands);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([
      { id: "a", score: 0.9 },
      { id: "b", score: 0.2 },
    ]);
  });

  it("errs when the generator fails (service degrades to identity)", async () => {
    const res = await new CrossEncoderReranker(fakeGenerator({ failGenerate: true })).rerank("q", cands);
    expect(res.ok).toBe(false);
  });

  it("errs when the output cannot be parsed", async () => {
    const res = await new CrossEncoderReranker(fakeGenerator({ output: "no json here" })).rerank("q", cands);
    expect(res.ok).toBe(false);
  });

  it("delegates healthCheck to the generator", async () => {
    const res = await new CrossEncoderReranker(fakeGenerator({ healthy: false })).healthCheck();
    expect(res.ok).toBe(false);
  });
});
