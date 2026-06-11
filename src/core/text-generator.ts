import { ok, err } from "./result.js";
import type { Result } from "./result.js";
import { StorageError, ValidationError } from "./errors.js";
import type { MonstheraError } from "./errors.js";
import { ollamaRequest, normalizeOllamaBaseUrl } from "./ollama-client.js";

/**
 * Provider-agnostic text generation primitive used by the synthesis (`think`)
 * and work→knowledge distillation features. Mirrors the `LLMSummarizer`
 * pattern from `src/sessions/`: optional dep, `healthCheck()` gates use,
 * graceful degrade. Three implementations ship: Ollama (local), an
 * OpenAI-compatible HTTP client (OpenAI / Azure / OpenRouter / vLLM / LM
 * Studio), and a Stub. All call `fetch` directly — no provider SDK.
 *
 * `opts.json` requests structured output; each provider maps it to its own
 * JSON mode (Ollama `format:"json"`, OpenAI `response_format:json_object`),
 * so callers parse identically regardless of provider.
 */
export interface TextGeneratorOptions {
  readonly json?: boolean;
  readonly temperature?: number;
}

export interface TextGenerator {
  generate(prompt: string, opts?: TextGeneratorOptions): Promise<Result<string, MonstheraError>>;
  healthCheck(): Promise<Result<{ ready: true }, MonstheraError>>;
  readonly modelName: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;

// ─── Ollama ───────────────────────────────────────────────────────────────────

export interface OllamaTextGeneratorOptions {
  readonly ollamaUrl: string;
  readonly model: string;
  readonly temperature?: number;
  readonly timeoutMs?: number;
}

export class OllamaTextGenerator implements TextGenerator {
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(options: OllamaTextGeneratorOptions) {
    this.baseUrl = normalizeOllamaBaseUrl(options.ollamaUrl);
    this.modelName = options.model;
    this.temperature = options.temperature ?? 0.2;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generate(prompt: string, opts?: TextGeneratorOptions): Promise<Result<string, MonstheraError>> {
    const result = await ollamaRequest({
      url: `${this.baseUrl}/api/generate`,
      method: "POST",
      body: {
        model: this.modelName,
        prompt,
        stream: false,
        ...(opts?.json ? { format: "json" } : {}),
        options: { temperature: opts?.temperature ?? this.temperature },
      },
      timeoutMs: this.timeoutMs,
      includeBodyDetail: true,
      statusErrorMessage: "Ollama generate failed",
      transportErrorMessage: "Ollama generate request failed",
    });
    if (!result.ok) return result;

    const data = result.value as { response?: string };
    if (typeof data.response !== "string") {
      return err(new StorageError("Ollama response missing 'response' field"));
    }
    return ok(data.response);
  }

  async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
    const result = await ollamaRequest({
      url: `${this.baseUrl}/api/tags`,
      method: "GET",
      timeoutMs: HEALTHCHECK_TIMEOUT_MS,
      parse: "none",
      statusErrorMessage: "Ollama healthCheck failed",
      transportErrorMessage: "Ollama unreachable",
    });
    if (!result.ok) return result;
    return ok({ ready: true });
  }
}

// ─── OpenAI-compatible ──────────────────────────────────────────────────────────

export interface OpenAITextGeneratorOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature?: number;
  readonly timeoutMs?: number;
}

export class OpenAITextGenerator implements TextGenerator {
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(options: OpenAITextGeneratorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.modelName = options.model;
    this.temperature = options.temperature ?? 0.2;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generate(prompt: string, opts?: TextGeneratorOptions): Promise<Result<string, MonstheraError>> {
    if (!this.apiKey) {
      return err(new ValidationError("OpenAI API key missing (set MONSTHERA_LLM_API_KEY or OPENAI_API_KEY)"));
    }
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.modelName,
          messages: [{ role: "user", content: prompt }],
          temperature: opts?.temperature ?? this.temperature,
          ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return err(new StorageError(`OpenAI chat completion failed (${response.status})`, { status: response.status, body }));
      }
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        return err(new StorageError("OpenAI response missing choices[0].message.content"));
      }
      return ok(content);
    } catch (e) {
      return err(new StorageError("OpenAI chat completion request failed", { cause: e instanceof Error ? e.message : String(e) }));
    }
  }

  async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
    if (!this.apiKey) {
      return err(new ValidationError("OpenAI API key missing (set MONSTHERA_LLM_API_KEY or OPENAI_API_KEY)"));
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
      });
      if (!response.ok) return err(new StorageError(`OpenAI healthCheck failed (${response.status})`));
      return ok({ ready: true });
    } catch (e) {
      return err(new StorageError("OpenAI endpoint unreachable", { cause: e instanceof Error ? e.message : String(e) }));
    }
  }
}

// ─── Stub ───────────────────────────────────────────────────────────────────────

/**
 * No-op generator (default when `llm.enabled` is false). Returns an empty
 * string so the service layer detects "no real LLM" and runs its degraded,
 * deterministic path — exactly how `StubEmbeddingProvider` signals no
 * embeddings via `dimensions === 0`.
 */
export class StubTextGenerator implements TextGenerator {
  readonly modelName = "stub";

  async generate(): Promise<Result<string, MonstheraError>> {
    return ok("");
  }

  async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
    return ok({ ready: true });
  }
}
