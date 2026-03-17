import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { ZodError } from "zod/v4";
import { CAPABILITY_TOOL_NAMES, type CapabilityToolName } from "../core/tool-manifest.js";
import { BUILTIN_WORKFLOW_NAMES } from "./builtins.js";
import { type WorkflowYamlDocument, WorkflowYamlSchema } from "./schema.js";
import type { WorkflowCatalogEntry, WorkflowSpec, WorkflowStepSpec, WorkflowStepToolName } from "./types.js";

export const CUSTOM_WORKFLOW_DIR = ".agora/workflows";
const CUSTOM_WORKFLOW_PREFIX = `${CUSTOM_WORKFLOW_DIR}/`;
const CUSTOM_WORKFLOW_NAME_PREFIX = "custom:";
const KNOWN_TOOL_NAMES = new Set<string>(CAPABILITY_TOOL_NAMES);
const BUILTIN_WORKFLOW_NAME_SET = new Set<string>(BUILTIN_WORKFLOW_NAMES);

export interface WorkflowLoadWarning {
  filePath: string;
  message: string;
}

export interface LoadedCustomWorkflow {
  name: string;
  localName: string;
  description: string;
  filePath: string;
  tools: WorkflowStepToolName[];
  spec: WorkflowSpec;
}

export interface LoadCustomWorkflowsOptions {
  validateTool?: (name: string) => boolean;
}

export interface LoadCustomWorkflowsResult {
  workflows: LoadedCustomWorkflow[];
  warnings: WorkflowLoadWarning[];
}

interface ParsedLine {
  indent: number;
  content: string;
  lineNumber: number;
}

export async function loadCustomWorkflows(
  repoPath: string,
  options: LoadCustomWorkflowsOptions = {},
): Promise<LoadCustomWorkflowsResult> {
  const workflowDir = join(repoPath, CUSTOM_WORKFLOW_DIR);
  let entries: Dirent[];
  try {
    entries = await readdir(workflowDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return {
      workflows: [],
      warnings: [],
    };
  }

  const warnings: WorkflowLoadWarning[] = [];
  const workflows: LoadedCustomWorkflow[] = [];
  const seenQualifiedNames = new Map<string, string>();
  const validateTool = options.validateTool ?? ((name: string) => KNOWN_TOOL_NAMES.has(name));

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.match(/\.ya?ml$/i)) continue;

    const absolutePath = join(workflowDir, entry.name);
    const filePath = `${CUSTOM_WORKFLOW_PREFIX}${entry.name}`;

    let raw: string;
    try {
      raw = await readFile(absolutePath, "utf-8");
    } catch (error) {
      warnings.push({
        filePath,
        message: `Failed to read workflow definition: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const parsed = parseCustomWorkflow(filePath, raw, validateTool);
    warnings.push(...parsed.warnings);
    if (!parsed.workflow) continue;

    const duplicateSource = seenQualifiedNames.get(parsed.workflow.name);
    if (duplicateSource) {
      warnings.push({
        filePath,
        message: `Duplicate workflow name \`${parsed.workflow.name}\`; already defined in ${duplicateSource}`,
      });
      continue;
    }

    seenQualifiedNames.set(parsed.workflow.name, filePath);
    if (BUILTIN_WORKFLOW_NAME_SET.has(parsed.workflow.localName)) {
      warnings.push({
        filePath,
        message: `Local name \`${parsed.workflow.localName}\` matches a built-in workflow; invoke it as \`${parsed.workflow.name}\``,
      });
    }

    workflows.push(parsed.workflow);
  }

  workflows.sort((a, b) => a.name.localeCompare(b.name));
  warnings.sort((a, b) => {
    const pathCompare = a.filePath.localeCompare(b.filePath);
    return pathCompare !== 0 ? pathCompare : a.message.localeCompare(b.message);
  });

  return { workflows, warnings };
}

