import * as queries from "../db/queries.js";
import { recordDashboardEvent } from "../core/events.js";
import { parseStringArrayJson } from "../core/input-hardening.js";
import {
  createTicketRecord,
  linkTicketsRecord,
  commentTicketRecord,
  type TicketSystemContext,
} from "./service.js";

export interface RepairBlockerSource {
  type: "council_veto" | "lifecycle_suppression";
  parentTicketId: string;
  parentTicketTitle: string;
  reason: string;
  sourceSpecializations?: string[];
  affectedPaths: string[];
  severity: string;
}

export interface RepairSpawnResult {
  spawned: boolean;
  ticketId?: string;
  reason: string;
}

export interface RepairSpawnerConfig {
  enabled: boolean;
  allowedSources: Array<"council_veto" | "lifecycle_suppression">;
}

const TERMINAL_STATUSES = new Set(["resolved", "closed", "wont_fix"]);

export async function spawnRepairTicket(
  ctx: TicketSystemContext,
  source: RepairBlockerSource,
  config: RepairSpawnerConfig,
): Promise<RepairSpawnResult> {
  if (!config.enabled) return { spawned: false, reason: "config_disabled" };
  if (!config.allowedSources.includes(source.type)) return { spawned: false, reason: "source_not_allowed" };

  const parent = queries.getTicketByTicketId(ctx.db, source.parentTicketId, ctx.repoId);
  if (!parent) return { spawned: false, reason: "parent_not_found" };

  // Dedupe: skip if an open repair ticket of the same type already exists
  const deps = queries.getTicketDependencies(ctx.db, parent.id);
  const linkedIds = [
    ...deps.outgoing.map((d) => d.toTicketId),
    ...deps.incoming.map((d) => d.fromTicketId),
  ];
  for (const linkedId of linkedIds) {
    const linked = queries.getTicketById(ctx.db, linkedId);
    if (!linked) continue;
    const tags: string[] = parseStringArrayJson(linked.tagsJson, { maxItems: 50, maxItemLength: 200 });
    if (!tags.includes(`repair:${source.type}`)) continue;
    if (!TERMINAL_STATUSES.has(linked.status)) {
      return { spawned: false, reason: "dedupe_skipped" };
    }
  }

  const title = source.type === "council_veto"
    ? `Repair: address ${source.sourceSpecializations?.join(", ") ?? "council"} veto on ${source.parentTicketId}`
    : `Repair: lifecycle suppression on ${source.parentTicketId}`;

  const result = await createTicketRecord(
    { ...ctx, system: true, actorLabel: `repair:${source.type}` },
    {
      title,
      description: `Parent: ${source.parentTicketId} (${source.parentTicketTitle})\n\nBlocker: ${source.reason}`,
      severity: source.severity,
      priority: 10,
      tags: [`repair:${source.type}`, `parent:${source.parentTicketId}`],
      affectedPaths: source.affectedPaths,
      agentId: "system",
      sessionId: "system",
    },
  );

  if (!result.ok) return { spawned: false, reason: `create_failed: ${result.message}` };
  const repairTicketId = (result.data as Record<string, unknown>).ticketId as string;

  // Link: repair relates_to parent
  linkTicketsRecord(
    { ...ctx, system: true, actorLabel: `repair:${source.type}` },
    {
      fromTicketId: source.parentTicketId,
      toTicketId: repairTicketId,
      relationType: "relates_to",
      agentId: "system",
      sessionId: "system",
    },
  );

  // Audit comment on parent
  commentTicketRecord(
    { ...ctx, system: true, actorLabel: `repair:${source.type}` },
    {
      ticketId: source.parentTicketId,
      content: `[Auto-Repair] ${title}\nSpawned follow-up ticket ${repairTicketId} to address blocker.\nSource: ${source.type}`,
      agentId: "system",
      sessionId: "system",
    },
  );

  recordDashboardEvent(ctx.db, ctx.repoId, {
    type: "ticket_repair_spawned",
    data: { parentTicketId: source.parentTicketId, repairTicketId, source: source.type },
  });

  return { spawned: true, ticketId: repairTicketId, reason: "created" };
}
