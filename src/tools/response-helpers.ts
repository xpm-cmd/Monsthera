/**
 * Shared MCP tool response helpers.
 *
 * Responses use minified JSON (no indentation) to minimise token cost
 * when consumed by LLMs.  Pretty-printing added ~50 % overhead on
 * large payloads with zero benefit for machine consumers.
 */

/** Approximate response size ceiling in characters (~12 500 tokens). */
const RESPONSE_SIZE_WARNING_CHARS = 50_000;

/**
 * Callback invoked when a response exceeds the size warning threshold.
 * Override via `setResponseSizeWarningHandler` for custom behaviour (e.g.
 * logging to InsightStream).  Default is stderr.
 */
let onResponseSizeWarning: (chars: number, estimatedTokens: number) => void = (chars, tokens) => {
  process.stderr.write(`[monsthera] response size warning: ${chars} chars (~${tokens} tokens)\n`);
};

export function setResponseSizeWarningHandler(handler: typeof onResponseSizeWarning): void {
  onResponseSizeWarning = handler;
}

function wrapJson(json: string) {
  if (json.length > RESPONSE_SIZE_WARNING_CHARS) {
    onResponseSizeWarning(json.length, Math.ceil(json.length / 4));
  }
  return json;
}

export function okJson(data: unknown) {
  return { content: [{ type: "text" as const, text: wrapJson(JSON.stringify(data)) }] };
}

export function errText(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

export function errJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], isError: true };
}

export function errService(result: { message: string; data?: Record<string, unknown> }) {
  return result.data ? errJson({ error: result.message, ...result.data }) : errText(result.message);
}
