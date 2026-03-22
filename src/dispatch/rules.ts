import { existsSync, readFileSync } from "node:fs";
import { join, posix as pathPosix } from "node:path";
import { z } from "zod/v4";
import { DEFAULT_MONSTHERA_DIR } from "../core/constants.js";
import { CAPABILITY_TOOL_NAMES, type CapabilityToolName } from "../core/tool-manifest.js";
import {
  COUNCIL_SPECIALIZATIONS,
  CouncilSpecializationId,
  type CouncilSpecializationId as CouncilSpecialization,
} from "../../schemas/council.js";

const DispatchActionSchema = z.string().trim().min(1).refine(
  (value): value is CapabilityToolName => CAPABILITY_TOOL_NAMES.includes(value as CapabilityToolName),
  "Invalid Monsthera tool name in dispatch rule",
);

const DispatchRuleInputSchema = z.object({
  pattern: z.string().trim().min(1).optional(),
  always: z.boolean().optional().default(false),
  actions: z.union([DispatchActionSchema, z.array(DispatchActionSchema)]).optional().transform((value) => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }),
  required_roles: z.union([CouncilSpecializationId, z.array(CouncilSpecializationId)]).optional().transform((value) => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }),
  reason: z.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!value.always && !value.pattern) {
    ctx.addIssue({
      code: "custom",
      path: ["pattern"],
      message: "Dispatch rules require a pattern unless always: true is set",
    });
  }
  if (value.actions.length === 0 && value.required_roles.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["actions"],
      message: "Dispatch rules must declare at least one action or required_role",
    });
  }
});

const DispatchRuleFileSchema = z.object({
  rules: z.array(DispatchRuleInputSchema).default([]),
});

type DispatchRuleInput = z.infer<typeof DispatchRuleInputSchema>;

export interface DispatchRule {
  pattern: string | null;
  always: boolean;
  actions: CapabilityToolName[];
  requiredRoles: CouncilSpecialization[];
  reason: string | null;
  source: "builtin" | "repo";
}

export interface DispatchRuleLoadResult {
  path: string;
  repoRuleFileExists: boolean;
  rulesSource: "builtin" | "repo";
  rules: DispatchRule[];
  warnings: string[];
}

export interface DispatchRuleMatch {
  source: "builtin" | "repo";
  selector: string;
  matchedPaths: string[];
  actions: CapabilityToolName[];
  requiredRoles: CouncilSpecialization[];
  reason: string;
}

export interface DispatchSuggestionResult {
  changedPaths: string[];
  recommendedTools: CapabilityToolName[];
  recommendedActions: CapabilityToolName[];
  requiredRoles: CouncilSpecialization[];
  quorumMin: number;
  advisoryOnly: true;
  rulesPath: string;
  repoRuleFileExists: boolean;
  rulesSource: "builtin" | "repo";
  matchedRules: DispatchRuleMatch[];
  reasoning: string[];
  warnings: string[];
}

const BUILT_IN_RULES: DispatchRule[] = normalizeDispatchRules([
  {
    pattern: "src/db/**",
    always: false,
    actions: ["analyze_complexity", "get_issue_pack"],
    required_roles: ["architect", "security"],
    reason: "Database changes need architecture and security review.",
  },
  {
    pattern: "schemas/**",
    always: false,
    actions: ["analyze_complexity", "get_issue_pack"],
    required_roles: ["architect", "security"],
    reason: "Schema changes affect contracts and data integrity.",
  },
  {
    pattern: "**/*.test.*",
    always: false,
    actions: ["analyze_test_coverage"],
    required_roles: ["patterns"],
    reason: "Test file changes should be checked for coverage and test patterns.",
  },
  {
    pattern: "tests/**",
    always: false,
    actions: ["analyze_test_coverage"],
    required_roles: ["patterns"],
    reason: "Test suite changes should be reviewed for coverage drift.",
  },
  {
    pattern: "package.json",
    always: false,
    actions: ["search_knowledge", "get_issue_pack"],
    required_roles: ["security", "patterns"],
    reason: "Dependency and script changes affect runtime and tooling behavior.",
  },
  {
    pattern: "tsconfig*.json",
    always: false,
    actions: ["search_knowledge", "get_issue_pack"],
    required_roles: ["patterns"],
    reason: "TypeScript config changes can shift build and analysis behavior.",
  },
  {
    pattern: ".monsthera/config.json",
    always: false,
    actions: ["search_knowledge", "get_issue_pack"],
    required_roles: ["security", "patterns"],
    reason: "Monsthera config changes alter trust or workflow defaults.",
  },
  {
    pattern: "src/dashboard/**",
    always: false,
    actions: ["analyze_complexity"],
    required_roles: ["design"],
    reason: "Dashboard changes need UI/UX review for usability and visual consistency.",
  },
  {
    pattern: "src/tools/*.ts",
    always: false,
    actions: ["analyze_complexity"],
    required_roles: ["design", "patterns"],
    reason: "Tool response formatting affects developer and user experience.",
  },
], "builtin");

