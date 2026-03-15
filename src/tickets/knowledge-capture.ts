import { parseStringArrayJson } from "../core/input-hardening.js";
import * as tables from "../db/schema.js";
import type { NormalizedReviewVerdictRecord, ConsensusPayload } from "./consensus.js";

type TicketRow = typeof tables.tickets.$inferSelect;
type TicketHistoryRow = typeof tables.ticketHistory.$inferSelect;
type TicketCommentRow = typeof tables.ticketComments.$inferSelect;
type PatchRow = typeof tables.patches.$inferSelect;

const MAX_COMMENT_SNIPPETS = 5;
const MAX_HISTORY_ENTRIES = 8;
const MAX_PATCH_SUMMARIES = 5;
const MAX_AFFECTED_PATHS = 20;
const MAX_CONTENT_LENGTH = 15_000;
const MAX_TEXT_LENGTH = 320;
const MAX_VERDICT_REASONING_LENGTH = 200;
const MAX_DISSENT_REASONING_LENGTH = 300;

export interface TicketKnowledgeCaptureInput {
  ticket: TicketRow;
  targetStatus: "resolved" | "closed";
  transitionComment?: string | null;
  actorAgentId: string;
  actorSessionId: string;
  capturedAt: string;
  history: TicketHistoryRow[];
  comments: TicketCommentRow[];
  linkedPatches: PatchRow[];
  verdicts?: NormalizedReviewVerdictRecord[];
  consensus?: ConsensusPayload | null;
}

export function shouldCaptureTicketKnowledge(status: string): status is "resolved" | "closed" {
  return status === "resolved" || status === "closed";
}

export function buildTicketKnowledgeKey(ticketId: string): string {
  return `solution:ticket:${ticketId.toLowerCase()}`;
}

export function buildTicketResolutionKnowledgeEntry(
  input: TicketKnowledgeCaptureInput,
): typeof tables.knowledge.$inferInsert {
  const tags = uniqueStrings([
    ...parseStringArrayJson(input.ticket.tagsJson, { maxItems: 25, maxItemLength: 64 }),
    "ticket-resolution",
    ...buildVerdictTags(input.verdicts, input.consensus),
  ]).slice(0, 25);
  const affectedPaths = parseStringArrayJson(input.ticket.affectedPathsJson, {
    maxItems: MAX_AFFECTED_PATHS,
    maxItemLength: 500,
  });
  const finalHistoryEntry: TicketHistoryRow = {
    id: -1,
    ticketId: input.ticket.id,
    fromStatus: input.ticket.status,
    toStatus: input.targetStatus,
    agentId: input.actorAgentId,
    sessionId: input.actorSessionId,
    comment: input.transitionComment ?? null,
    timestamp: input.capturedAt,
  };
  const history = [...input.history, finalHistoryEntry].slice(-MAX_HISTORY_ENTRIES);
  const recentComments = input.comments.slice(-MAX_COMMENT_SNIPPETS);
  const linkedPatches = input.linkedPatches.slice(0, MAX_PATCH_SUMMARIES);

  const verdictSection = formatVerdictSection(input.verdicts ?? [], input.consensus ?? null);

  const content = [
    `Ticket: ${input.ticket.ticketId}`,
    `Title: ${input.ticket.title}`,
    `Final status: ${input.targetStatus}`,
    "",
    "Problem Summary",
    clipText(input.ticket.description, MAX_TEXT_LENGTH * 2),
    "",
    "Resolution Summary",
    `- Final transition: ${input.ticket.status} -> ${input.targetStatus}`,
    `- Triggered by: ${input.actorAgentId}`,
    `- Transition note: ${clipText(input.transitionComment ?? "None", MAX_TEXT_LENGTH)}`,
    ...buildCommentSummary(recentComments),
    ...buildPatchSummary(linkedPatches),
    "",
    "Affected Paths",
    ...renderList(affectedPaths, "No affected paths recorded"),
    "",
    "Tags",
    ...renderList(tags, "No tags recorded"),
    "",
    "Transition History",
    ...buildHistorySummary(history),
    ...(verdictSection ? ["", verdictSection] : []),
  ].join("\n");

  return {
    key: buildTicketKnowledgeKey(input.ticket.ticketId),
    type: "solution",
    scope: "repo",
    title: `Ticket ${input.ticket.ticketId}: ${input.ticket.title}`,
    content: clipText(content, MAX_CONTENT_LENGTH),
    tagsJson: JSON.stringify(tags),
    status: "active",
    agentId: input.actorAgentId,
    sessionId: input.actorSessionId,
    createdAt: input.capturedAt,
    updatedAt: input.capturedAt,
  };
}

