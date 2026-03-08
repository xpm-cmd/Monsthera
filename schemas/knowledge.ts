import { z } from "zod/v4";

export const KnowledgeType = z.enum([
  "decision",
  "gotcha",
  "pattern",
  "context",
  "plan",
  "solution",
  "preference",
]);
export type KnowledgeType = z.infer<typeof KnowledgeType>;

export const KnowledgeScope = z.enum(["repo", "global"]);
export type KnowledgeScope = z.infer<typeof KnowledgeScope>;

export const KnowledgeStatus = z.enum(["active", "archived"]);
export type KnowledgeStatus = z.infer<typeof KnowledgeStatus>;

export const Knowledge = z.object({
  id: z.number(),
  key: z.string(),
  type: KnowledgeType,
  scope: KnowledgeScope,
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).default([]),
  status: KnowledgeStatus.default("active"),
  agentId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Knowledge = z.infer<typeof Knowledge>;