export function getDispatchRulesPath(repoPath: string, monstheraDir = DEFAULT_MONSTHERA_DIR): string {
  return join(repoPath, monstheraDir, "dispatch-rules.yaml");
}

export function loadDispatchRules(repoPath: string, monstheraDir = DEFAULT_MONSTHERA_DIR): DispatchRuleLoadResult {
  const path = getDispatchRulesPath(repoPath, monstheraDir);
  if (!existsSync(path)) {
    return {
      path,
      repoRuleFileExists: false,
      rulesSource: "builtin",
      rules: BUILT_IN_RULES,
      warnings: [],
    };
  }

  try {
    const parsed = parseDispatchRulesYaml(readFileSync(path, "utf-8"));
    return {
      path,
      repoRuleFileExists: true,
      rulesSource: "repo",
      rules: normalizeDispatchRules(parsed.rules, "repo"),
      warnings: [],
    };
  } catch (error) {
    return {
      path,
      repoRuleFileExists: true,
      rulesSource: "builtin",
      rules: BUILT_IN_RULES,
      warnings: [
        `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
        "Falling back to built-in advisory dispatch rules.",
      ],
    };
  }
}

export function suggestActionsForChanges(
  changedPaths: string[],
  repoPath: string,
  monstheraDir = DEFAULT_MONSTHERA_DIR,
): DispatchSuggestionResult {
  const normalizedPaths = [...new Set(
    changedPaths
      .map(normalizeRepoRelativePath)
      .filter(Boolean),
  )];

  const loaded = loadDispatchRules(repoPath, monstheraDir);
  const recommendedTools = new Set<CapabilityToolName>();
  const requiredRoleSet = new Set<CouncilSpecialization>();
  const matchedRules: DispatchRuleMatch[] = [];

  for (const rule of loaded.rules) {
    const matchedPaths = rule.always
      ? [...normalizedPaths]
      : normalizedPaths.filter((filePath) => rule.pattern ? matchesDispatchPattern(filePath, rule.pattern) : false);
    if (!rule.always && matchedPaths.length === 0) continue;
    if (rule.always && normalizedPaths.length === 0) continue;

    for (const action of rule.actions) recommendedTools.add(action);
    for (const role of rule.requiredRoles) requiredRoleSet.add(role);

    const selector = rule.always ? "always" : rule.pattern ?? "unknown";
    const reason = rule.reason ?? (
      rule.always
        ? "Always-on advisory rule matched the current change set."
        : `${selector} matched the current change set.`
    );
    matchedRules.push({
      source: rule.source,
      selector,
      matchedPaths,
      actions: [...rule.actions],
      requiredRoles: [...rule.requiredRoles],
      reason,
    });
  }

  const requiredRoles = COUNCIL_SPECIALIZATIONS.filter((role) => requiredRoleSet.has(role));
  const recommendedToolList = [...recommendedTools];

  return {
    changedPaths: normalizedPaths,
    recommendedTools: recommendedToolList,
    recommendedActions: recommendedToolList,
    requiredRoles,
    quorumMin: requiredRoles.length,
    advisoryOnly: true,
    rulesPath: loaded.path,
    repoRuleFileExists: loaded.repoRuleFileExists,
    rulesSource: loaded.rulesSource,
    matchedRules,
    reasoning: matchedRules.map((rule) => buildRuleReasoning(rule)),
    warnings: loaded.warnings,
  };
}

export function parseDispatchRulesYaml(raw: string): { rules: DispatchRuleInput[] } {
  const lines = raw.replace(/\t/g, "  ").split(/\r?\n/);
  const root: { rules: Record<string, unknown>[] } = { rules: [] };
  let sawRulesRoot = false;
  let currentRule: Record<string, unknown> | null = null;
  let currentArrayKey: string | null = null;
  let currentArrayIndent = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const originalLine = lines[index] ?? "";
    const trimmedLine = stripYamlComment(originalLine).trim();
    if (!trimmedLine) continue;

    const indent = originalLine.match(/^ */)?.[0].length ?? 0;
    if (!sawRulesRoot) {
      if (indent === 0 && trimmedLine === "rules:") {
        sawRulesRoot = true;
        continue;
      }
      throw new Error(`dispatch-rules.yaml must start with a top-level "rules:" key (line ${index + 1})`);
    }

    if (currentArrayKey && indent <= currentArrayIndent) {
      currentArrayKey = null;
      currentArrayIndent = -1;
    }

    if (currentArrayKey) {
      if (!currentRule) {
        throw new Error(`Unexpected array item without a rule context at line ${index + 1}`);
      }
      const arrayItem = trimmedLine.match(/^-\s+(.+)$/);
      if (!arrayItem) {
        throw new Error(`Expected list item for ${currentArrayKey} at line ${index + 1}`);
      }
      const existing = currentRule[currentArrayKey];
      if (!Array.isArray(existing)) {
        throw new Error(`Internal parser error for ${currentArrayKey} at line ${index + 1}`);
      }
      existing.push(parseYamlScalar(arrayItem[1] ?? ""));
      continue;
    }

    const ruleStart = trimmedLine.match(/^-\s*(.*)$/);
    if (ruleStart && indent >= 2) {
      currentRule = {};
      root.rules.push(currentRule);
      const rest = ruleStart[1]?.trim() ?? "";
      if (!rest) continue;
      const { key, value } = parseYamlKeyValue(rest, index + 1);
      if (value === "") {
        currentRule[key] = [];
        currentArrayKey = key;
        currentArrayIndent = indent;
      } else {
        currentRule[key] = parseYamlValue(value);
      }
      continue;
    }

    if (!currentRule) {
      throw new Error(`Unexpected content before any rule item at line ${index + 1}`);
    }

    const { key, value } = parseYamlKeyValue(trimmedLine, index + 1);
    if (value === "") {
      currentRule[key] = [];
      currentArrayKey = key;
      currentArrayIndent = indent;
    } else {
      currentRule[key] = parseYamlValue(value);
    }
  }

  return DispatchRuleFileSchema.parse(root);
}

export function matchesDispatchPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeRepoRelativePath(filePath);
  const normalizedPattern = normalizeRepoRelativePath(pattern);
  if (!normalizedPath || !normalizedPattern) return false;

  const pathSegments = normalizedPath.split("/");
  const patternSegments = normalizedPattern.split("/");
  return matchPathSegments(pathSegments, patternSegments, 0, 0);
}

function normalizeDispatchRules(
  rules: DispatchRuleInput[],
  source: "builtin" | "repo",
): DispatchRule[] {
  return rules.map((rule) => ({
    pattern: rule.pattern ? normalizeRepoRelativePath(rule.pattern) : null,
    always: rule.always,
    actions: [...new Set(rule.actions)],
    requiredRoles: COUNCIL_SPECIALIZATIONS.filter((role) => rule.required_roles.includes(role)),
    reason: rule.reason ?? null,
    source,
  }));
}

function parseYamlKeyValue(line: string, lineNumber: number): { key: string; value: string } {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Expected key:value pair at line ${lineNumber}`);
  }
  const key = line.slice(0, separatorIndex).trim();
  if (!key) {
    throw new Error(`Missing key at line ${lineNumber}`);
  }
  return {
    key,
    value: line.slice(separatorIndex + 1).trim(),
  };
}

function parseYamlValue(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitInlineArray(value.slice(1, -1)).map((item) => parseYamlScalar(item));
  }
  return parseYamlScalar(value);
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith("\"")
      ? inner.replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
      : inner.replace(/\\'/g, "'");
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function splitInlineArray(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!char) continue;
    if ((char === "\"" || char === "'") && value[index - 1] !== "\\") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      current += char;
      continue;
    }
    if (char === "," && !quote) {
      const normalized = current.trim();
      if (normalized) items.push(normalized);
      current = "";
      continue;
    }
    current += char;
  }

  const trailing = current.trim();
  if (trailing) items.push(trailing);
  return items;
}

