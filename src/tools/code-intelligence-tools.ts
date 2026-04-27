import type { CodeIntelligenceService } from "../code-intelligence/service.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import {
  MAX_CODE_REF_LENGTH,
  errorResponse,
  isErrorResponse,
  requireString,
  successResponse,
} from "./validation.js";

const REF_EXAMPLE = "e.g. 'src/auth/session.ts' or 'src/auth/session.ts#L42'";

export function codeIntelligenceToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "code_get_ref",
      description:
        `Inspect a code reference path and show whether it exists plus linked knowledge, work, active work, and policy owners. ${REF_EXAMPLE}. This is code-ref intelligence, not AST/call-graph analysis.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          ref: { type: "string", description: `Code reference path, optionally with line anchor. ${REF_EXAMPLE}.` },
        },
        required: ["ref"],
      },
    },
    {
      name: "code_find_owners",
      description:
        `List the knowledge and work articles that link to a code reference, without filesystem stat or risk scoring. ${REF_EXAMPLE}. Lighter-weight alternative to code_analyze_impact when you only need ownership data.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          ref: { type: "string", description: `Code reference path. ${REF_EXAMPLE}.` },
        },
        required: ["ref"],
      },
    },
    {
      name: "code_analyze_impact",
      description:
        `Analyze Monsthera operational impact for a code path: linked knowledge/work/policies, active work, missing refs, risk, and next actions. ${REF_EXAMPLE}. Use before editing or reviewing a referenced file.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          ref: { type: "string", description: `Code path or directory to analyze. ${REF_EXAMPLE}.` },
        },
        required: ["ref"],
      },
    },
    {
      name: "code_detect_changes",
      description:
        "Analyze a set of changed paths supplied by the client/harness and report which Monsthera code refs, work articles, knowledge articles, and policies are affected. This avoids shelling out from the MCP server.",
      inputSchema: {
        type: "object" as const,
        properties: {
          changed_paths: {
            type: "array",
            items: { type: "string" },
            description: "Changed file or directory paths, usually from `git diff --name-only`. Must contain at least one path.",
            minItems: 1,
          },
        },
        required: ["changed_paths"],
      },
    },
  ];
}

export async function handleCodeIntelligenceTool(
  name: string,
  args: Record<string, unknown>,
  service: CodeIntelligenceService,
): Promise<ToolResponse> {
  switch (name) {
    case "code_get_ref":
      return handleGetRef(args, service);
    case "code_find_owners":
      return handleFindOwners(args, service);
    case "code_analyze_impact":
      return handleAnalyzeImpact(args, service);
    case "code_detect_changes":
      return handleDetectChanges(args, service);
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}

async function handleGetRef(
  args: Record<string, unknown>,
  service: CodeIntelligenceService,
): Promise<ToolResponse> {
  const ref = requireString(args, "ref", MAX_CODE_REF_LENGTH);
  if (isErrorResponse(ref)) return ref;
  const result = await service.getCodeRef({ ref });
  if (!result.ok) return errorResponse(result.error.code, result.error.message);
  return successResponse(result.value);
}

async function handleFindOwners(
  args: Record<string, unknown>,
  service: CodeIntelligenceService,
): Promise<ToolResponse> {
  const ref = requireString(args, "ref", MAX_CODE_REF_LENGTH);
  if (isErrorResponse(ref)) return ref;
  const result = await service.findCodeOwners({ ref });
  if (!result.ok) return errorResponse(result.error.code, result.error.message);
  return successResponse(result.value);
}

async function handleAnalyzeImpact(
  args: Record<string, unknown>,
  service: CodeIntelligenceService,
): Promise<ToolResponse> {
  const ref = requireString(args, "ref", MAX_CODE_REF_LENGTH);
  if (isErrorResponse(ref)) return ref;
  const result = await service.analyzeCodeRefImpact({ ref });
  if (!result.ok) return errorResponse(result.error.code, result.error.message);
  return successResponse(result.value);
}

async function handleDetectChanges(
  args: Record<string, unknown>,
  service: CodeIntelligenceService,
): Promise<ToolResponse> {
  if (!Array.isArray(args.changed_paths)) {
    return errorResponse("VALIDATION_FAILED", `"changed_paths" must be an array of strings`);
  }
  if (args.changed_paths.length === 0) {
    return errorResponse(
      "VALIDATION_FAILED",
      `"changed_paths" must contain at least one path`,
    );
  }
  if (args.changed_paths.some((value) => typeof value !== "string")) {
    return errorResponse("VALIDATION_FAILED", `"changed_paths" must be an array of strings`);
  }
  const result = await service.detectChangedCodeRefs({
    changedPaths: args.changed_paths as string[],
  });
  if (!result.ok) return errorResponse(result.error.code, result.error.message);
  return successResponse(result.value);
}
