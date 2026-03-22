/**
 * Shared MCP tool response helpers.
 *
 * Responses use minified JSON (no indentation) to minimise token cost
 * when consumed by LLMs.  Pretty-printing added ~50 % overhead on
 * large payloads with zero benefit for machine consumers.
 */

export function okJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
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
