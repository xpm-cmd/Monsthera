/**
 * MCP tool surface for `code_query` (M3 phase 3, ADR-017 D6).
 *
 * Reads from the in-memory `CodeInventoryService` snapshot. The tool is a
 * thin adapter: validate at the boundary with Zod, hand the parsed input to
 * the service, and shape the result for the MCP transport.
 *
 * The tool never builds the inventory itself. When the cache is empty the
 * service surfaces an empty result with a `recommendedNextActions` hint
 * pointing at `monsthera code reindex` — the MCP server is intentionally
 * side-effect-free (ADR-015 Resolved Decisions). Reindex lives in the CLI
 * because that's where shelling out to `git ls-files` is allowed.
 */

import { z } from "zod/v4";

import type { CodeInventoryService } from "../code-intelligence/inventory/service.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { errorResponse, successResponse } from "./validation.js";

const ARTIFACT_KINDS = [
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "namespace",
  "module",
  "record",
  "file",
] as const;

const CodeQuerySchema = z.object({
  query: z.string().min(2).max(200),
  kinds: z.array(z.enum(ARTIFACT_KINDS)).optional(),
  paths: z.array(z.string().min(1)).max(100).optional(),
  languages: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export type CodeQueryToolInput = z.infer<typeof CodeQuerySchema>;

export function codeQueryToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "code_query",
      description:
        "Search the lightweight code inventory (ADR-017 M3) for symbols and files matching a name or path token. Returns ranked hits with kind/language/line metadata. The inventory is read-only here — when empty, the response includes a hint to run `monsthera code reindex` from the CLI.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description:
              "Search terms (2-200 chars). Multiple tokens AND together; CamelCase identifiers match either as a unit or by token.",
            minLength: 2,
            maxLength: 200,
          },
          kinds: {
            type: "array",
            items: { type: "string", enum: [...ARTIFACT_KINDS] },
            description:
              "Optional kind filter. Defaults to all kinds. `file` matches file-level entries (basename + path).",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional exact-path or directory-prefix filter. Glob expansion is the caller's job.",
            maxItems: 100,
          },
          languages: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional language filter (e.g. `typescript`, `python`). Matches the inventory's recorded language tags.",
          },
          limit: {
            type: "number",
            description: "Max hits to return (1-500). Defaults to 50 in the service.",
            minimum: 1,
            maximum: 500,
          },
        },
        required: ["query"],
      },
    },
  ];
}

export async function handleCodeQueryTool(
  name: string,
  args: Record<string, unknown>,
  inventoryService: CodeInventoryService,
): Promise<ToolResponse> {
  if (name !== "code_query") {
    return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
  const parsed = CodeQuerySchema.safeParse(args);
  if (!parsed.success) {
    return errorResponse("VALIDATION_FAILED", formatZodError(parsed.error));
  }
  const result = await inventoryService.query(parsed.data);
  if (!result.ok) {
    return errorResponse(result.error.code, result.error.message);
  }
  return successResponse(result.value);
}

/**
 * Compress the Zod issue list into a single human-readable line. The tool
 * boundary deliberately echoes only the first issue plus a count so the
 * MCP response stays predictable; full issue lists are noise to LLM
 * callers and `safeParse` retains them for tests that need them.
 */
function formatZodError(error: z.ZodError): string {
  const issues = error.issues;
  if (issues.length === 0) return "Invalid input";
  const first = issues[0]!;
  const path = first.path.length > 0 ? first.path.join(".") : "<root>";
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return `${path}: ${first.message}${more}`;
}