function stripYamlComment(line: string): string {
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (!char) continue;
    if ((char === "\"" || char === "'") && line[index - 1] !== "\\") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      continue;
    }
    if (char === "#" && !quote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function normalizeRepoRelativePath(value: string): string {
  const normalized = pathPosix.normalize(value.replace(/\\/g, "/")).replace(/^\.\/+/, "").replace(/^\/+/, "");
  return normalized === "." ? "" : normalized;
}

function buildRuleReasoning(rule: DispatchRuleMatch): string {
  const pathSummary = rule.matchedPaths.length > 0
    ? rule.matchedPaths.join(", ")
    : "the provided change set";
  return `${pathSummary} matched ${rule.selector}: ${rule.reason}`;
}

function matchPathSegments(
  pathSegments: string[],
  patternSegments: string[],
  pathIndex: number,
  patternIndex: number,
): boolean {
  if (patternIndex >= patternSegments.length) {
    return pathIndex >= pathSegments.length;
  }

  const patternSegment = patternSegments[patternIndex];
  if (patternSegment === "**") {
    if (patternIndex === patternSegments.length - 1) return true;
    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
      if (matchPathSegments(pathSegments, patternSegments, nextPathIndex, patternIndex + 1)) {
        return true;
      }
    }
    return false;
  }

  if (pathIndex >= pathSegments.length) return false;
  if (!matchesSegment(pathSegments[pathIndex] ?? "", patternSegment ?? "")) return false;
  return matchPathSegments(pathSegments, patternSegments, pathIndex + 1, patternIndex + 1);
}

function matchesSegment(segment: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(segment);
}
