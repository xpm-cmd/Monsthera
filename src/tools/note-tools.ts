import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { createHash } from "node:crypto";
import type { MonstheraContext } from "../core/context.js";
import {
  AgentIdSchema,
  FlatMetadataSchema,
  LinkedPathsSchema,
  SessionIdSchema,
} from "../core/input-hardening.js";
import { checkToolAccess, canReadNoteType, canWriteNoteType } from "../trust/tiers.js";
import * as queries from "../db/queries.js";
import { getHead } from "../git/operations.js";
import { resolveAgent } from "./resolve-agent.js";
import { recordDashboardEvent } from "../core/events.js";

type GetContext = () => Promise<MonstheraContext>;

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
      linkedPaths: LinkedPathsSchema.default([]).describe("Related file paths"),
      metadata: FlatMetadataSchema.default({}).describe("Optional metadata"),
      agentId: AgentIdSchema.describe("Proposing agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ type, content, linkedPaths, metadata, agentId, sessionId }) => {
      const c = await getContext();

      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

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
        recordDashboardEvent(c.db, c.repoId, {
          type: "note_added",
          data: { key, noteType: type, action: "updated", agentId },
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ action: "updated", key, type, commitSha: currentHead }),
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
      recordDashboardEvent(c.db, c.repoId, {
        type: "note_added",
        data: { key, noteType: type, action: "created", noteId: note.id, agentId },
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "created", key, type, noteId: note.id, commitSha: currentHead,
          }),
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
      limit: z.number().int().min(1).max(100).default(20).describe("Max notes to return"),
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ type, limit: rawLimit, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

      const access = checkToolAccess("list_notes", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      if (type && !canReadNoteType(resolved.role, type)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              denied: true,
              reason: `Role ${resolved.role} cannot read notes of type ${type}`,
            }),
          }],
          isError: true,
        };
      }

      const limit = rawLimit ?? 20;
      const allNotes = queries
        .getNotesByRepo(c.db, c.repoId, type)
        .filter((note) => canReadNoteType(resolved.role, note.type));

      const hasMore = allNotes.length > limit;
      const notes = hasMore ? allNotes.slice(0, limit) : allNotes;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: notes.length,
            hasMore,
            notes: notes.map((n) => ({
              key: n.key, type: n.type,
              content: n.content.slice(0, 200) + (n.content.length > 200 ? "..." : ""),
              agentId: n.agentId, commitSha: n.commitSha, updatedAt: n.updatedAt,
            })),
          }),
        }],
      };
    },
  );
}
