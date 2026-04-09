import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaEmbeddingProvider } from "../../../src/search/embedding.js";

describe("OllamaEmbeddingProvider", () => {
  const defaultOpts = {
    ollamaUrl: "http://localhost:11434",
    embeddingModel: "nomic-embed-text",
  };

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct dimensions and modelName", () => {
    const provider = new OllamaEmbeddingProvider(defaultOpts);
    expect(provider.dimensions).toBe(768);
    expect(provider.modelName).toBe("nomic-embed-text");
  });

  it("allows custom dimensions", () => {
    const provider = new OllamaEmbeddingProvider({ ...defaultOpts, dimensions: 384 });
    expect(provider.dimensions).toBe(384);
  });

  it("strips trailing slashes from ollamaUrl", () => {
    const provider = new OllamaEmbeddingProvider({
      ...defaultOpts,
      ollamaUrl: "http://localhost:11434///",
    });
    // We can verify indirectly by checking the fetch call
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: [1, 2, 3] }), { status: 200 }),
    );
    provider.embed("test");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:11434/api/embeddings",
      expect.any(Object),
    );
  });

  describe("embed", () => {
    it("returns embedding array on success", async () => {
      const provider = new OllamaEmbeddingProvider(defaultOpts);
      const embedding = [0.1, 0.2, 0.3];

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding }), { status: 200 }),
      );

      const result = await provider.embed("hello world");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(embedding);
    });

    it("sends correct request body", async () => {
      const provider = new OllamaEmbeddingProvider(defaultOpts);

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding: [1] }), { status: 200 }),
      );

      await provider.embed("test prompt");

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:11434/api/embeddings",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "nomic-embed-text", prompt: "test prompt" }),
        },
      );
    });

    it("returns error on non-200 response", async () => {
      const provider = new OllamaEmbeddingProvider(defaultOpts);

      fetchSpy.mockResolvedValueOnce(
        new Response("model not found", { status: 404 }),
      );

      const result = await provider.embed("hello");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("404");
    });

    it("returns error when response missing embedding field", async () => {
      const provider = new OllamaEmbeddingProvider(defaultOpts);

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ something: "else" }), { status: 200 }),
      );

      const result = await provider.embed("hello");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("missing embedding array");
    });

    it("returns error on network failure", async () => {
      const provider = new OllamaEmbeddingProvider(defaultOpts);

      fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await provider.embed("hello");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("request failed");
    });
  });

  describe("embedBatch", () => {
    it("returns embeddings for all inputs", async () => {
      const provider = new OllamaEmbeddingProvider(defaultOpts);

      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ embedding: [1, 2] }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ embedding: [3, 4] }), { status: 200 }),
        );

      const result = await provider.embedBatch(["hello", "world"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([[1, 2], [3, 4]]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("returns empty array for empty input", async () => {
      const provider = new OllamaEmbeddingProvider(defaultOpts);

      const result = await provider.embedBatch([]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("short-circuits on first failure", async () => {
      const provider = new OllamaEmbeddingProvider(defaultOpts);

      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ embedding: [1] }), { status: 200 }),
        )
        .mockRejectedValueOnce(new Error("connection lost"))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ embedding: [3] }), { status: 200 }),
        );

      const result = await provider.embedBatch(["a", "b", "c"]);
      expect(result.ok).toBe(false);
      // Third call should not have been made
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
