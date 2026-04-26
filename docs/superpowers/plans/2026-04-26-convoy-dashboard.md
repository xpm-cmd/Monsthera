# Convoy Dashboard (S4 v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the convoy dashboard surface — `/convoys` panel, `/convoys/:id` detail, sidebar warning badge, and lifecycle ribbon on the lead's work card — read-only, no new repo methods, in five logical commits.

**Architecture:** New `src/dashboard/convoy-projection.ts` module composes existing repo methods (`convoyRepo.findActive/findById`, `orchestrationRepo.findByType`, `workService.getWork`) into four projections consumed by two thin HTTP handlers (`GET /api/convoys`, `GET /api/convoys/:id`). Frontend adds two new SPA pages, modifies sidebar/overview/work to wire badge + stat card + ribbon, and centralizes phase color in a `renderPhaseChip` helper.

**Tech Stack:** TypeScript + Node `http` (backend), vanilla ES modules (frontend), vitest (tests). All within the existing monsthera repo. Branch: `feat/convoy-dashboard` (already created).

**Spec:** [docs/superpowers/specs/2026-04-26-convoy-dashboard-design.md](../specs/2026-04-26-convoy-dashboard-design.md)

---

## File Structure

**Created:**
- `src/dashboard/convoy-projection.ts` — pure functions, dep-injected
- `tests/unit/dashboard/convoy-projection.test.ts` — projection unit tests
- `tests/integration/convoy-dashboard.test.ts` — end-to-end via dashboard
- `public/pages/convoys.js` — list page (`/convoys`)
- `public/pages/convoy.js` — detail page (`/convoys/:id`)
- `docs/adrs/014-convoy-dashboard.md` — formal decision record
- `knowledge/notes/convoy-dashboard-design-decisions.md` — informal trade-offs

**Modified:**
- `src/dashboard/index.ts` — add 2 route handlers near existing patterns (~line 274 for matchers, append handler blocks before the static-file fallback)
- `public/lib/api.js` — add `getConvoys()`, `getConvoyById(id)`
- `public/lib/components.js` — add `renderPhaseChip(phase)` helper
- `public/lib/sidebar.js` — add Convoys nav item + async badge refresh
- `public/app.js` — register `/convoys` and `/convoys/:id` routes
- `public/pages/overview.js` — add convoy stat card to right column
- `public/pages/work.js` — render lifecycle ribbon strip in expanded card

---

## Commit Cadence

| # | Commit message | Tasks |
|---|---|---|
| 1 | `feat(dashboard): convoy projection module + GET /api/convoys endpoints` | 1.1–1.8 |
| 2 | `feat(dashboard): convoy panel + per-convoy view UI + overview card` | 2.1–2.6 |
| 3 | `feat(dashboard): unresolved-warning badge in sidebar nav` | 3.1–3.2 |
| 4 | `feat(dashboard): lifecycle ribbon on work-article cards` | 4.1–4.2 |
| 5 | `docs: ADR-014 + convoy-dashboard-design-decisions knowledge note` | 5.1–5.2 |

Then: open PR, wait for CI, verify merge.

---

# Commit 1 — Backend convoy projection + endpoints

### Task 1.1: Create the projection module skeleton with type exports

**Files:**
- Create: `src/dashboard/convoy-projection.ts`

- [ ] **Step 1: Create the file with type exports only**

```ts
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
```

And continue the file with the remaining types + stubs:

```ts
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

export async function buildConvoyDashboardSummary(
  _deps: ConvoyProjectionDeps,
): Promise<Result<ConvoyDashboardSummary, StorageError>> {
  throw new Error("not implemented");
}

export async function buildConvoyDetail(
  _id: ConvoyId,
  _deps: ConvoyProjectionDeps,
): Promise<Result<ConvoyDetailProjection, NotFoundError | StorageError>> {
  throw new Error("not implemented");
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no errors. (Unused-variable errors should be silenced by the underscore prefix.)

---

### Task 1.2: Test + implement `buildConvoyDashboardSummary` for active convoys

**Files:**
- Create: `tests/unit/dashboard/convoy-projection.test.ts`
- Modify: `src/dashboard/convoy-projection.ts`

- [ ] **Step 1: Write the failing test for active-convoy enrichment**

Create `tests/unit/dashboard/convoy-projection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTestContainer } from "../../../src/core/container.js";
import { workId } from "../../../src/core/types.js";
import {
  buildConvoyDashboardSummary,
  type ConvoyProjectionDeps,
} from "../../../src/dashboard/convoy-projection.js";

async function setupContainer() {
  const container = await createTestContainer();
  const deps: ConvoyProjectionDeps = {
    convoyRepo: container.convoyRepo,
    orchestrationRepo: container.orchestrationRepo,
    workService: container.workService,
    now: () => new Date("2026-04-26T10:00:00Z"),
  };
  return { container, deps };
}

async function createWork(container: Awaited<ReturnType<typeof createTestContainer>>, title: string) {
  const result = await container.workService.createWork({
    title,
    template: "feature",
    priority: "medium",
    author: "agent-test",
    content: "## Objective\nx\n\n## Acceptance Criteria\n- ok",
  });
  if (!result.ok) throw new Error(`createWork ${title} failed: ${result.error.message}`);
  return result.value;
}

