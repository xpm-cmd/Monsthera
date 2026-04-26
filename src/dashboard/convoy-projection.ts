import type { Result } from "../core/result.js";
import type { AgentId, ConvoyId, Timestamp, WorkId, WorkPhase } from "../core/types.js";
import type { NotFoundError, StorageError } from "../core/errors.js";
import type { ConvoyRepository } from "../orchestration/convoy-repository.js";
import type { OrchestrationEventRepository, OrchestrationEvent } from "../orchestration/repository.js";
import type { Convoy, ConvoyStatus, ConvoyLeadCancelledWarningEventDetails } from "../orchestration/types.js";
import type { WorkService } from "../work/service.js";

export interface MemberSummary {
  readonly id: WorkId;
  readonly title: string;
  readonly phase: WorkPhase;
}

export interface DeletedRef {
  readonly id: WorkId;
  readonly deleted: true;
}

export type ResolvedRef = MemberSummary | DeletedRef;

export interface EnrichedConvoy {
  readonly id: ConvoyId;
  readonly leadWorkId: WorkId;
  readonly memberWorkIds: readonly WorkId[];
  readonly goal: string;
  readonly targetPhase: WorkPhase;
  readonly status: ConvoyStatus;
  readonly createdAt: Timestamp;
  readonly completedAt?: Timestamp;
  readonly lead: ResolvedRef;
  readonly members: readonly ResolvedRef[];
  readonly hasUnresolvedWarning: boolean;
}

export interface UnresolvedWarning {
  readonly convoyId: ConvoyId;
  readonly leadWorkId: WorkId;
  readonly memberWorkIds: readonly WorkId[];
  readonly reason: string;
  readonly createdAt: Timestamp;
  readonly leadTitle: string;
  readonly activeMemberCount: number;
}

export interface ConvoyDashboardSummary {
  readonly active: readonly EnrichedConvoy[];
  readonly terminal: readonly EnrichedConvoy[];
  readonly warnings: readonly UnresolvedWarning[];
}

export interface ConvoyGuardState {
  readonly name: "convoy_lead_ready";
  readonly passing: boolean;
  readonly leadPhase: WorkPhase;
  readonly targetPhase: WorkPhase;
}

export interface ConvoyLifecycleEntry {
  readonly eventType:
    | "convoy_created"
    | "convoy_completed"
    | "convoy_cancelled"
    | "convoy_lead_cancelled_warning";
  readonly createdAt: Timestamp;
  readonly actor?: AgentId;
  readonly terminationReason?: string;
  readonly warningReason?: string;
  readonly goal?: string;
}

export interface RecentLeadActivity {
  readonly eventType: "phase_advanced";
  readonly from: WorkPhase;
  readonly to: WorkPhase;
  readonly createdAt: Timestamp;
}

export interface ConvoyDetailWarning {
  readonly reason: string;
  readonly createdAt: Timestamp;
  readonly activeMemberCount: number;
}

export interface ConvoyDetailProjection extends EnrichedConvoy {
  readonly guard: ConvoyGuardState | null;
  readonly recentLeadActivity: readonly RecentLeadActivity[];
  readonly lifecycle: readonly ConvoyLifecycleEntry[];
  readonly warning: ConvoyDetailWarning | null;
}

export interface ConvoyProjectionDeps {
  readonly convoyRepo: ConvoyRepository;
  readonly orchestrationRepo: OrchestrationEventRepository;
  readonly workService: Pick<WorkService, "getWork">;
  readonly now?: () => Date;
}

const TERMINAL_PHASE = new Set<WorkPhase>(["done", "cancelled"]);
const TERMINAL_LIMIT = 20;
const TERMINAL_SCAN_WINDOW = 50;
const RECENT_LEAD_ACTIVITY_LIMIT = 5;

const PHASE_ORDER: readonly WorkPhase[] = ["planning", "enrichment", "implementation", "review", "done"] as const;

function phaseGte(actual: WorkPhase, target: WorkPhase): boolean {
  const a = PHASE_ORDER.indexOf(actual);
  const t = PHASE_ORDER.indexOf(target);
  return a >= 0 && t >= 0 && a >= t;
}

async function resolveRef(
  id: WorkId,
  deps: ConvoyProjectionDeps,
): Promise<ResolvedRef> {
  const result = await deps.workService.getWork(id);
  if (!result.ok) return { id, deleted: true };
  return { id, title: result.value.title, phase: result.value.phase };
}

