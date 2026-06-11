import { ok, err } from "./result.js";
import type { Result } from "./result.js";
import { StorageError } from "./errors.js";
import type { MonstheraError } from "./errors.js";

/**
 * Shared HTTP primitive for every Ollama (and Ollama-shaped) call in the
 * codebase. Before B3 the fetch + JSON-parse + timeout + error-wrap pattern
 * was triplicated across `search/embedding.ts`, `sessions/llm-summarizer.ts`,
 * and `core/text-generator.ts`, drifting in small ways (the embedding path
 * has no timeout; healthChecks skip body parsing).
 *
 * Error MESSAGES are caller-supplied so each call site keeps its exact
 * pre-consolidation text — consumers' tests pin those strings.
 */
export interface OllamaRequestSpec {
  /** Full request URL (callers keep ownership of path construction). */
  readonly url: string;
  readonly method: "GET" | "POST";
  /** JSON-serialized request body; POST only. */
  readonly body?: unknown;
  /**
   * Request timeout. ABSENT means no abort signal at all — the embedding
   * path deliberately has no timeout, so the default must not add one.
   */
  readonly timeoutMs?: number;
  /** Non-ok responses become `${statusErrorMessage} (${status})`. */
  readonly statusErrorMessage: string;
  /** Include the response text as `body` in the error details (generate/embed shape). */
  readonly includeBodyDetail?: boolean;
  /** Thrown fetches become this message with `{ cause }` details. */
  readonly transportErrorMessage: string;
  /** "json" (default) parses the response body; "none" skips reading it (healthCheck shape). */
  readonly parse?: "json" | "none";
}

/** Strip trailing slashes — shared base-URL normalization for Ollama endpoints. */
export function normalizeOllamaBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Perform one JSON-over-HTTP request against an Ollama-style endpoint and
 * wrap every failure mode as a `Result`. Returns the parsed JSON payload
 * (as `unknown` — field extraction stays at the call site), or `undefined`
 * when `parse: "none"`.
 */
export async function ollamaRequest(
  spec: OllamaRequestSpec,
): Promise<Result<unknown, MonstheraError>> {
  try {
    const response = await fetch(spec.url, {
      method: spec.method,
      ...(spec.body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec.body) }
        : {}),
      ...(spec.timeoutMs !== undefined ? { signal: AbortSignal.timeout(spec.timeoutMs) } : {}),
    });

    if (!response.ok) {
      if (spec.includeBodyDetail) {
        const body = await response.text().catch(() => "");
        return err(
          new StorageError(`${spec.statusErrorMessage} (${response.status})`, {
            status: response.status,
            body,
          }),
        );
      }
      return err(new StorageError(`${spec.statusErrorMessage} (${response.status})`));
    }

    if (spec.parse === "none") return ok(undefined);
    return ok((await response.json()) as unknown);
  } catch (e) {
    return err(
      new StorageError(spec.transportErrorMessage, {
        cause: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
