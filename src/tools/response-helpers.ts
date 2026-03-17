/**
 * Shared MCP tool response helpers.
 */

export function okJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function errText(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

export function errJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], isError: true };
}

export function errService(result: { message: string; data?: Record<string, unknown> }) {
  return result.data ? errJson({ error: result.message, ...result.data }) : errText(result.message);
}
