import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { DEFAULT_MONSTHERA_DIR } from "../core/constants.js";
import { MAX_TICKET_LONG_TEXT_LENGTH } from "../core/input-hardening.js";

export const TicketTemplateSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  priority: z.number().int().min(0).max(10).default(5),
  tags: z.array(z.string()).default([]),
  affectedPaths: z.array(z.string()).default([]),
  acceptanceCriteria: z.string().max(MAX_TICKET_LONG_TEXT_LENGTH).default(""),
});

const TicketTemplateFileSchema = z.object({
  templates: z.array(TicketTemplateSchema).default([]),
});

export type TicketTemplate = z.infer<typeof TicketTemplateSchema>;

export interface TicketTemplatesResult {
  path: string;
  exists: boolean;
  templates: TicketTemplate[];
  error?: string;
}

export function getTicketTemplatesPath(repoPath: string, monstheraDir = DEFAULT_MONSTHERA_DIR): string {
  return join(repoPath, monstheraDir, "ticket-templates.json");
}

export function loadTicketTemplates(repoPath: string, monstheraDir = DEFAULT_MONSTHERA_DIR): TicketTemplatesResult {
  const path = getTicketTemplatesPath(repoPath, monstheraDir);
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      templates: [],
    };
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const parsed = Array.isArray(raw)
      ? TicketTemplateFileSchema.parse({ templates: raw })
      : TicketTemplateFileSchema.parse(raw);

    return {
      path,
      exists: true,
      templates: parsed.templates,
    };
  } catch (error) {
    return {
      path,
      exists: true,
      templates: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