describe("buildConvoyDashboardSummary — active convoys", () => {
  it("returns active convoys with lead + members enriched", async () => {
    const { container, deps } = await setupContainer();
    try {
      const lead = await createWork(container, "lead article");
      const memberA = await createWork(container, "member a");
      const memberB = await createWork(container, "member b");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.id),
        memberWorkIds: [workId(memberA.id), workId(memberB.id)],
        goal: "ship X",
      });
      if (!convoy.ok) throw new Error("convoy create failed");

      const summary = await buildConvoyDashboardSummary(deps);
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.value.active).toHaveLength(1);
      const enriched = summary.value.active[0]!;
      expect(enriched.id).toBe(convoy.value.id);
      expect(enriched.goal).toBe("ship X");
      expect(enriched.lead).toMatchObject({ id: workId(lead.id), title: "lead article" });
      expect(enriched.members).toHaveLength(2);
      expect(enriched.hasUnresolvedWarning).toBe(false);
    } finally {
      await container.dispose();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/dashboard/convoy-projection.test.ts`
Expected: FAIL with "not implemented"

- [ ] **Step 3: Implement `buildConvoyDashboardSummary` for active convoys (no warnings, no terminal yet)**

Replace the stub `buildConvoyDashboardSummary` body in `src/dashboard/convoy-projection.ts` with:

```ts
export async function buildConvoyDashboardSummary(
  deps: ConvoyProjectionDeps,
): Promise<Result<ConvoyDashboardSummary, StorageError>> {
  const activeResult = await deps.convoyRepo.findActive();
  if (!activeResult.ok) return activeResult;

  const active = await Promise.all(
    activeResult.value.map((convoy) => enrichConvoy(convoy, deps, false)),
  );

  return {
    ok: true,
    value: { active, terminal: [], warnings: [] },
  };
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

async function resolveRef(
  id: WorkId,
  deps: ConvoyProjectionDeps,
): Promise<ResolvedRef> {
  const result = await deps.workService.getWork(id);
  if (!result.ok) return { id, deleted: true };
  return { id, title: result.value.title, phase: result.value.phase };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/dashboard/convoy-projection.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Add deleted-lead test, run, expect PASS**

Append to `convoy-projection.test.ts` a `describe("deleted refs")` block that creates a convoy then `await container.workService.deleteWork(lead.id)`, then asserts `summary.value.active[0].lead` equals `{ id, deleted: true }`. (If `deleteWork` doesn't exist, mock `workService.getWork` to return `{ ok: false, error: NotFoundError }` for that id.)

---

### Task 1.3: Test + implement unresolved warnings

**Files:**
- Modify: `src/dashboard/convoy-projection.ts`
- Modify: `tests/unit/dashboard/convoy-projection.test.ts`

- [ ] **Step 1: Write three failing tests** (one per resolution rule)

In `convoy-projection.test.ts`, add a `describe("warnings")` with three tests:

1. **Unresolved present** — create lead+member+convoy, `advancePhase(lead.id, "cancelled", { reason: "scope cut" })`, expect `summary.value.warnings.length === 1` with `{ convoyId, reason: "scope cut", activeMemberCount: 1 }`. Also expect the matching `summary.value.active[i].hasUnresolvedWarning === true`.

2. **Resolved by convoy termination** — same setup, then `container.convoyRepo.cancel(convoy.value.id, { terminationReason: "follow lead" })`. Expect `warnings.length === 0`.

3. **Resolved by all-members-terminal** — same setup, then `advancePhase(memberA.id, "cancelled", { reason: "follow" })`. Expect `warnings.length === 0`.

- [ ] **Step 2: Run tests; expect 3 FAIL** (`warnings: []` from current impl)

Run: `npx vitest run tests/unit/dashboard/convoy-projection.test.ts`

- [ ] **Step 3: Implement** — Replace `buildConvoyDashboardSummary` body with:

```ts
export async function buildConvoyDashboardSummary(
  deps: ConvoyProjectionDeps,
): Promise<Result<ConvoyDashboardSummary, StorageError>> {
  const [activeResult, warningsResult] = await Promise.all([
    deps.convoyRepo.findActive(),
    deps.orchestrationRepo.findByType("convoy_lead_cancelled_warning"),
  ]);
  if (!activeResult.ok) return activeResult;
  if (!warningsResult.ok) return warningsResult;

  const warnings = await computeUnresolvedWarnings(warningsResult.value, deps);
  const warningConvoyIds = new Set(warnings.map((w) => w.convoyId));

  const active = await Promise.all(
    activeResult.value.map((convoy) =>
      enrichConvoy(convoy, deps, warningConvoyIds.has(convoy.id)),
    ),
  );

  return { ok: true, value: { active, terminal: [], warnings } };
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
```

- [ ] **Step 4: Run all unit tests; expect PASS**

Run: `npx vitest run tests/unit/dashboard/convoy-projection.test.ts`
Expected: 5+ tests PASS.

---

### Task 1.4: Test + implement terminal convoys window

**Files:**
- Modify: `src/dashboard/convoy-projection.ts`
- Modify: `tests/unit/dashboard/convoy-projection.test.ts`

- [ ] **Step 1: Write failing test for terminal convoys**

Add a `describe("terminal convoys")` block: create convoy, `convoyRepo.complete(convoy.value.id, { terminationReason: "shipped" })`, expect `summary.value.terminal.length === 1` with `{ id, status: "completed" }`. Expect `summary.value.active.length === 0`.

- [ ] **Step 2: Run test; expect FAIL** (`terminal: []` from current impl)

- [ ] **Step 3: Implement** — Add `findByType("convoy_created")` to the parallel fetches in `buildConvoyDashboardSummary` and add a `loadRecentTerminal` helper:

```ts
// In buildConvoyDashboardSummary, replace the Promise.all with:
const [activeResult, warningsResult, createdResult] = await Promise.all([
  deps.convoyRepo.findActive(),
  deps.orchestrationRepo.findByType("convoy_lead_cancelled_warning"),
  deps.orchestrationRepo.findByType("convoy_created"),
]);
if (!createdResult.ok) return createdResult;
// ... existing active + warnings logic ...
const activeIds = new Set(active.map((c) => c.id));
const terminal = await loadRecentTerminal(createdResult.value, activeIds, deps);
return { ok: true, value: { active, terminal, warnings } };

// Add this helper:
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
```

- [ ] **Step 4: Run all unit tests; expect PASS**

---

### Task 1.5: Test + implement `buildConvoyDetail`

**Files:**
- Modify: `src/dashboard/convoy-projection.ts`
- Modify: `tests/unit/dashboard/convoy-projection.test.ts`

- [ ] **Step 1: Write three failing tests**

Add `describe("buildConvoyDetail")`:

1. **Unknown id** — `buildConvoyDetail("cv-nope" as never, deps)` returns `{ ok: false, error: { code: ErrorCode.NOT_FOUND } }`.
2. **Active blocked** — create convoy (lead in `inception` or `spec`), expect `detail.value.guard` matches `{ name: "convoy_lead_ready", passing: false, targetPhase: "implementation" }` and `lifecycle[0].eventType === "convoy_created"`.
3. **Terminal** — create + `convoyRepo.complete(...)`, expect `detail.value.guard === null` and `lifecycle.map(l => l.eventType)` equals `["convoy_created", "convoy_completed"]`.

- [ ] **Step 2: Run; expect 3 FAIL**

- [ ] **Step 3: Implement `buildConvoyDetail`**

```ts
const PHASE_ORDER: readonly WorkPhase[] = ["inception","spec","planning","implementation","review","done"] as readonly WorkPhase[];
function phaseGte(actual: WorkPhase, target: WorkPhase): boolean {
  const a = PHASE_ORDER.indexOf(actual); const t = PHASE_ORDER.indexOf(target);
  return a >= 0 && t >= 0 && a >= t;
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
  const lifecycle = buildLifecycle(id,
    createdR.ok ? createdR.value : [],
    completedR.ok ? completedR.value : [],
    cancelledR.ok ? cancelledR.value : [],
    matchingWarnings);
  const recentLeadActivity = (leadEventsR.ok ? leadEventsR.value : [])
    .filter((e) => e.eventType === "phase_advanced")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, RECENT_LEAD_ACTIVITY_LIMIT)
    .map((e) => {
      const d = e.details as { from: WorkPhase; to: WorkPhase };
      return { eventType: "phase_advanced" as const, from: d.from, to: d.to, createdAt: e.createdAt };
    });

  const enriched = await enrichConvoy(convoy, deps, warning !== null);
  const guard: ConvoyGuardState | null = convoy.status === "active"
    ? {
        name: "convoy_lead_ready",
        passing: "phase" in enriched.lead ? phaseGte(enriched.lead.phase, convoy.targetPhase) : false,
        leadPhase: "phase" in enriched.lead ? enriched.lead.phase : ("spec" as WorkPhase),
        targetPhase: convoy.targetPhase,
      }
    : null;

  return { ok: true, value: { ...enriched, guard, recentLeadActivity, lifecycle, warning } };
}
```

- [ ] **Step 4: Add helpers `deriveDetailWarning` and `buildLifecycle`**

```ts
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
```

- [ ] **Step 5: Run all unit tests; expect PASS** (9+ tests across this file)

---

### Task 1.6: Wire HTTP handlers in `src/dashboard/index.ts`

**Files:**
- Modify: `src/dashboard/index.ts`

- [ ] **Step 1: Add imports near the top**

```ts
import { buildConvoyDashboardSummary, buildConvoyDetail } from "./convoy-projection.js";
import type { ConvoyId } from "../core/types.js";
```

- [ ] **Step 2: Add path matchers near line 274 (where other matchers are)**

```ts
const convoyMatch = pathname.match(/^\/api\/convoys\/([^/]+)$/);
const convoysListPath = pathname === "/api/convoys";
```

- [ ] **Step 3: Add handler blocks BEFORE the static-file fallback (line ~1338)**

```ts
if (convoysListPath) {
  if (req.method !== "GET") {
    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
  }
  const result = await buildConvoyDashboardSummary({
    convoyRepo: container.convoyRepo,
    orchestrationRepo: container.orchestrationRepo,
    workService: container.workService,
  });
  if (!result.ok) {
    const { status, code } = mapErrorToHttp(result.error);
    errorResponse(res, status, code, result.error.message);
    return;
  }
  jsonResponse(res, 200, result.value);
  return;
}

if (convoyMatch) {
  if (req.method !== "GET") {
    errorResponse(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed`);
    return;
  }
  const id = decodeURIComponent(convoyMatch[1]!) as ConvoyId;
  const result = await buildConvoyDetail(id, {
    convoyRepo: container.convoyRepo,
    orchestrationRepo: container.orchestrationRepo,
    workService: container.workService,
  });
  if (!result.ok) {
    const { status, code } = mapErrorToHttp(result.error);
    errorResponse(res, status, code, result.error.message);
    return;
  }
  jsonResponse(res, 200, result.value);
  return;
}
```

- [ ] **Step 4: `npx tsc --noEmit`** — expect no errors.

---

### Task 1.7: Integration test (full HTTP roundtrip)

**Files:**
- Create: `tests/integration/convoy-dashboard.test.ts`

- [ ] **Step 1: Create the file**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboard, type DashboardServer } from "../../src/dashboard/index.js";
import { createTestContainer, type MonstheraContainer } from "../../src/core/container.js";

let container: MonstheraContainer;
let dashboard: DashboardServer;
let baseUrl: string;
let authToken: string;

beforeAll(async () => {
  container = await createTestContainer();
  dashboard = await startDashboard(container, 0, {});
  baseUrl = `http://127.0.0.1:${dashboard.port}`;
  authToken = dashboard.authToken;
});
afterAll(async () => {
  await dashboard.close();
  await container.dispose();
});

