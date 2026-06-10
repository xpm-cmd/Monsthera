import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { MonstheraError } from "../core/errors.js";
import { StorageError } from "../core/errors.js";
import { ollamaRequest, normalizeOllamaBaseUrl } from "../core/ollama-client.js";

/** Interface for embedding providers (Ollama, HuggingFace, etc.) */
export interface EmbeddingProvider {
  embed(text: string): Promise<Result<number[], MonstheraError>>;
  embedBatch(texts: string[]): Promise<Result<number[][], MonstheraError>>;
  /** Verify the provider is reachable and the model is available. */
  healthCheck(): Promise<Result<{ ready: true }, MonstheraError>>;
  readonly dimensions: number;
  readonly modelName: string;
}

/**
 * Stub embedding provider for Phase 4.
 * Returns empty arrays — the service layer checks dimensions > 0
 * to decide whether to run the semantic search path.
 */
export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 0;
  readonly modelName = "stub";

  async embed(_text: string): Promise<Result<number[], MonstheraError>> {
    return ok([]);
  }

  async embedBatch(texts: string[]): Promise<Result<number[][], MonstheraError>> {
    return ok(texts.map(() => []));
  }

  async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
    return ok({ ready: true });
  }
}

/**
 * Ollama embedding provider.
 * Calls POST /api/embeddings for each text input.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  private readonly baseUrl: string;

  constructor(options: {
    ollamaUrl: string;
    embeddingModel: string;
    dimensions?: number;
  }) {
    this.baseUrl = normalizeOllamaBaseUrl(options.ollamaUrl);
    this.modelName = options.embeddingModel;
    // nomic-embed-text default; overridable for other models
    this.dimensions = options.dimensions ?? 768;
  }

  async embed(text: string): Promise<Result<number[], MonstheraError>> {
    // Deliberately no timeoutMs: bulk reindex embeds can be slow and the
    // embedding path has never had a request timeout.
    const result = await ollamaRequest({
      url: `${this.baseUrl}/api/embeddings`,
      method: "POST",
      body: { model: this.modelName, prompt: text },
      includeBodyDetail: true,
      statusErrorMessage: "Ollama embedding failed",
      transportErrorMessage: "Ollama embedding request failed",
    });
    if (!result.ok) return result;

    const data = result.value as { embedding?: number[] };
    if (!Array.isArray(data.embedding)) {
      return err(new StorageError("Ollama response missing embedding array"));
    }
    return ok(data.embedding);
  }

  async embedBatch(texts: string[]): Promise<Result<number[][], MonstheraError>> {
    const results: number[][] = [];
    for (const text of texts) {
      const result = await this.embed(text);
      if (!result.ok) return result as Result<never, MonstheraError>;
      results.push(result.value);
    }
    return ok(results);
  }

  async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
    // 1. Check if Ollama is reachable (no timeout — pre-consolidation semantics)
    const tags = await ollamaRequest({
      url: `${this.baseUrl}/api/tags`,
      method: "GET",
      statusErrorMessage: "Ollama API error",
      transportErrorMessage: `Ollama not reachable at ${this.baseUrl}`,
    });
    if (!tags.ok) return tags;

    // 2. Check if the model is available
    const data = tags.value as { models?: Array<{ name: string }> };
    const models = data.models ?? [];
    const modelBase = this.modelName.split(":")[0]!;
    const available = models.some(
      (m) => m.name === this.modelName || m.name.startsWith(`${modelBase}:`),
    );

    if (!available) {
      const installed = models.map((m) => m.name).join(", ") || "(none)";
      return err(
        new StorageError(
          `Embedding model "${this.modelName}" not found in Ollama. Installed: ${installed}. Run: ollama pull ${this.modelName}`,
        ),
      );
    }

    return ok({ ready: true });
  }
}
