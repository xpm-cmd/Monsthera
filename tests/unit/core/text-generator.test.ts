import { describe, it, expect, vi, afterEach } from "vitest";
import {
  OllamaTextGenerator,
  OpenAITextGenerator,
  StubTextGenerator,
  type TextGenerator,
} from "../../../src/core/text-generator.js";

type MockResponse = { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> };

function mockFetchOnce(res: MockResponse) {
  const fn = vi.fn().mockResolvedValue({
    ok: res.ok,
    status: res.status ?? (res.ok ? 200 : 500),
    json: res.json ?? (async () => ({})),
    text: res.text ?? (async () => ""),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StubTextGenerator", () => {
  it("returns an empty string and is always healthy", async () => {
    const gen: TextGenerator = new StubTextGenerator();
    expect(gen.modelName).toBe("stub");
    const g = await gen.generate("anything");
    expect(g.ok && g.value).toBe("");
    const h = await gen.healthCheck();
    expect(h.ok).toBe(true);
  });
});

describe("OllamaTextGenerator", () => {
  it("posts to /api/generate, sets format:json when requested, returns the response field", async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ response: "hi there" }) });
    const gen = new OllamaTextGenerator({ ollamaUrl: "http://host:11434/", model: "gemma4:latest" });
    const res = await gen.generate("prompt", { json: true });

    expect(res.ok && res.value).toBe("hi there");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://host:11434/api/generate"); // trailing slash trimmed
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.format).toBe("json");
    expect(body.model).toBe("gemma4:latest");
  });

  it("returns err on a non-2xx response", async () => {
    mockFetchOnce({ ok: false, status: 500, text: async () => "boom" });
    const gen = new OllamaTextGenerator({ ollamaUrl: "http://host:11434", model: "m" });
    const res = await gen.generate("p");
    expect(res.ok).toBe(false);
  });

  it("healthCheck hits /api/tags", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    const gen = new OllamaTextGenerator({ ollamaUrl: "http://host:11434", model: "m" });
    const res = await gen.healthCheck();
    expect(res.ok).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://host:11434/api/tags");
  });
});

describe("OpenAITextGenerator", () => {
  it("errors without an API key and never calls fetch", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    const gen = new OpenAITextGenerator({ baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" });
    const res = await gen.generate("p");
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const h = await gen.healthCheck();
    expect(h.ok).toBe(false);
  });

  it("sends Bearer auth + response_format, parses choices[0].message.content", async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }] }),
    });
    const gen = new OpenAITextGenerator({
      baseUrl: "https://api.openai.com/v1/",
      apiKey: "test-key",
      model: "gpt-4o-mini",
    });
    const res = await gen.generate("prompt", { json: true });

    expect(res.ok && res.value).toBe("hello");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toEqual({ role: "user", content: "prompt" });
  });

  it("omits response_format when json is not requested", async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }) });
    const gen = new OpenAITextGenerator({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m" });
    await gen.generate("p");
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.response_format).toBeUndefined();
  });

  it("returns err on a non-2xx response", async () => {
    mockFetchOnce({ ok: false, status: 401, text: async () => "unauthorized" });
    const gen = new OpenAITextGenerator({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m" });
    const res = await gen.generate("p");
    expect(res.ok).toBe(false);
  });
});