async function api(path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${authToken}` } });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}
async function createWork(title: string) {
  const r = await container.workService.createWork({ title, template: "feature", priority: "medium", author: "agent-test", content: "## Objective\nx\n\n## Acceptance Criteria\n- ok" });
  if (!r.ok) throw new Error(`createWork ${title}`);
  return r.value;
}
```

- [ ] **Step 2: Add three test cases to the same file**

1. **GET /api/convoys lifecycle (active → warning → resolved)**: create convoy; assert active≥1, warnings=0; cancel lead with reason; assert warnings=1 with `{convoyId, reason, activeMemberCount: 1}`; cancel convoy; assert warnings=0.

2. **GET /api/convoys/:id with guard + lifecycle**: create convoy; GET detail; assert `body.guard.passing === false`, `body.lifecycle` contains `convoy_created`.

3. **GET /api/convoys/:id with unknown id returns 404**.

If `dashboard.authToken` doesn't expose the token, look at `tests/unit/dashboard/dashboard.test.ts` for the established pattern (e.g. `dashboard.authToken` or a public field on `DashboardServer`) and adapt.

- [ ] **Step 3: Run** — `npx vitest run tests/integration/convoy-dashboard.test.ts` — expect 3 PASS.

---

### Task 1.8: Lint + commit

- [ ] **Step 1**: `npm run lint && npm run typecheck && npm test` — all green.

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/convoy-projection.ts src/dashboard/index.ts tests/unit/dashboard/convoy-projection.test.ts tests/integration/convoy-dashboard.test.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): convoy projection module + GET /api/convoys endpoints