export function summarizeCustomWorkflows(workflows: LoadedCustomWorkflow[]): WorkflowCatalogEntry[] {
  return workflows.map((workflow) => ({
    name: workflow.name,
    description: workflow.description,
    tools: [...workflow.tools],
    source: "custom",
    filePath: workflow.filePath,
  }));
}

export function findCustomWorkflow(
  workflows: LoadedCustomWorkflow[],
  requestedName: string,
): LoadedCustomWorkflow | null {
  const normalized = requestedName.trim();
  if (!normalized) return null;

  const qualifiedName = qualifyCustomWorkflowName(normalized);
  return workflows.find((workflow) => (
    workflow.name === normalized
    || workflow.localName === normalized
    || workflow.name === qualifiedName
  )) ?? null;
}

export function qualifyCustomWorkflowName(name: string): string {
  const localName = normalizeWorkflowLocalName(name);
  return `${CUSTOM_WORKFLOW_NAME_PREFIX}${localName}`;
}

function parseCustomWorkflow(
  filePath: string,
  raw: string,
  validateTool: (name: string) => boolean,
): { workflow: LoadedCustomWorkflow | null; warnings: WorkflowLoadWarning[] } {
  let parsedDocument: unknown;
  try {
    parsedDocument = parseYamlDocument(raw);
  } catch (error) {
    return {
      workflow: null,
      warnings: [{
        filePath,
        message: `Failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }

  const validated = WorkflowYamlSchema.safeParse(parsedDocument);
  if (!validated.success) {
    return {
      workflow: null,
      warnings: [{
        filePath,
        message: `Invalid workflow definition: ${formatZodError(validated.error)}`,
      }],
    };
  }

  const built = buildWorkflowSpec(filePath, validated.data, validateTool);
  if (!built.workflow) {
    return {
      workflow: null,
      warnings: [{ filePath, message: built.message }],
    };
  }

  return { workflow: built.workflow, warnings: [] };
}

function buildWorkflowSpec(
  filePath: string,
  document: WorkflowYamlDocument,
  validateTool: (name: string) => boolean,
): { workflow: LoadedCustomWorkflow | null; message: string } {
  const localName = normalizeWorkflowLocalName(document.name);
  const stepKeys = new Set<string>();
  const tools: WorkflowStepToolName[] = [];
  const steps: WorkflowStepSpec[] = [];

  for (const step of document.steps) {
    const key = step.output ?? step.key;
    if (!key) {
      return {
        workflow: null,
        message: "Each workflow step must declare an output key",
      };
    }
    if (stepKeys.has(key)) {
      return {
        workflow: null,
        message: `Duplicate step output key \`${key}\``,
      };
    }

    stepKeys.add(key);
    if (step.type === "quorum_checkpoint") {
      tools.push("quorum_checkpoint");
      steps.push({
        key,
        type: "quorum_checkpoint",
        tool: "quorum_checkpoint",
        input: step.input,
        description: step.description,
        condition: step.condition,
      });
      continue;
    }

    if (!validateTool(step.tool)) {
      return {
        workflow: null,
        message: `Unknown workflow tool \`${step.tool}\``,
      };
    }

    const toolName = step.tool as CapabilityToolName;
    tools.push(toolName);
    steps.push({
      key,
      type: step.type,
      tool: toolName,
      input: step.input ?? {},
      description: step.description,
      condition: step.condition,
      onError: step.onError,
      forEach: step.forEach,
    });
  }

  const description = document.description?.trim() || `Custom workflow ${localName}`;
  const requiredParams = uniqueValues(document.requiredParams ?? document.params ?? []);
  const qualifiedName = qualifyCustomWorkflowName(localName);

  return {
    workflow: {
      name: qualifiedName,
      localName,
      description,
      filePath,
      tools,
      spec: {
        name: qualifiedName,
        description,
        requiredParams: requiredParams.length > 0 ? requiredParams : undefined,
        defaults: document.defaults,
        steps,
      },
    },
    message: "",
  };
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeWorkflowLocalName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith(CUSTOM_WORKFLOW_NAME_PREFIX)
    ? trimmed.slice(CUSTOM_WORKFLOW_NAME_PREFIX.length).trim()
    : trimmed;
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function parseYamlDocument(raw: string): unknown {
  const tokens = tokenizeYaml(raw);
  if (tokens.length === 0) return {};
  if (tokens[0]?.indent !== 0) {
    throw new Error(`Top-level keys must start at column 1 (line ${tokens[0]?.lineNumber ?? 1})`);
  }

  const parsed = parseBlock(tokens, 0, 0);
  if (parsed.nextIndex !== tokens.length) {
    const trailing = tokens[parsed.nextIndex];
    throw new Error(`Unexpected trailing content at line ${trailing?.lineNumber ?? "unknown"}`);
  }
  return parsed.value;
}

function tokenizeYaml(raw: string): ParsedLine[] {
  const normalized = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const lines = normalized.replace(/\t/g, "  ").split(/\r?\n/);
  const tokens: ParsedLine[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const originalLine = lines[index] ?? "";
    const withoutComments = stripYamlComment(originalLine);
    const trimmed = withoutComments.trim();
    if (!trimmed) continue;

    const indent = withoutComments.match(/^ */)?.[0].length ?? 0;
    tokens.push({
      indent,
      content: withoutComments.slice(indent).trimEnd(),
      lineNumber: index + 1,
    });
  }

  return tokens;
}

function parseBlock(
  tokens: ParsedLine[],
  index: number,
  indent: number,
): { value: unknown; nextIndex: number } {
  const token = tokens[index];
  if (!token) {
    throw new Error("Unexpected end of workflow document");
  }

  return token.content.startsWith("- ")
    ? parseSequence(tokens, index, indent)
    : parseMapping(tokens, index, indent);
}

function parseMapping(
  tokens: ParsedLine[],
  index: number,
  indent: number,
): { value: Record<string, unknown>; nextIndex: number } {
  const result: Record<string, unknown> = {};

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;
    if (token.indent < indent) break;
    if (token.indent > indent) {
      throw new Error(`Unexpected indentation at line ${token.lineNumber}`);
    }
    if (token.content.startsWith("- ")) {
      break;
    }

    const pair = splitTopLevelKeyValue(token.content, token.lineNumber);
    if (!pair) {
      throw new Error(`Expected key:value mapping at line ${token.lineNumber}`);
    }

    if (!pair.value) {
      const nextToken = tokens[index + 1];
      if (nextToken && nextToken.indent > indent) {
        const child = parseBlock(tokens, index + 1, nextToken.indent);
        result[pair.key] = child.value;
        index = child.nextIndex;
        continue;
      }

      result[pair.key] = null;
      index += 1;
      continue;
    }

    result[pair.key] = parseInlineValue(pair.value, token.lineNumber);
    index += 1;
  }

  return { value: result, nextIndex: index };
}

function parseSequence(
  tokens: ParsedLine[],
  index: number,
  indent: number,
): { value: unknown[]; nextIndex: number } {
  const result: unknown[] = [];

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;
    if (token.indent < indent) break;
    if (token.indent > indent) {
      throw new Error(`Unexpected indentation at line ${token.lineNumber}`);
    }
    if (!token.content.startsWith("- ")) {
      break;
    }

    const rawItem = token.content.slice(2).trim();
    if (!rawItem) {
      const nextToken = tokens[index + 1];
      if (nextToken && nextToken.indent > indent) {
        const child = parseBlock(tokens, index + 1, nextToken.indent);
        result.push(child.value);
        index = child.nextIndex;
        continue;
      }

      result.push(null);
      index += 1;
      continue;
    }

    if (!rawItem.startsWith("{") && !rawItem.startsWith("[") && splitTopLevelKeyValue(rawItem, token.lineNumber)) {
      let itemEnd = index + 1;
      while (itemEnd < tokens.length && (tokens[itemEnd]?.indent ?? 0) > indent) {
        itemEnd += 1;
      }

      const itemTokens: ParsedLine[] = [
        { indent: indent + 2, content: rawItem, lineNumber: token.lineNumber },
        ...tokens.slice(index + 1, itemEnd),
      ];
      const parsedItem = parseMapping(itemTokens, 0, indent + 2);
      if (parsedItem.nextIndex !== itemTokens.length) {
        const trailing = itemTokens[parsedItem.nextIndex];
        throw new Error(`Unexpected YAML content at line ${trailing?.lineNumber ?? token.lineNumber}`);
      }

      result.push(parsedItem.value);
      index = itemEnd;
      continue;
    }

    result.push(parseInlineValue(rawItem, token.lineNumber));
    index += 1;
  }

  return { value: result, nextIndex: index };
}