async function enrichConvoy(
  convoy: Convoy,
  deps: ConvoyProjectionDeps,
  hasUnresolvedWarning: boolean,
): Promise<EnrichedConvoy> {
  const lead = await resolveRef(convoy.leadWorkId, deps);
  const members = await Promise.all(
    convoy.memberWorkIds.map((id) => resolveRef(id, deps)),
  );
  return {
    id: convoy.id,
    leadWorkId: convoy.leadWorkId,
    memberWorkIds: convoy.memberWorkIds,
    goal: convoy.goal,
    targetPhase: convoy.targetPhase,
    status: convoy.status,
    createdAt: convoy.createdAt,
    completedAt: convoy.completedAt,
    lead,
    members,
    hasUnresolvedWarning,
  };
}

async function computeUnresolvedWarnings(
  events: readonly OrchestrationEvent[],
  deps: ConvoyProjectionDeps,
): Promise<UnresolvedWarning[]> {
  const out: UnresolvedWarning[] = [];
  for (const event of events) {
    const d = event.details as unknown as ConvoyLeadCancelledWarningEventDetails;
    const convoyResult = await deps.convoyRepo.findById(d.convoyId);
    if (!convoyResult.ok || convoyResult.value.status !== "active") continue;
    const members = await Promise.all(
      d.memberWorkIds.map((id) => deps.workService.getWork(id)),
    );
    const activeCount = members.filter(
      (m) => m.ok && !TERMINAL_PHASE.has(m.value.phase),
    ).length;
    if (activeCount === 0) continue;
    const leadResult = await deps.workService.getWork(d.leadWorkId);
    out.push({
      convoyId: d.convoyId,
      leadWorkId: d.leadWorkId,
      memberWorkIds: d.memberWorkIds,
      reason: d.reason,
      createdAt: event.createdAt,
      leadTitle: leadResult.ok ? leadResult.value.title : "(deleted)",
      activeMemberCount: activeCount,
    });
  }
  return out;
}

async function loadRecentTerminal(
  createdEvents: readonly OrchestrationEvent[],
  activeIds: ReadonlySet<ConvoyId>,
  deps: ConvoyProjectionDeps,
): Promise<EnrichedConvoy[]> {
  const recent = [...createdEvents]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, TERMINAL_SCAN_WINDOW);
  const out: EnrichedConvoy[] = [];
  for (const event of recent) {
    const convoyId = (event.details as { convoyId: ConvoyId }).convoyId;
    if (activeIds.has(convoyId)) continue;
    const r = await deps.convoyRepo.findById(convoyId);
    if (!r.ok || r.value.status === "active") continue;
    out.push(await enrichConvoy(r.value, deps, false));
    if (out.length >= TERMINAL_LIMIT) break;
  }
  return out;
}

async function deriveDetailWarning(
  warningEvents: readonly OrchestrationEvent[],
  convoy: Convoy,
  deps: ConvoyProjectionDeps,
): Promise<ConvoyDetailWarning | null> {
  if (convoy.status !== "active" || warningEvents.length === 0) return null;
  const newest = [...warningEvents].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0]!;
  const d = newest.details as unknown as ConvoyLeadCancelledWarningEventDetails;
  const members = await Promise.all(
    d.memberWorkIds.map((id) => deps.workService.getWork(id)),
  );
  const activeCount = members.filter(
    (m) => m.ok && !TERMINAL_PHASE.has(m.value.phase),
  ).length;
  if (activeCount === 0) return null;
  return { reason: d.reason, createdAt: newest.createdAt, activeMemberCount: activeCount };
}

