import { ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { MonstheraError } from "../core/errors.js";

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
