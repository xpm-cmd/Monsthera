import { describe, it, expect } from "vitest";
import { ok, err } from "../../../src/core/result.js";
import { StorageError } from "../../../src/core/errors.js";
import { renderEmbeddingDiagnostic } from "../../../src/cli/doctor-commands.js";

/**
 * `monsthera doctor` Embeddings block. The interesting path is the
 * unreachable-provider remediation — the 2026-06-10 audit had Ollama down and
 * semantic search silently degrading to BM25; doctor must name that and tell
 * the operator exactly how to fix it.
 */
describe("renderEmbeddingDiagnostic", () => {
  it("reports BM25-only without a remediation when semantic search is disabled", () => {
    const out = renderEmbeddingDiagnostic({
      semanticEnabled: false,
      modelName: "nomic-embed-text",
      dimensions: 768,
      embeddingModel: "nomic-embed-text",
      health: undefined,
    });
    expect(out).toContain("Semantic search: disabled (BM25-only)");
    expect(out).toContain("monsthera self enable-semantic");
    expect(out).not.toContain("UNAVAILABLE");
  });

  it("reports the provider as ready when the healthCheck passes", () => {
    const out = renderEmbeddingDiagnostic({
      semanticEnabled: true,
      modelName: "nomic-embed-text",
      dimensions: 768,
      embeddingModel: "nomic-embed-text",
      health: ok({ ready: true as const }),
    });
    expect(out).toContain("nomic-embed-text (768d) — ready");
    expect(out).not.toContain("UNAVAILABLE");
  });

  it("surfaces the silent BM25 fallback and actionable remediation when the provider is unreachable", () => {
    const out = renderEmbeddingDiagnostic({
      semanticEnabled: true,
      modelName: "nomic-embed-text",
      dimensions: 768,
      embeddingModel: "nomic-embed-text",
      health: err(new StorageError("Ollama not reachable at http://127.0.0.1:11434")),
    });
    expect(out).toContain("nomic-embed-text — UNAVAILABLE");
    // The underlying error is preserved...
    expect(out).toContain("Ollama not reachable at http://127.0.0.1:11434");
    // ...and the operator is told it is silently degrading to BM25...
    expect(out).toContain("silently falling back to BM25");
    // ...with the exact two remediations.
    expect(out).toContain("ollama pull nomic-embed-text");
    expect(out).toContain("MONSTHERA_SEMANTIC_ENABLED=false");
  });

  it("uses the configured embedding model in the pull remediation", () => {
    const out = renderEmbeddingDiagnostic({
      semanticEnabled: true,
      modelName: "mxbai-embed-large",
      dimensions: 1024,
      embeddingModel: "mxbai-embed-large",
      health: err(new StorageError("connection refused")),
    });
    expect(out).toContain("ollama pull mxbai-embed-large");
  });
});