Adds src/dashboard/convoy-projection.ts as the composition layer between
convoyRepo, orchestrationRepo, and workService. Two HTTP handlers
(/api/convoys, /api/convoys/:id) call the projection and return
enriched shapes. Per ADR-013, no new repo methods.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Commit 2 — Convoy panel + per-convoy view UI

### Task 2.1: API client functions

**Files:** Modify `public/lib/api.js`

- [ ] Append:
```js
export function getConvoys() { return get("/api/convoys"); }
export function getConvoyById(id) { return get(`/api/convoys/${encodeURIComponent(id)}`); }
```

---

### Task 2.2: `renderPhaseChip` helper + unit test

**Files:** Modify `public/lib/components.js`, `tests/unit/dashboard/components.test.js`

- [ ] **Step 1: Failing test** — append `describe("renderPhaseChip")` block to `components.test.js`:
```js
import { renderPhaseChip } from "../../../public/lib/components.js";
describe("renderPhaseChip", () => {
  it("renders a phase as a labeled badge", () => {
    expect(renderPhaseChip("planning")).toContain("planning");
  });
  it("escapes the phase value", () => {
    expect(renderPhaseChip("<script>")).not.toContain("<script>");
  });
});
```
Run: `npx vitest run tests/unit/dashboard/components.test.js` — expect FAIL.

- [ ] **Step 2: Implement** — append to `public/lib/components.js`:
```js
const PHASE_VARIANT = {
  inception: "outline", spec: "secondary", planning: "primary",
  implementation: "success", review: "warning", done: "success", cancelled: "error",
};
export function renderPhaseChip(phase) {
  const variant = PHASE_VARIANT[phase] || "outline";
  return renderBadge(phase, variant);
}
```
Run tests; expect PASS.

