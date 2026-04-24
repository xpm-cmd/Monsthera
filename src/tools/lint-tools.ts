import * as path from "node:path";
import type { MonstheraContainer } from "../core/container.js";
import { PolicyLoader } from "../work/policy-loader.js";
import { scanCorpus } from "../work/lint.js";
import type { LintInclude, LintRegistry, OrphanCitationFinding } from "../work/lint.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse } from "./validation.js";

export type { ToolDefinition, ToolResponse };

const VALID_REGISTRIES: readonly LintRegistry[] = ["canonical-values", "anti-examples", "all"];

/** Tool definitions surfaced by `ListTools` for the lint group. */
export function lintToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "lint_corpus",
      description:
        "Audit the knowledge + work corpus for canonical-value drift, anti-example drift (token + phrase), and orphan citations. Returns a `findings[]` array (one entry per violation) plus `errorCount` / `warningCount` tallies. `canonical_value_mismatch`, `token_drift`, and `phrase_anti_example` findings are errors (exit code 1 in the CLI); `orphan_citation` findings are warnings. Read `knowledge/notes/canonical-values.md` and `knowledge/notes/anti-example-registry.md` first to see the registries that define what drift means.",
      inputSchema: {
        type: "object" as const,
        properties: {
          include: {
            type: "string",
            description: "Which article kinds to scan: 'knowledge', 'work', or 'both' (default).",
          },
          registry: {
            type: "string",
            description:
              "Which registry family to apply: 'canonical-values', 'anti-examples', or 'all' (default).",
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

  const registryRaw = typeof args.registry === "string" ? args.registry : "all";
  if (!VALID_REGISTRIES.includes(registryRaw as LintRegistry)) {
    return errorResponse(
      "VALIDATION_FAILED",
      `"registry" must be one of ${VALID_REGISTRIES.join("|")} (received "${registryRaw}")`,
    );
  }
  const registry = registryRaw as LintRegistry;

  const repoRoot = container.config.repoPath;
  const markdownRoot = path.resolve(repoRoot, container.config.storage.markdownRoot);

  const policyLoader = new PolicyLoader({
    knowledgeRepo: container.knowledgeRepo,
    logger: container.logger,
  });
  const [canonicalValues, antiExampleTokens, antiExamplePhrases] = await Promise.all([
    policyLoader.getCanonicalValues(),
    policyLoader.getAntiExampleTokens(),
    policyLoader.getAntiExamplePhrases(),
  ]);

  const orphansResult = await container.structureService.getOrphanCitations();
  const orphanFindings: OrphanCitationFinding[] = orphansResult.ok
    ? orphansResult.value.map((o) => ({
        file: o.sourcePath ?? "",
        severity: "warning" as const,
        rule: "orphan_citation" as const,
        sourceArticleId: o.sourceArticleId,
        missingRefId: o.missingRefId,
      }))
    : [];

  const result = await scanCorpus({
    markdownRoot,
    include,
    registry,
    repoRoot,
    canonicalValues,
    antiExampleTokens,
    antiExamplePhrases,
    orphanFindings,
  });

  return successResponse(result);
}