function parseInlineValue(value: string, lineNumber: number): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) return trimmed;
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return unquote(trimmed);
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return parseInlineObject(trimmed.slice(1, -1), lineNumber);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return parseInlineArray(trimmed.slice(1, -1), lineNumber);
  }
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function parseInlineArray(value: string, lineNumber: number): unknown[] {
  const items = splitTopLevel(value, ",", lineNumber);
  return items.map((item) => parseInlineValue(item, lineNumber));
}

function parseInlineObject(value: string, lineNumber: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of splitTopLevel(value, ",", lineNumber)) {
    const pair = splitTopLevelKeyValue(entry, lineNumber);
    if (!pair) {
      throw new Error(`Invalid inline object entry at line ${lineNumber}`);
    }
    result[normalizeInlineKey(pair.key)] = parseInlineValue(pair.value, lineNumber);
  }
  return result;
}

function normalizeInlineKey(key: string): string {
  const trimmed = key.trim();
  return ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? unquote(trimmed)
    : trimmed;
}

function splitTopLevelKeyValue(
  value: string,
  lineNumber: number,
): { key: string; value: string } | null {
  const separatorIndex = findTopLevelSeparator(value, ":");
  if (separatorIndex === -1) return null;

  const key = value.slice(0, separatorIndex).trim();
  if (!key) {
    throw new Error(`Missing key before ':' at line ${lineNumber}`);
  }

  return {
    key,
    value: value.slice(separatorIndex + 1).trim(),
  };
}