---

### Task 2.3: `/convoys` list page

**Files:** Create `public/pages/convoys.js`

**Pattern:** Follow [public/pages/overview.js](../../../public/pages/overview.js) — same `export async function render(container)` shape, same `wrapper.innerHTML = [...].join("\n")` assembly, same `esc()`-only escaping for any data from the API.

- [ ] **Step 1: Create the file with the helper functions**

Imports:
```js
import { getConvoys } from "../lib/api.js";
import { esc, renderBadge, renderCard, renderPhaseChip, timeAgo } from "../lib/components.js";
```

Helper `renderWarningSection(warnings)` — returns empty string when `warnings.length === 0`; otherwise wraps each warning in `inline-notice inline-notice--error` rows showing `leadTitle`, a `data-link` anchor to `/convoys/${convoyId}`, the `activeMemberCount`, and the escaped `reason`. Wrap the rows in `renderCard("Unresolved warnings (N)", rows)`.

Helper `renderConvoyCard(convoy)` — counts members per phase (skip deleted refs), maps each `[phase, n]` to `renderPhaseChip(\`${phase} ×${n}\`)`. Builds an anchor card with class `convoy-card`, `data-link`, `href="/convoys/${convoy.id}"`. Card body shows: `convoy.id` + `timeAgo(convoy.createdAt)` in head; `lead {leadTitle} · {leadPhase} · {N} member(s)` (with a `renderBadge("warning","error")` pill iff `convoy.hasUnresolvedWarning`); the `goal` (escaped, clamped via CSS); the phase chip distribution.

Helper `renderEmpty()` — returns `renderCard("No active convoys", "<p class=\"text-sm text-muted\">A convoy groups work articles around a lead. Create one with <code>monsthera convoy create</code>.</p>")`.

- [ ] **Step 2: Implement `render(container)`**

Match the overview.js shape: `await getConvoys().catch(() => ({ active: [], terminal: [], warnings: [] }))`, build a wrapper div, assemble its HTML from page-header + warning section + active stream (or empty state) + optional terminal section, then `while (wrapper.firstChild) container.appendChild(wrapper.firstChild)`.

- [ ] **Step 3: Append CSS to `public/styles.css`**

```css
.convoy-stream { display:flex; flex-direction:column; gap:12px; }
.convoy-stream--muted { opacity:0.7; }
.convoy-card { background:var(--bg-elev); border-radius:8px; padding:12px 16px; text-decoration:none; color:inherit; border:1px solid var(--border); display:block; }
.convoy-card:hover { border-color:var(--accent); }
.convoy-card__head { display:flex; justify-content:space-between; align-items:baseline; }
.convoy-card__lead { font-size:13px; margin-top:4px; }
.convoy-card__goal { font-size:12px; color:var(--text-muted); margin-top:6px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.convoy-card__distrib { margin-top:8px; display:flex; gap:4px; flex-wrap:wrap; }
```

---

### Task 2.4: `/convoys/:id` detail page

**Files:** Create `public/pages/convoy.js`

**Pattern:** Same overview.js structure. Receives `params.id`. Layout uses the existing `.layout-split` / `.col-main` / `.col-side` two-column rules.

- [ ] **Step 1: Create the file**

Imports: `getConvoyById` from api, `esc, renderBadge, renderCard, renderPhaseChip, timeAgo` from components.

`render(container, params)`:
1. `const convoy = await getConvoyById(params.id).catch((err) => ({ __error: err }))`. If `convoy.__error`, render a 404 page: page-header titled "Convoy not found", subtitle showing the requested id (escaped), back-link button to `/convoys`. Return.
2. Otherwise build wrapper HTML in this order:
   - `renderHeader(convoy)` — page-header with kicker = convoy.id, title = goal, subtitle = "lead **{title}** · target **{phase}** · status **{status}** · {timeAgo}". Below subtitle, a guard line: if `convoy.guard.passing` show `✓ guard passing — lead at <leadPhase>, target was <targetPhase>` in success color; if `!passing` show `⊘ guard blocked — lead at <leadPhase>, target is <targetPhase>` in warning color; if `guard === null` show "terminal — guard no longer applies" in muted. Below that, if `convoy.warning`, an `inline-notice inline-notice--error` block with `⚠ Unresolved: {reason} · {activeMemberCount} member(s) still active`.
   - Two-column block: `<div class="layout-split"><div class="col-main">` + members card + `</div><div class="col-side">` + recent activity card + lifecycle card + `</div></div>`.
3. Members card (`renderCard("Members (N)", rows)`): each member as a `.guide-line` row showing title bold, id muted; right-side a `renderPhaseChip(member.phase)`. Deleted members show "(deleted)" instead of title.
4. Recent activity card: `convoy.recentLeadActivity` mapped to monospace text rows showing ISO date + `advanced {from} → {to}` with a left border in `var(--border)`. Empty state: `<p class="text-sm text-muted">No recent phase advances.</p>`.
5. Lifecycle card: `convoy.lifecycle` mapped to monospace rows with left border in `var(--accent)`, showing ISO date + `eventType` + meta (assemble from `actor`, `terminationReason`, `warningReason`, `goal` joined with ` · `). Empty state similar.

