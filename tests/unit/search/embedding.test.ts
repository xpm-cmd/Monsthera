import { describe, it, expect } from "vitest";
import { StubEmbeddingProvider } from "../../../src/search/embedding.js";

describe("StubEmbeddingProvider", () => {
  const provider = new StubEmbeddingProvider();

  it("has dimensions of 0", () => {
    expect(provider.dimensions).toBe(0);
  });

  it("has modelName of stub", () => {
    expect(provider.modelName).toBe("stub");
  });

  describe("embed", () => {
    it("returns ok with empty array", async () => {
      const result = await provider.embed("hello world");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });
  });

  describe("embedBatch", () => {
    it("returns ok with empty arrays for each input", async () => {
      const result = await provider.embedBatch(["hello", "world", "foo"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([[], [], []]);
    });

    it("handles empty input array", async () => {
      const result = await provider.embedBatch([]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it("returns correct number of empty arrays", async () => {
      const result = await provider.embedBatch(["a", "b"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
    });
  });
});
