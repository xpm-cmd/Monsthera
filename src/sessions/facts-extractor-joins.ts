import type { PhaseHistoryEntry, WorkArticle, WorkArticleRepository } from "../work/repository.js";
import type { OrchestrationEvent } from "../orchestration/repository.js";
import type { AgentId, WorkPhase } from "../core/types.js";
import type { SessionFactsWorkTouched } from "./schemas.js";

/**
 * Pure join helpers that turn in-window events + repo lookups into the
 * Hypergraph-ready entries `DefaultFactsExtractor` emits.
 *
 * No filesystem, no git, no LLM — these functions operate on already-loaded
 * data so tests can exercise them with hand-built in-memory inputs.
 */

/**
 * Resolve which phase a work article was in at the given timestamp.
 * Returns the matching entry's phase when `enteredAt <= ts < exitedAt` (or
 * `enteredAt <= ts` for the still-open current entry). When `ts` predates the
 * first entry, falls back to the most recent (current) phase so the
 * Hypergraph never carries a literal "unknown" — agents reading the article
 * should still get a useful label.
 */
export function phaseAt(
  history: readonly PhaseHistoryEntry[],
  timestamp: string,
): WorkPhase {
  for (const entry of history) {
    const opened = timestamp >= entry.enteredAt;
    const stillIn = entry.exitedAt === undefined || timestamp < entry.exitedAt;
    if (opened && stillIn) return entry.phase;
  }
  return history[history.length - 1]!.phase;
}

export type WorkTouchedRole = "lead" | "assignee" | "reviewer" | "enrichment";

/**
 * Classify which seat the agent occupied on a work article. Precedence is
 * authority-first (lead > assignee > reviewer > enrichment) — when an agent
 * holds multiple seats, the one with most ownership wins. An agent who
 * touched the article without any formal assignment is reported as
 * `"enrichment"`, matching how ad-hoc contributions are tracked elsewhere.
 */
export function roleOf(work: WorkArticle, agentId: AgentId): WorkTouchedRole {
  if (work.lead === agentId) return "lead";
  if (work.assignee === agentId) return "assignee";
  if (work.reviewers.some((r) => r.agentId === agentId)) return "reviewer";
  return "enrichment";
}

export interface JoinWorkTouchedOptions {
  readonly events: readonly OrchestrationEvent[];
  readonly workRepo: WorkArticleRepository;
  readonly agentId: AgentId;
  readonly openedAt: string;
  readonly closedAt: string;
}

/**
 * Walk the in-window events, dedup by `workId`, hydrate each via the work
 * repo, and emit one `SessionFactsWorkTouched` per article. Not-found or
 * errored hydrations are skipped silently so a stale event reference cannot
 * abort the whole pipeline.
 */
export async function joinWorkTouched(
  options: JoinWorkTouchedOptions,
): Promise<SessionFactsWorkTouched[]> {
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const event of options.events) {
    const id = event.workId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }

  const touched: SessionFactsWorkTouched[] = [];
  for (const id of uniqueIds) {
    const found = await options.workRepo.findById(id);
    if (!found.ok) continue;
    const work = found.value;
    touched.push({
      id: work.id,
      title: work.title,
      phaseAtOpen: phaseAt(work.phaseHistory, options.openedAt),
      phaseAtClose: phaseAt(work.phaseHistory, options.closedAt),
      role: roleOf(work, options.agentId),
    });
  }
  return touched;
}