All text from the API goes through `esc()`. Final `wrapper.firstChild` loop matches overview.js.

---

### Task 2.5: Register routes

**Files:** Modify `public/app.js`

- [ ] In the `router.add(...)` chain (around line 70), insert two lines:
```js
  .add("/convoys", () => loadPage("./pages/convoys.js"))
  .add("/convoys/:id", (params) => loadPage("./pages/convoy.js", params))
```

---

### Task 2.6: Convoy stat card on overview

**Files:** Modify `public/pages/overview.js`

- [ ] **Step 1:** Add `getConvoys` to the import from `../lib/api.js`.

- [ ] **Step 2:** Add `convoys` to BOTH `Promise.all` blocks (initial load + `refresh()`):
```js
getConvoys().catch(() => ({ active: [], terminal: [], warnings: [] })),
```
Destructure as `..., convoys] = await Promise.all([...])`.

- [ ] **Step 3:** In `buildDOM`, in the `.col-side` section (after the existing "Blocked articles" stat card), insert:
```js
renderStatCard(
  "Convoys",
  convoys.active.length,
  convoys.active.length > 0 ? renderBadge(`${convoys.active.length} active`, "primary") : renderBadge("none active", "outline"),
),
```

- [ ] **Step 4: Smoke** — `npm run dashboard`, browser at `/`. Expect "Convoys" stat card. Visit `/convoys` — empty state copy. Visit `/convoys/<unknown>` — 404 page.

- [ ] **Step 5: Lint + typecheck + test + commit**

```bash
npm run lint && npm run typecheck && npm test
git add public/ tests/unit/dashboard/components.test.js
git commit -m "$(cat <<'EOF'
feat(dashboard): convoy panel + per-convoy view UI + overview card

Adds /convoys (list) and /convoys/:id (two-column workspace) backed by
the projection API from commit 1. Phase color centralizes in a new
renderPhaseChip helper. Overview stat card shows active convoy count;
warning visibility lives in the sidebar (commit 3), keeping home calm.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Commit 3 — Sidebar warning badge

### Task 3.1: Add Convoys nav item

**Files:** Modify `public/lib/sidebar.js`

- [ ] In `NAV_ITEMS` (between `events` and `knowledge`), insert:
```js
{ icon: "git-fork", label: "Convoys", path: "/convoys" },
```

- [ ] In `renderSidebar`, modify the per-item template so that when `item.path === "/convoys"` the `<a>` includes a `<span class="nav-badge" id="convoy-warning-badge" hidden></span>` after the label. Other items unchanged.

---

### Task 3.2: Async badge refresh wired to navigation

**Files:** Modify `public/lib/sidebar.js`, `public/styles.css`

- [ ] **Step 1: Add the refresh function** at the end of `sidebar.js`:

```js
import { getConvoys } from "./api.js";

let badgeRefreshInFlight = null;

export async function refreshConvoyWarningBadge() {
  if (badgeRefreshInFlight) return badgeRefreshInFlight;
  badgeRefreshInFlight = (async () => {
    try {
      const data = await getConvoys();
      const count = (data?.warnings || []).length;
      const badge = document.getElementById("convoy-warning-badge");
      if (!badge) return;
      if (count > 0) {
        badge.textContent = String(count);
        badge.hidden = false;
        badge.setAttribute("aria-label", `${count} unresolved convoy warning${count === 1 ? "" : "s"}`);
      } else {
        badge.hidden = true;
        badge.removeAttribute("aria-label");
      }
    } catch {
      // Silent — previous count preserved.
    } finally {
      badgeRefreshInFlight = null;
    }
  })();
  return badgeRefreshInFlight;
}
```

- [ ] **Step 2: Call it from `updateSidebar`** — at the end (after `lucide.createIcons`), add `refreshConvoyWarningBadge();`.

- [ ] **Step 3: Append CSS to `public/styles.css`**:
```css
.nav-badge {
  display:inline-flex; align-items:center; justify-content:center;
  min-width:18px; height:18px; padding:0 6px; border-radius:10px;
  background:var(--error); color:white; font-size:11px; font-weight:600;
  margin-left:auto;
}
```

- [ ] **Step 4: Smoke** — `npm run dashboard`, visit `/`, see "Convoys" in sidebar with no badge. Then via CLI in another terminal: create a convoy, cancel its lead with `--reason`. Reload `/`. Expect a red "1" next to "Convoys".

- [ ] **Step 5: Lint + typecheck + test + commit**

```bash
npm run lint && npm run typecheck && npm test
git add public/lib/sidebar.js public/styles.css
git commit -m "$(cat <<'EOF'
feat(dashboard): unresolved-warning badge in sidebar nav

