import * as path from "node:path";
import type { MonstheraContainer } from "../core/container.js";
import { PolicyLoader } from "../work/policy-loader.js";
import { scanCorpus } from "../work/lint.js";
import type { LintInclude } from "../work/lint.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse } from "./validation.js";

export type { ToolDefinition, ToolResponse };

/** Tool definitions surfaced by `ListTools` for the lint group. */
export function lintToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "lint_corpus",
      description:
        "Audit the knowledge + work corpus for canonical-value drift. Returns a `findings[]` array (one entry per violation) plus `errorCount` / `warningCount` tallies. `canonical_value_mismatch` findings are errors; `orphan_citation` findings are warnings and are only present once ref-graph auditing is wired. Read `knowledge/notes/canonical-values.md` first to see the registry that defines what drift means.",
      inputSchema: {
        type: "object" as const,
        properties: {
          include: {
            type: "string",
            description: "Which article kinds to scan: 'knowledge', 'work', or 'both' (default).",
          },
        },
      },
    },
  ];
}

export async function handleLintTool(
  name: string,
  args: Record<string, unknown>,
  container: MonstheraContainer,
): Promise<ToolResponse> {
  if (name !== "lint_corpus") {
    return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }

  const includeRaw = typeof args.include === "string" ? args.include : "both";
  if (!["knowledge", "work", "both"].includes(includeRaw)) {
    return errorResponse(
      "VALIDATION_FAILED",
      `"include" must be one of knowledge|work|both (received "${includeRaw}")`,
    );
  }
  const include = includeRaw as LintInclude;

  const markdownRoot = path.resolve(
    container.config.repoPath,
    container.config.storage.markdownRoot,
  );

  const policyLoader = new PolicyLoader({
    knowledgeRepo: container.knowledgeRepo,
    logger: container.logger,
  });
  const canonicalValues = await policyLoader.getCanonicalValues();

  const result = await scanCorpus({ markdownRoot, include, canonicalValues });

  return successResponse(result);
}
