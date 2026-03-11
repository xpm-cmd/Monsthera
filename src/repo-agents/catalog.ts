import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod/v4";
import { TagSchema, TagsSchema } from "../core/input-hardening.js";
import {
  COUNCIL_SPECIALIZATIONS,
  CouncilSpecializationId,
  type CouncilSpecializationId as CouncilSpecialization,
} from "../../schemas/council.js";
import { RoleId, type RoleId as RuntimeRoleId } from "../../schemas/agent.js";

export const REPO_AGENT_MANIFEST_DIR = ".agora/agents";
const REPO_AGENT_MANIFEST_PREFIX = `${REPO_AGENT_MANIFEST_DIR}/`;
const REPO_AGENT_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const RepoAgentNameSchema = z.string().trim().min(1).max(100);
const RepoAgentDescriptionSchema = z.string().trim().min(1).max(500);

export interface RepoAgentWarning {
  filePath: string;
  message: string;
}

export interface RepoAgentManifest {
  name: string;
  description: string;
  filePath: string;
  role: RuntimeRoleId | null;
  reviewRole: CouncilSpecialization | null;
  tags: string[];
  prompt: string;
}

export interface RepoAgentCatalog {
  repoAgents: RepoAgentManifest[];
  availableReviewRoles: Record<CouncilSpecialization, string[]>;
  warnings: RepoAgentWarning[];
}

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  prompt: string;
}

interface RepoAgentParseResult {
  agent: RepoAgentManifest | null;
  warnings: RepoAgentWarning[];
}