Single channel for warning visibility: red count next to "Convoys" iff
there are unresolved convoy_lead_cancelled_warning events. Refresh is
navigation-driven (no timers): updateSidebar fires getConvoys() and
updates the badge in place. Failure is silent (previous count preserved).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Commit 4 — Lifecycle ribbon on work cards

### Task 4.1: Pre-load convoys in work page

**Files:** Modify `public/pages/work.js`

- [ ] **Step 1:** Add `getConvoys` to the import from `../lib/api.js`.

- [ ] **Step 2:** In the page's data-load `Promise.all`, add `getConvoys().catch(() => ({ active: [], terminal: [], warnings: [] }))` and destructure as `convoys`.

- [ ] **Step 3:** Build a `Map<workId, ConvoySummary[]>` keyed by `leadWorkId`:

```js
function buildConvoyLeadMap(convoys) {
  const map = new Map();
  const all = [...(convoys.active || []), ...(convoys.terminal || [])];
  for (const c of all) {
    const list = map.get(c.leadWorkId) || [];
    list.push(c);
    map.set(c.leadWorkId, list);
  }
  return map;
}
```

Compute `const convoyLeadMap = buildConvoyLeadMap(convoys)` once after each load. Pass it through whichever closure scope `buildQueueCard` runs in (the `rerender`/`refresh` cycle).

---

### Task 4.2: Render ribbon strip in expanded card

**Files:** Modify `public/pages/work.js`, `public/styles.css`

- [ ] **Step 1: Add the ribbon renderer**

```js
function renderConvoyRibbon(convoys) {
  if (!convoys || convoys.length === 0) return "";
  const pills = convoys.map((c) => {
    const cls = c.status === "active" ? "convoy-pill convoy-pill--active"
      : c.status === "completed" ? "convoy-pill convoy-pill--completed"
      : "convoy-pill convoy-pill--cancelled";
    const meta = c.status === "active"
      ? ` · ${c.members.length} member${c.members.length === 1 ? "" : "s"}`
      : "";
    return `<a href="/convoys/${esc(c.id)}" data-link class="${cls}">${esc(c.id)} · ${esc(c.status)}${meta}</a>`;
  }).join(" ");
  return `<div class="convoy-ribbon"><span class="text-xs text-muted text-uppercase">lead of</span> ${pills}</div>`;
}
```

- [ ] **Step 2:** In `buildQueueCard`, when `expanded === true`, insert `renderConvoyRibbon(convoyLeadMap.get(article.id))` near the top of the expanded card body (after the meta line, before reviewers/dependencies). The function returns empty string when the article isn't a lead — zero pixels added.

- [ ] **Step 3: Append CSS**

```css
.convoy-ribbon { margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.convoy-pill { padding:3px 10px; border-radius:12px; font-size:11px; text-decoration:none; border:1px solid; }
.convoy-pill--active { background:rgba(80,160,100,0.15); color:var(--success); border-color:rgba(80,160,100,0.4); }
.convoy-pill--completed { background:rgba(100,130,180,0.15); color:var(--accent); border-color:rgba(100,130,180,0.4); }
.convoy-pill--cancelled { background:rgba(180,100,100,0.15); color:var(--error); border-color:rgba(180,100,100,0.4); text-decoration:line-through; }
```

- [ ] **Step 4: Smoke** — `npm run dashboard`, navigate to `/work`, expand a card whose article is a convoy lead. Expect the ribbon strip with one or more pills.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint && npm run typecheck && npm test
git add public/pages/work.js public/styles.css
git commit -m "$(cat <<'EOF'
feat(dashboard): lifecycle ribbon on work-article cards

When an expanded work card represents the lead of one or more convoys,
a compact strip of status-colored pills appears near the title. Active
pills carry member count; terminal pills are line-through. Pills
navigate to /convoys/:id. Hidden when the article is not a lead.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Commit 5 — ADR-014 + knowledge note

### Task 5.1: Write ADR-014

**Files:** Create `docs/adrs/014-convoy-dashboard.md`

- [ ] Write the ADR with these sections:

**Status / Date / Decision makers** — Accepted / 2026-04-26 / Architecture team.

**Context** — ADR-013 closed the convoy data + event layer; the open follow-up was a screen. This ADR captures the shipping decisions.

**Decision** — six numbered subsections, each with prose explaining *why* and *what we considered*:
1. **Dedicated `/convoys` page, not an overlay** — convoys are a distinct grouping construct, mirror `convoy_list` MCP surface.
2. **Sidebar nav badge as the warning channel** — rejected hero banner (alarm fatigue) and per-card highlight (requires being on `/convoys`); sidebar is persistent, silent when clean, single source of truth.
3. **Lifecycle ribbon on the lead's work card** — co-locates "what convoys did I create" with where the operator already lives.
4. **No new repository methods** — projection composes existing `findActive/findById/findByType/getWork`. Trade-off: dashboard is the first public consumer of event-type names; coupling lives at the right layer.
5. **Resolution of warnings is inferred, not stored** — convoy active + ≥1 active member = unresolved; cancel from CLI auto-resolves on next render. Honors ADR-013's "events are time-series, projections are lens" principle.
6. **Refresh is navigation-driven in v1** — no timers; sidebar refreshes inside `updateSidebar`. v2 polling and v3 SSE consume same endpoints unchanged.

