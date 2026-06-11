import { describe, it, expect, afterEach, vi } from "vitest";
import { ollamaRequest, normalizeOllamaBaseUrl } from "../../../src/core/ollama-client.js";

/**
 * B3 (audit P3): the fetch+parse+timeout+error-wrap pattern against Ollama
 * was triplicated across embedding.ts, llm-summarizer.ts, and
 * text-generator.ts. This is the shared primitive's contract: messages are
 * caller-supplied so every call site keeps its EXACT pre-consolidation
 * error text.
 */

function mockFetchOnce(res: {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}) {
  const fn = vi.fn().mockResolvedValue({
    ok: res.ok,
    status: res.status ?? 200,
    json: res.json ?? (async () => ({})),
    text: res.text ?? (async () => ""),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeOllamaBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeOllamaBaseUrl("http://localhost:11434///")).toBe("http://localhost:11434");
    expect(normalizeOllamaBaseUrl("http://localhost:11434")).toBe("http://localhost:11434");
  });
});

describe("ollamaRequest", () => {
  it("POSTs a JSON body and returns the parsed response", async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ embedding: [1, 2] }) });

    const result = await ollamaRequest({
      url: "http://x/api/embeddings",
      method: "POST",
      body: { model: "m", prompt: "p" },
      statusErrorMessage: "Ollama embedding failed",
      transportErrorMessage: "Ollama embedding request failed",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ embedding: [1, 2] });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/api/embeddings");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ model: "m", prompt: "p" }));
    expect(init.signal).toBeUndefined();
  });

  it("attaches an abort signal only when timeoutMs is given", async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({}) });

    await ollamaRequest({
      url: "http://x/api/generate",
      method: "POST",
      body: {},
      timeoutMs: 1234,
      statusErrorMessage: "Ollama generate failed",
      transportErrorMessage: "Ollama generate request failed",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("wraps a non-ok status using the caller's message, with status + body detail", async () => {
    mockFetchOnce({ ok: false, status: 500, text: async () => "boom" });

    const result = await ollamaRequest({
      url: "http://x/api/generate",
      method: "POST",
      body: {},
      includeBodyDetail: true,
      statusErrorMessage: "Ollama generate failed",
      transportErrorMessage: "Ollama generate request failed",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Ollama generate failed (500)");
    expect(result.error.details).toMatchObject({ status: 500, body: "boom" });
  });

  it("omits the body detail when includeBodyDetail is not set (healthCheck shape)", async () => {
    mockFetchOnce({ ok: false, status: 404 });

    const result = await ollamaRequest({
      url: "http://x/api/tags",
      method: "GET",
      statusErrorMessage: "Ollama API error",
      transportErrorMessage: "Ollama not reachable at http://x",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Ollama API error (404)");
    expect(result.error.details ?? {}).not.toHaveProperty("body");
  });

  it("wraps transport failures using the caller's message with the cause", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await ollamaRequest({
      url: "http://x/api/embeddings",
      method: "POST",
      body: {},
      statusErrorMessage: "Ollama embedding failed",
      transportErrorMessage: "Ollama embedding request failed",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Ollama embedding request failed");
    expect(result.error.details).toMatchObject({ cause: "ECONNREFUSED" });
  });

  it("GET with parse 'none' performs no json read and resolves undefined", async () => {
    const json = vi.fn();
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, json, text: async () => "" });
    vi.stubGlobal("fetch", fn);

    const result = await ollamaRequest({
      url: "http://x/api/tags",
      method: "GET",
      timeoutMs: 5000,
      parse: "none",
      statusErrorMessage: "Ollama healthCheck failed",
      transportErrorMessage: "Ollama unreachable",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });
});
