import { z } from "zod/v4";

export const GetCodePackInput = z.object({
  query: z.string().min(1).max(1000),
  scope: z.string().optional(), // module or path scope
  fields: z.array(z.string()).optional(),
  format: z.enum(["json", "ndjson"]).default("json"),
  expand: z.boolean().default(false), // request Stage B expansion
});
export type GetCodePackInput = z.infer<typeof GetCodePackInput>;

export const GetChangePackInput = z.object({
  sinceCommit: z.string().optional(),
  fields: z.array(z.string()).optional(),
  format: z.enum(["json", "ndjson"]).default("json"),
});
export type GetChangePackInput = z.infer<typeof GetChangePackInput>;

export const GetIssuePackInput = z.object({
  query: z.string().min(1).max(1000),
  fields: z.array(z.string()).optional(),
  format: z.enum(["json", "ndjson"]).default("json"),
});
export type GetIssuePackInput = z.infer<typeof GetIssuePackInput>;

export const SchemaInput = z.object({
  toolName: z.string().min(1),
});
export type SchemaInput = z.infer<typeof SchemaInput>;

export const ClaimFilesInput = z.object({
  paths: z.array(z.string().min(1)).min(1).max(50),
});
export type ClaimFilesInput = z.infer<typeof ClaimFilesInput>;
