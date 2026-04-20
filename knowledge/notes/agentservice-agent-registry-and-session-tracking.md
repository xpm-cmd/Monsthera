---
id: k-c8uur83h
title: AgentService: Agent registry and session tracking
slug: agentservice-agent-registry-and-session-tracking
category: context
tags: [agents, registry, sessions, orchestration]
codeRefs: [src/agents/service.ts, src/agents/index.ts, src/tools/orchestration-tools.ts, public/pages/system/agents.js, src/tools/agent-tools.ts]
references: [agent-and-wave-mcp-tools, adr-004-orchestration-model]
createdAt: 2026-04-11T02:24:00.871Z
updatedAt: 2026-04-18T07:40:31.389Z
---

## Overview

`AgentService` is a derived-data service — it has no persistent agent registry. Instead, it builds the agent directory on-the-fly by scanning all work articles and orchestration events. Every agent identity is discovered from participation roles on work articles (author, lead, assignee, reviewer, enrichment contributor). There is no explicit agent registration step.

The service lives at `src/agents/service.ts` and is barrel-exported from `src/agents/index.ts`.

## Dependencies

- **WorkArticleRepository** — provides all work articles via `findMany()`
- **OrchestrationEventRepository** — provides recent orchestration events via `findRecent(limit)` (capped at `RECENT_EVENT_LIMIT = 250`)
- **Logger** — child logger tagged with `{ domain: "agents" }`

## How the agent directory is derived

`buildDirectory()` is the core private method. It runs two queries in parallel:

1. `workRepo.findMany()` — all work articles
2. `orchestrationRepo.findRecent(250)` — recent orchestration events

### Phase 1: Work article scan

For each work article, `collectParticipants(article)` extracts every agent who touches the work item:

- **author** — `article.author` (always present)
- **lead** — `article.lead` (optional)
- **assignee** — `article.assignee` (optional)
- **reviewers** — each `article.reviewers[]` entry, tracking review status (pending/completed)
- **enrichment roles** — each `article.enrichmentRoles[]` entry, tracking enrichment status (pending/contributed/skipped)

Each participant gets a `MutableTouchpoint` per work article, which records the work item's id, title, phase, priority, updatedAt, blockedBy count, and the agent's roles on that item.

Profile-level counters are accumulated: `authoredCount`, `leadCount`, `assignedCount`, `pendingReviewCount`, `completedReviewCount`, `enrichmentPendingCount/ContributedCount/SkippedCount`, `activeWorkCount` (non-terminal phases), `blockedWorkCount`.

Terminal phases are `done` and `cancelled`.

### Phase 2: Event attribution

For each orchestration event, the service finds all agents associated with that event's `workId` (from the work-to-agents map built in Phase 1), plus the event's own `agentId`. Events are classified as:

- **direct** — the event's `agentId` matches the agent being counted
- **related** — the agent participates in the work item but didn't trigger the event

Each agent profile stores up to `PROFILE_EVENT_LIMIT = 8` recent events, sorted by recency.

### Phase 3: Finalization and sorting

`finalizeProfile()` converts mutable state to the readonly `AgentProfile` interface:

- **status**: `"active"` if `activeWorkCount > 0`, otherwise `"idle"`
- **current focus**: the most recently updated non-terminal touchpoint, with an `actionLabel` derived from `describeCurrentAction()`:
  - Reviewer in review phase → "Review"
  - Enrichment role in enrichment phase → "Enrichment"
  - Assignee → capitalized phase name
  - Lead → "Coordination"
  - Author → "Context"
  - Fallback → capitalized phase name

Agents are sorted by: active work count (desc) → pending review count (desc) → enrichment pending count (desc) → last activity (desc) → id (asc).

## Directory summary

The `AgentDirectorySummary` aggregates across all agents:
- `totalAgents`, `activeAgents`, `idleAgents`
- `reviewAgents` (agents with pending reviews)
- `enrichmentAgents` (agents with pending enrichments)
- `directEventCount`, `relatedEventCount`
- `currentPhaseCounts` — how many agents are currently focused on each phase (planning, enrichment, implementation, review, done, cancelled, idle)

## Public methods

### `listAgents(): Promise<Result<AgentDirectory, StorageError>>`
Returns the full derived agent directory with summary and all agent profiles. Logs the agent count at debug level.

### `getAgent(id: string): Promise<Result<AgentProfile, NotFoundError | StorageError>>`
Builds the full directory, then finds a single agent by id. Returns `NotFoundError` if the agent id doesn't appear in any work article or event.

## Exported types

The barrel export (`src/agents/index.ts`) exposes:
- `AgentService` (class)
- `AgentDirectory`, `AgentDirectorySummary`, `AgentProfile`, `AgentTouchpoint`, `AgentCurrentFocus`, `AgentRecentEvent` (interfaces)

## Relationship to dashboard and tools

The orchestration tools (`src/tools/orchestration-tools.ts`) expose `listAgents` and `getAgent` as MCP tools for AI agents to query. The dashboard agents page (`public/pages/system/agents.js`) renders the directory in the web UI, showing agent cards with status badges, current focus, touchpoints, and recent event timelines.

## Key design decisions

- **No persistent registry**: Agent identities are ephemeral — they exist only as long as they participate in work articles. This avoids stale agent entries and registration overhead.
- **Full rebuild on every call**: `buildDirectory()` always scans all work articles and recent events. This is simple and correct but means cost scales with total work article count.
- **Event limit of 250**: Only the most recent 250 orchestration events are considered for activity tracking, keeping the scan bounded.
- **Profile event cap of 8**: Each agent stores at most 8 recent events to keep response payloads manageable.

<!-- codex-related-articles:start -->
## Related Articles

- [[agent-and-wave-mcp-tools]]
- [[wave-planning-and-execution-system]]
- [[adr-004-orchestration-model]]
<!-- codex-related-articles:end -->
