import type { MonstheraConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { TextGenerator } from "../text-generator.js";
import type { EmbeddingProvider } from "../../search/embedding.js";
import type { Reranker } from "../../search/reranker.js";

import { StubEmbeddingProvider, OllamaEmbeddingProvider } from "../../search/embedding.js";
import { StubReranker, CrossEncoderReranker } from "../../search/reranker.js";

/**
 * Select the embedding provider: Ollama when semantic search is enabled and
 * configured for it, otherwise the stub.
 */
export function createEmbeddingProvider(deps: {
  config: MonstheraConfig;
  logger: Logger;
}): EmbeddingProvider {
  const { config, logger } = deps;
  let embeddingProvider: EmbeddingProvider;
  if (config.search.semanticEnabled && config.search.embeddingProvider === "ollama") {
    embeddingProvider = new OllamaEmbeddingProvider({
      ollamaUrl: config.search.ollamaUrl,
      embeddingModel: config.search.embeddingModel,
    });
    logger.info("Using Ollama embedding provider", {
      model: config.search.embeddingModel,
      url: config.search.ollamaUrl,
    });
  } else {
    embeddingProvider = new StubEmbeddingProvider();
  }
  return embeddingProvider;
}

/**
 * PR-11 — reranker stage. Cross-encoder over the text generator when enabled,
 * otherwise a no-op stub. The stage itself is gated again by `rerankEnabled`
 * inside SearchService, so a stub here is harmless.
 */
export function createReranker(deps: {
  config: MonstheraConfig;
  textGenerator: TextGenerator;
}): Reranker {
  const { config, textGenerator } = deps;
  return config.search.rerankEnabled ? new CrossEncoderReranker(textGenerator) : new StubReranker();
}