export async function loadRepoAgentCatalog(repoPath: string): Promise<RepoAgentCatalog> {
  const manifestDir = join(repoPath, REPO_AGENT_MANIFEST_DIR);
  let entries: Dirent[];
  try {
    entries = await readdir(manifestDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return {
      repoAgents: [],
      availableReviewRoles: emptyReviewRoleMap(),
      warnings: [],
    };
  }

  const warnings: RepoAgentWarning[] = [];
  const repoAgents: RepoAgentManifest[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = `${REPO_AGENT_MANIFEST_PREFIX}${entry.name}`;
    const absolutePath = join(manifestDir, entry.name);
    let content: string;
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch (error) {
      warnings.push({
        filePath,
        message: `Failed to read manifest: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const parsed = parseRepoAgentManifest(filePath, content);
    warnings.push(...parsed.warnings);
    if (parsed.agent) {
      repoAgents.push(parsed.agent);
    }
  }

  repoAgents.sort((a, b) => a.name.localeCompare(b.name));

  const availableReviewRoles = emptyReviewRoleMap();
  for (const agent of repoAgents) {
    if (!agent.reviewRole) continue;
    availableReviewRoles[agent.reviewRole].push(agent.name);
  }

  for (const specialization of COUNCIL_SPECIALIZATIONS) {
    availableReviewRoles[specialization].sort((a, b) => a.localeCompare(b));
  }

  warnings.sort((a, b) => {
    const fileCompare = a.filePath.localeCompare(b.filePath);
    return fileCompare !== 0 ? fileCompare : a.message.localeCompare(b.message);
  });

  return { repoAgents, availableReviewRoles, warnings };
}

export function isRepoAgentManifestPath(filePath: string): boolean {
  return filePath.startsWith(REPO_AGENT_MANIFEST_PREFIX) && filePath.endsWith(".md");
}

export function parseRepoAgentManifest(filePath: string, content: string): RepoAgentParseResult {
  const warnings: RepoAgentWarning[] = [];
  const parsedFrontmatter = parseFrontmatter(content);
  if (!parsedFrontmatter) {
    return { agent: null, warnings: [{ filePath, message: "Missing or invalid YAML frontmatter" }] };
  }

  const { frontmatter, prompt } = parsedFrontmatter;
  const fallbackName = basename(filePath, ".md");

  const nameResult = RepoAgentNameSchema.safeParse(frontmatter.name);
  const name = nameResult.success ? nameResult.data : fallbackName;
  if (!nameResult.success && frontmatter.name !== undefined) {
    warnings.push({ filePath, message: "Invalid `name`; using file name instead" });
  }

  const description = parseDescription(frontmatter.description, prompt, filePath, warnings);
  const role = parseOptionalRole(frontmatter.role, filePath, warnings);
  const reviewRole = parseOptionalReviewRole(frontmatter.reviewRole, filePath, warnings);
  const tags = parseOptionalTags(frontmatter.tags, filePath, warnings);

  return {
    agent: {
      name,
      description,
      filePath,
      role,
      reviewRole,
      tags,
      prompt,
    },
    warnings,
  };
}

export function buildRepoAgentSearchSummary(agent: RepoAgentManifest): string {
  const parts = [`Repo agent: ${agent.name}`];
  if (agent.description) {
    parts.push(agent.description);
  }
  if (agent.role) {
    parts.push(`Runtime role: ${agent.role}`);
  }
  if (agent.reviewRole) {
    parts.push(`Review specialization: ${agent.reviewRole}`);
  }
  if (agent.tags.length > 0) {
    parts.push(`Tags: ${agent.tags.join(", ")}`);
  }
  const promptSnippet = summarizePrompt(agent.prompt);
  if (promptSnippet && promptSnippet !== agent.description) {
    parts.push(promptSnippet);
  }
  return parts.join(" | ");
}

export function buildRepoAgentSymbols(agent: RepoAgentManifest): Array<{ name: string }> {
  const names = new Set<string>([agent.name]);
  if (agent.role) names.add(agent.role);
  if (agent.reviewRole) names.add(agent.reviewRole);
  for (const tag of agent.tags) {
    names.add(tag);
  }
  return Array.from(names).map((name) => ({ name }));
}

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const normalizedContent = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const match = normalizedContent.match(REPO_AGENT_FRONTMATTER_PATTERN);
  if (!match) return null;

  const frontmatterSource = match[1];
  if (frontmatterSource === undefined) {
    return null;
  }

  const parsed = parseSimpleFrontmatter(frontmatterSource);
  if (!parsed) {
    return null;
  }

  return {
    frontmatter: parsed,
    prompt: normalizedContent.slice(match[0].length).trim(),
  };
}

function parseDescription(
  raw: unknown,
  prompt: string,
  filePath: string,
  warnings: RepoAgentWarning[],
): string {
  if (raw === undefined) {
    return inferDescriptionFromPrompt(prompt);
  }

  const result = RepoAgentDescriptionSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  warnings.push({ filePath, message: "Invalid `description`; falling back to prompt excerpt" });
  return inferDescriptionFromPrompt(prompt);
}

function parseOptionalRole(
  raw: unknown,
  filePath: string,
  warnings: RepoAgentWarning[],
): RuntimeRoleId | null {
  if (raw === undefined) return null;
  const result = RoleId.safeParse(raw);
  if (result.success) return result.data;
  warnings.push({ filePath, message: "Invalid `role`; omitting runtime role metadata" });
  return null;
}

function parseOptionalReviewRole(
  raw: unknown,
  filePath: string,
  warnings: RepoAgentWarning[],
): CouncilSpecialization | null {
  if (raw === undefined) return null;
  const result = CouncilSpecializationId.safeParse(raw);
  if (result.success) return result.data;
  warnings.push({
    filePath,
    message: `Invalid \`reviewRole\`; expected one of ${COUNCIL_SPECIALIZATIONS.join(", ")}`,
  });
  return null;
}

function parseOptionalTags(
  raw: unknown,
  filePath: string,
  warnings: RepoAgentWarning[],
): string[] {
  if (raw === undefined) return [];
  if (typeof raw === "string") {
    const tag = TagSchema.safeParse(raw);
    if (tag.success) return [tag.data];
  }

  const result = TagsSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  warnings.push({ filePath, message: "Invalid `tags`; omitting tags metadata" });
  return [];
}

function inferDescriptionFromPrompt(prompt: string): string {
  const normalized = prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join(" ")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.slice(0, 240);
}

function summarizePrompt(prompt: string): string {
  return inferDescriptionFromPrompt(prompt).slice(0, 320);
}

function emptyReviewRoleMap(): Record<CouncilSpecialization, string[]> {
  return {
    architect: [],
    simplifier: [],
    security: [],
    performance: [],
    patterns: [],
  };
}

// v1 frontmatter intentionally supports only the manifest fields we need:
// scalar values and top-level string arrays.
function parseSimpleFrontmatter(source: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length;) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      index++;
      continue;
    }

    const match = rawLine.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) {
      return null;
    }

    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined) {
      return null;
    }
    const value = rawValue.trim();

    if (!value) {
      const listItems: string[] = [];
      index++;
      while (index < lines.length) {
        const listLine = lines[index] ?? "";
        const listTrimmed = listLine.trim();
        if (!listTrimmed || listTrimmed.startsWith("#")) {
          index++;
          continue;
        }

        const listMatch = listLine.match(/^\s*-\s+(.+)$/);
        if (listMatch) {
          listItems.push(parseScalar(listMatch[1]!));
          index++;
          continue;
        }

        if (/^\s+/.test(listLine)) {
          return null;
        }
        break;
      }

      result[key] = listItems;
      continue;
    }

    result[key] = parseValue(value);
    index++;
  }

  return result;
}

function parseValue(value: string): string | string[] {
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseScalar(part.trim()));
  }
  return parseScalar(value);
}

function parseScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}