**Consequences** — operator gets 5-second scan; convoys table stays at six columns; renaming an event type breaks projection (intentionally local); single-channel warning means an operator who never glances at sidebar misses warnings (acceptable, it's chrome).

**Alternatives considered** — top-of-home banner (alarm fatigue), per-convoy-card highlight (requires being on `/convoys`), workspace layout for `/convoys` (duplicates state), materialized projection table (deferred until profiling), polling for badge freshness (deferred).

---

### Task 5.2: Write the knowledge note

**Files:** Create `knowledge/notes/convoy-dashboard-design-decisions.md`

- [ ] Use the **Option A** authoring path (direct file with frontmatter, per CLAUDE.md). Frontmatter:

```yaml
---
id: k-convoy-dashboard-design-decisions
slug: convoy-dashboard-design-decisions
title: "Decision: convoy dashboard — panel, sidebar badge, ribbon"
category: decision
tags: [orchestration, convoys, dashboard, ui, s4-v2]
references: [adr-014-convoy-dashboard, adr-013-convoy-hardening, k-91f42ekj]
createdAt: 2026-04-26T00:00:00Z
updatedAt: 2026-04-26T00:00:00Z
---
```

Body sections (informal trade-offs that didn't earn ADR space):

- **Why phase chips with counts, not a stacked bar** — at N=3 (typical convoy size today), bar segments mis-represent counts. Plain text loses color; per-member dots add a "what does click do" question that's scope creep. Chips give phase + count + color in one token. Trade-off: chip count tracks distinct phases not members; at N=10 you get 4 chips losing the "shape of progress" gestalt.

- **Why the sidebar badge instead of home banner or per-card highlight** — sidebar is persistent across pages, silent when clean (negative space convention), single source of truth, drastically simpler diff. Trade-off: an operator who never glances at sidebar misses warnings; acceptable because sidebar is page chrome.

- **Why navigation-driven refresh instead of polling** — polling adds setInterval state + cleanup complexity; navigation-driven gets 95% of UX for 5% of code. Polling is one line to add later if operators sit on `/` for half an hour and miss warnings.

- **Why /convoys/:id is two-column instead of stacked** — operator on detail page is investigating, not scanning; higher density has clear payoff. Mobile collapses via `.layout-split`.

- **Why the ribbon is a compact strip, not a section block** — work card already has 4-5 sections; adding one for the 20% of articles that are convoy leads makes the card heavier for the 80% that aren't. Compact strip is hidden when not a lead (zero pixels). Trade-off: at 5+ convoys per lead, pills wrap; for current scale that's fine.

- **What we deliberately punted** — per-member click in distribution viz, filterable warning list, SSE for real-time, clickable badge that drops to specific warning context.

- [ ] **Step 2: Smoke** — `node dist/bin.js status` (Monsthera reindexes automatically); `node dist/bin.js search "convoy dashboard design decisions"` should return the new article.

- [ ] **Step 3: Final lint + typecheck + test**

```bash
npm run lint && npm run typecheck && npm test
```

- [ ] **Step 4: Commit**

```bash
git add docs/adrs/014-convoy-dashboard.md knowledge/notes/convoy-dashboard-design-decisions.md
git commit -m "$(cat <<'EOF'
docs: ADR-014 + convoy-dashboard-design-decisions knowledge note

ADR-014 captures the six formal decisions: dedicated page, sidebar
badge as single warning channel, ribbon co-located with the lead, no
new repo methods, inferred-not-stored resolution, navigation-driven
refresh in v1. Knowledge note captures the informal trade-offs
(why phase chips, why sidebar over banner, why two-column detail).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Closure

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/convoy-dashboard
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat(dashboard): convoy dashboard — panel, warning badge, lifecycle ribbon" --body "$(cat <<'EOF'
## Summary

- New /convoys panel + /convoys/:id detail backed by src/dashboard/convoy-projection.ts (no new repo methods, per ADR-013)
- Sidebar nav badge as single channel for unresolved convoy_lead_cancelled_warning events
- Lifecycle ribbon on the lead's work card

## Test plan

- [ ] Unit tests for projection (tests/unit/dashboard/convoy-projection.test.ts)
- [ ] Integration test for HTTP endpoints (tests/integration/convoy-dashboard.test.ts)
- [ ] Manual smoke: monsthera dashboard, navigate /, /convoys, /convoys/:id, expand a work card whose article is a lead
- [ ] Cancel a lead from CLI → verify badge appears in sidebar

## References

- Spec: docs/superpowers/specs/2026-04-26-convoy-dashboard-design.md
- ADR-014: docs/adrs/014-convoy-dashboard.md
- ADR-013 (precedent): docs/adrs/013-convoy-hardening.md
- Plan article: knowledge k-91f42ekj

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for CI green**

```bash
gh pr checks --watch
gh pr merge --merge --auto
```

- [ ] **Step 4: Verify**

```bash
git fetch origin
git log origin/main -3 --oneline
```
Expected: the merge commit on top.