function splitTopLevel(value: string, separator: string, lineNumber: number): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!char) continue;

    if ((char === "\"" || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
      current += char;
      continue;
    }

    if (!quote) {
      if (char === "{") braceDepth += 1;
      if (char === "}") braceDepth -= 1;
      if (char === "[") bracketDepth += 1;
      if (char === "]") bracketDepth -= 1;

      if (braceDepth < 0 || bracketDepth < 0) {
        throw new Error(`Malformed inline YAML value at line ${lineNumber}`);
      }

      if (char === separator && braceDepth === 0 && bracketDepth === 0) {
        const normalized = current.trim();
        if (normalized) parts.push(normalized);
        current = "";
        continue;
      }
    }

    current += char;
  }

  if (quote || braceDepth !== 0 || bracketDepth !== 0) {
    throw new Error(`Malformed inline YAML value at line ${lineNumber}`);
  }

  const trailing = current.trim();
  if (trailing) parts.push(trailing);
  return parts;
}

function findTopLevelSeparator(value: string, separator: string): number {
  let quote: "'" | "\"" | null = null;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!char) continue;

    if ((char === "\"" || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }

    if (quote) continue;
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth -= 1;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth -= 1;
      continue;
    }
    if (char === separator && braceDepth === 0 && bracketDepth === 0) {
      return index;
    }
  }

  return -1;
}

function stripYamlComment(line: string): string {
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (!char) continue;

    if ((char === "\"" || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }

    if (char === "#" && !quote) {
      return line.slice(0, index);
    }
  }

  return line;
}

function unquote(value: string): string {
  const inner = value.slice(1, -1);
  if (value.startsWith("\"")) {
    return inner
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, "\"")
      .replace(/\\n/g, "\n");
  }
  return inner.replace(/\\'/g, "'");
}