function buildLifecycle(
  convoyId: ConvoyId,
  created: readonly OrchestrationEvent[],
  completed: readonly OrchestrationEvent[],
  cancelled: readonly OrchestrationEvent[],
  warnings: readonly OrchestrationEvent[],
): ConvoyLifecycleEntry[] {
  const out: ConvoyLifecycleEntry[] = [];
  for (const e of created) {
    const d = e.details as { convoyId: ConvoyId; actor?: AgentId; goal: string };
    if (d.convoyId !== convoyId) continue;
    out.push({ eventType: "convoy_created", createdAt: e.createdAt, actor: d.actor, goal: d.goal });
  }
  for (const e of completed) {
    const d = e.details as { convoyId: ConvoyId; actor?: AgentId; terminationReason?: string };
    if (d.convoyId !== convoyId) continue;
    out.push({ eventType: "convoy_completed", createdAt: e.createdAt, actor: d.actor, terminationReason: d.terminationReason });
  }
  for (const e of cancelled) {
    const d = e.details as { convoyId: ConvoyId; actor?: AgentId; terminationReason?: string };
    if (d.convoyId !== convoyId) continue;
    out.push({ eventType: "convoy_cancelled", createdAt: e.createdAt, actor: d.actor, terminationReason: d.terminationReason });
  }
  for (const e of warnings) {
    const d = e.details as { reason: string };
    out.push({ eventType: "convoy_lead_cancelled_warning", createdAt: e.createdAt, warningReason: d.reason });
  }
  return out.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export async function buildConvoyDashboardSummary(
  deps: ConvoyProjectionDeps,
): Promise<Result<ConvoyDashboardSummary, StorageError>> {
  const [activeResult, warningsResult, createdResult] = await Promise.all([
    deps.convoyRepo.findActive(),
    deps.orchestrationRepo.findByType("convoy_lead_cancelled_warning"),
    deps.orchestrationRepo.findByType("convoy_created"),
  ]);
  if (!activeResult.ok) return activeResult;
  if (!warningsResult.ok) return warningsResult;
  if (!createdResult.ok) return createdResult;

  const warnings = await computeUnresolvedWarnings(warningsResult.value, deps);
  const warningConvoyIds = new Set(warnings.map((w) => w.convoyId));

  const active = await Promise.all(
    activeResult.value.map((convoy) =>
      enrichConvoy(convoy, deps, warningConvoyIds.has(convoy.id)),
    ),
  );
  const activeIds = new Set(active.map((c) => c.id));

  const terminal = await loadRecentTerminal(createdResult.value, activeIds, deps);

  return { ok: true, value: { active, terminal, warnings } };
}

export async function buildConvoyDetail(
  id: ConvoyId,
  deps: ConvoyProjectionDeps,
): Promise<Result<ConvoyDetailProjection, NotFoundError | StorageError>> {
  const convoyResult = await deps.convoyRepo.findById(id);
  if (!convoyResult.ok) return convoyResult;
  const convoy = convoyResult.value;

  const [warningsR, createdR, completedR, cancelledR, leadEventsR] = await Promise.all([
    deps.orchestrationRepo.findByType("convoy_lead_cancelled_warning"),
    deps.orchestrationRepo.findByType("convoy_created"),
    deps.orchestrationRepo.findByType("convoy_completed"),
    deps.orchestrationRepo.findByType("convoy_cancelled"),
    deps.orchestrationRepo.findByWorkId(convoy.leadWorkId),
  ]);
  for (const r of [warningsR, createdR, completedR, cancelledR, leadEventsR]) {
    if (!r.ok) return r;
  }

  const matchingWarnings = (warningsR.ok ? warningsR.value : []).filter(
    (e) => (e.details as { convoyId: ConvoyId }).convoyId === id,
  );
  const warning = await deriveDetailWarning(matchingWarnings, convoy, deps);
  const lifecycle = buildLifecycle(
    id,
    createdR.ok ? createdR.value : [],
    completedR.ok ? completedR.value : [],
    cancelledR.ok ? cancelledR.value : [],
    matchingWarnings,
  );
  const recentLeadActivity = (leadEventsR.ok ? leadEventsR.value : [])
    .filter((e) => e.eventType === "phase_advanced")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, RECENT_LEAD_ACTIVITY_LIMIT)
    .map((e) => {
      const d = e.details as { from: WorkPhase; to: WorkPhase };
      return { eventType: "phase_advanced" as const, from: d.from, to: d.to, createdAt: e.createdAt };
    });

  const enriched = await enrichConvoy(convoy, deps, warning !== null);
  const guard: ConvoyGuardState | null =
    convoy.status === "active"
      ? {
          name: "convoy_lead_ready",
          passing:
            "phase" in enriched.lead
              ? phaseGte(enriched.lead.phase, convoy.targetPhase)
              : false,
          leadPhase:
            "phase" in enriched.lead
              ? enriched.lead.phase
              : ("planning" as WorkPhase),
          targetPhase: convoy.targetPhase,
        }
      : null;

  return { ok: true, value: { ...enriched, guard, recentLeadActivity, lifecycle, warning } };
}
