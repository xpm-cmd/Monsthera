import { z } from "zod/v4";
import type { ContextPack } from "./service.js";

/**
 * Structured output contract for the `think` synthesis LLM call. The model
 * returns prose with inline `[n]` markers plus an explicit gap list; citations
 * are extracted + validated from the prose (not trusted from the model), so
 * the schema stays minimal.
 */
export const ThinkLlmOutputSchema = z.object({
  answer: z.string().min(1),
  gaps: z
    .array(
      z.object({
        kind: z.enum(["stale", "uncited", "contradictory", "missing"]),
        detail: z.string().min(1),
        sourceMarkers: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export type ThinkLlmOutput = z.infer<typeof ThinkLlmOutputSchema>;

/** A resolved citation: an inline `[n]` marker mapped to a real article. */
export interface ThinkCitation {
  readonly marker: string;
  readonly articleId: string;
  readonly type: "knowledge" | "work";
  readonly title: string;
  readonly snippet: string;
}

/** A hole in what the brain knows, surfaced alongside the answer. */
export interface KnowledgeGap {
  readonly kind: "stale" | "uncited" | "contradictory" | "missing";
  readonly detail: string;
  readonly articleIds: readonly string[];
}

/**
 * The synthesized answer. Composes the underlying `ContextPack` (verbatim) so
 * the MCP/CLI surface can reuse its serialization and the caller still has the
 * ranked sources. `degraded` is true when no LLM produced the prose.
 */
export interface ThinkResult {
  readonly generatedAt: string;
  readonly query: string;
  readonly mode: "general" | "code" | "research";
  readonly answer: string;
  readonly degraded: boolean;
  readonly citations: readonly ThinkCitation[];
  readonly gaps: readonly KnowledgeGap[];
  readonly contextPack: ContextPack;
}
