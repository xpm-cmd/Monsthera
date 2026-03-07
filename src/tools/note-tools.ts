import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { createHash } from "node:crypto";
import type { AgoraContext } from "../core/context.js";
import { checkToolAccess, canWriteNoteType } from "../trust/tiers.js";
import * as queries from "../db/queries.js";
import { getHead } from "../git/operations.js";
import { resolveAgent } from "./resolve-agent.js";

type GetContext = () => Promise<AgoraContext>;

const NOTE_TYPES = [
  "issue", "decision", "change_note", "gotcha",
  "runbook", "repo_map", "module_map", "file_summary",
] as const;

export function registerNoteTools(server: McpServer, getContext: GetContext): void {
  // ─── propose_note ───────────────────────────────────────────
  server.tool(
    "propose_note",
    "Create or update a note (idempotent via deterministic key)",
    {
      type: z.enum(NOTE_TYPES).describe("Note type"),
      content: z.string().min(1).max(10_000).describe("Note content"),
      linkedPaths: z.array(z.string()).default([]).describe("Related file paths"),
      metadata: z.record(z.string(), z.unknown()).default({}).describe("Optional metadata"),
      agentId: z.string().describe("Proposing agent ID"),
      sessionId: z.string().describe("Active session ID"),
    },
    async ({ type, content, linkedPaths, metadata, agentId, sessionId }) => {
      const c = await getContext();

      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved) {
        return {
          content: [{ type: "text" as const, text: "Agent or session not found / inactive" }],
          isError: true,
        };
      }

      const access = checkToolAccess("propose_note", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        c.insight.warn(`propose_note denied for ${agentId}: ${access.reason}`);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      if (!canWriteNoteType(resolved.role, type)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              denied: true,
              reason: `Role ${resolved.role} cannot create notes of type ${type}`,
            }),
          }],
          isError: true,
        };
      }

      const currentHead = await getHead({ cwd: c.repoPath });
      const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 12);
      const key = `${type}:${contentHash}`;

      const existing = queries.getNoteByKey(c.db, key);
      const now = new Date().toISOString();

      if (existing) {
        queries.updateNote(c.db, key, content);
        c.insight.info(`Note updated: ${key} by ${agentId}`);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ action: "updated", key, type, commitSha: currentHead }, null, 2),
          }],
        };
      }

      const note = queries.insertNote(c.db, {
        repoId: c.repoId,
        type, key, content,
        metadataJson: JSON.stringify(metadata),
        linkedPathsJson: JSON.stringify(linkedPaths),
        agentId, sessionId,
        commitSha: currentHead,
        createdAt: now, updatedAt: now,
      });

      c.insight.info(`Note created: ${key} by ${agentId}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "created", key, type, noteId: note.id, commitSha: currentHead,
          }, null, 2),
        }],
      };
    },
  );

  // ─── list_notes ────────────────────────────────────────────
  server.tool(
    "list_notes",
    "List notes, optionally filtered by type",
    {
      type: z.enum(NOTE_TYPES).optional().describe("Filter by note type"),
    },
    async ({ type }) => {
      const c = await getContext();
      const notes = queries.getNotesByRepo(c.db, c.repoId, type);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: notes.length,
            notes: notes.map((n) => ({
              key: n.key, type: n.type,
              content: n.content.slice(0, 200) + (n.content.length > 200 ? "..." : ""),
              agentId: n.agentId, commitSha: n.commitSha, updatedAt: n.updatedAt,
            })),
          }, null, 2),
        }],
      };
    },
  );
}