export function formatVerdictSection(
  verdicts: NormalizedReviewVerdictRecord[],
  consensus: ConsensusPayload | null,
): string {
  if (verdicts.length === 0) return "";

  const lines: string[] = ["Council Review Summary"];

  if (consensus) {
    lines.push(`- Quorum: ${consensus.counts.pass}/${consensus.requiredPasses} required passes`);
    if (consensus.blockedByVeto) {
      lines.push(`- VETOED by: ${consensus.vetoes.map((v) => v.specialization).join(", ")}`);
    }
    if (consensus.missingSpecializations.length > 0) {
      lines.push(`- Missing specializations: ${consensus.missingSpecializations.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("Verdicts by Role");
  for (const v of verdicts) {
    const label = v.verdict === "pass" ? "PASS" : v.verdict === "fail" ? "FAIL" : "ABSTAIN";
    lines.push(`- ${v.specialization} [${label}]`);
    if (v.reasoning) {
      lines.push(`  > ${clipText(v.reasoning, MAX_VERDICT_REASONING_LENGTH)}`);
    }
  }

  const dissent = verdicts.filter((v) => v.verdict === "fail");
  if (dissent.length > 0) {
    lines.push("");
    lines.push("Dissenting Perspectives");
    for (const d of dissent) {
      lines.push(`- ${d.specialization}: ${clipText(d.reasoning ?? "No reasoning provided", MAX_DISSENT_REASONING_LENGTH)}`);
    }
  }

  return lines.join("\n");
}

function buildVerdictTags(
  verdicts?: NormalizedReviewVerdictRecord[],
  consensus?: ConsensusPayload | null,
): string[] {
  if (!verdicts?.length) return [];
  const tags: string[] = ["council-reviewed"];
  if (consensus?.blockedByVeto) tags.push("was-vetoed");
  for (const v of verdicts) {
    tags.push(`reviewed-by:${v.specialization}`);
  }
  return tags;
}

function buildCommentSummary(comments: TicketCommentRow[]): string[] {
  if (comments.length === 0) {
    return ["- Recent comments: none"];
  }
  return [
    "- Recent comments:",
    ...comments.map((comment) => `  - [${comment.agentId}] ${clipText(comment.content, MAX_TEXT_LENGTH)}`),
  ];
}

function buildPatchSummary(patches: PatchRow[]): string[] {
  if (patches.length === 0) {
    return ["- Linked patches: none"];
  }
  return [
    "- Linked patches:",
    ...patches.map((patch) => `  - ${patch.proposalId} [${patch.state}]: ${clipText(patch.message, MAX_TEXT_LENGTH)}`),
  ];
}

function buildHistorySummary(history: TicketHistoryRow[]): string[] {
  if (history.length === 0) {
    return ["- No recorded history"];
  }
  return history.map((entry) => {
    const comment = entry.comment ? ` - ${clipText(entry.comment, MAX_TEXT_LENGTH)}` : "";
    return `- ${entry.timestamp}: ${entry.fromStatus ?? "(created)"} -> ${entry.toStatus} by ${entry.agentId}${comment}`;
  });
}

function renderList(items: string[], emptyText: string): string[] {
  if (items.length === 0) return [`- ${emptyText}`];
  return items.map((item) => `- ${item}`);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
