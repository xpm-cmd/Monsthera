import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { MonstheraError } from "../core/errors.js";
import { StorageError } from "../core/errors.js";

/** Interface for embedding providers (Ollama, HuggingFace, etc.) */
export interface EmbeddingProvider {
  embed(text: string): Promise<Result<number[], MonstheraError>>;
  embedBatch(texts: string[]): Promise<Result<number[][], MonstheraError>>;
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
    this.baseUrl = options.ollamaUrl.replace(/\/+$/, "");
    this.modelName = options.embeddingModel;
    // nomic-embed-text default; overridable for other models
    this.dimensions = options.dimensions ?? 768;
  }

  async embed(text: string): Promise<Result<number[], MonstheraError>> {
    try {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.modelName, prompt: text }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return err(
          new StorageError(`Ollama embedding failed (${response.status})`, {
            status: response.status,
            body,
          }),
        );
      }

      const data = (await response.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding)) {
        return err(new StorageError("Ollama response missing embedding array"));
      }

      return ok(data.embedding);
    } catch (e) {
      return err(
        new StorageError("Ollama embedding request failed", {
          cause: e instanceof Error ? e.message : String(e),
        }),
      );
    }
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
}
