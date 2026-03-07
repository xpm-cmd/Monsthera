import { z } from "zod/v4";

export const NoteType = z.enum([
  "issue",
  "decision",
  "change_note",
  "gotcha",
  "runbook",
  "repo_map",
  "module_map",
  "file_summary",
]);
export type NoteType = z.infer<typeof NoteType>;

export const Note = z.object({
  id: z.string(),
  repoId: z.string(),
  type: NoteType,
  key: z.string(), // deterministic: {type}:{repo}:{path_or_topic}:{content_hash_prefix}
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  linkedPaths: z.array(z.string()).default([]), // file/module paths this note relates to
  commitSha: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Note = z.infer<typeof Note>;

export const ProposeNoteInput = z.object({
  type: NoteType,
  content: z.string().min(1).max(10_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
  linkedPaths: z.array(z.string()).default([]),
});
export type ProposeNoteInput = z.infer<typeof ProposeNoteInput>;
