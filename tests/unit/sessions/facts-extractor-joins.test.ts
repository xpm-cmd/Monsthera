import { describe, expect, it } from "vitest";
import { joinWorkTouched, phaseAt, roleOf } from "../../../src/sessions/facts-extractor-joins.js";
import type {
  PhaseHistoryEntry,
  WorkArticle,
  WorkArticleRepository,
  EnrichmentAssignment,
  ReviewAssignment,
} from "../../../src/work/repository.js";
import type { OrchestrationEvent } from "../../../src/orchestration/repository.js";
import type { AgentId, WorkId } from "../../../src/core/types.js";
import { timestamp } from "../../../src/core/types.js";
import { ok, err } from "../../../src/core/result.js";
import { NotFoundError } from "../../../src/core/errors.js";

function entry(phase: string, enteredAt: string, exitedAt?: string): PhaseHistoryEntry {
  return {
    phase: phase as PhaseHistoryEntry["phase"],
    enteredAt: timestamp(enteredAt),
    exitedAt: exitedAt !== undefined ? timestamp(exitedAt) : undefined,
  };
}

function makeWork(overrides: Partial<WorkArticle> = {}): WorkArticle {
  return {
    id: "w-test" as WorkArticle["id"],
    title: "Test work",
    template: "feature" as WorkArticle["template"],
    phase: "planning" as WorkArticle["phase"],
    priority: "p2" as WorkArticle["priority"],
    author: "agent-author" as AgentId,
    enrichmentRoles: [],
    reviewers: [],
    phaseHistory: [
      { phase: "planning" as WorkArticle["phase"], enteredAt: timestamp("2026-05-12T10:00:00Z") },
    ],
    tags: [],
    references: [],
    codeRefs: [],
    dependencies: [],
    blockedBy: [],
    content: "",
    createdAt: timestamp("2026-05-12T10:00:00Z"),
    updatedAt: timestamp("2026-05-12T10:00:00Z"),
    ...overrides,
  };
}

describe("phaseAt", () => {
  it("matches the entry whose `enteredAt` equals the timestamp", () => {
    const history: PhaseHistoryEntry[] = [
      entry("planning", "2026-05-12T10:00:00Z", "2026-05-12T11:00:00Z"),
      entry("review", "2026-05-12T11:00:00Z", "2026-05-12T12:00:00Z"),
      entry("done", "2026-05-12T12:00:00Z"),
    ];

    expect(phaseAt(history, "2026-05-12T11:00:00Z")).toBe("review");
  });

  it("matches the entry whose window strictly contains the timestamp", () => {
    const history: PhaseHistoryEntry[] = [
      entry("planning", "2026-05-12T10:00:00Z", "2026-05-12T11:00:00Z"),
      entry("review", "2026-05-12T11:00:00Z", "2026-05-12T12:00:00Z"),
      entry("done", "2026-05-12T12:00:00Z"),
    ];

    expect(phaseAt(history, "2026-05-12T11:30:00Z")).toBe("review");
  });

  it("returns the most recent (current) phase when the timestamp predates the first entry", () => {
    const history: PhaseHistoryEntry[] = [
      entry("planning", "2026-05-12T10:00:00Z", "2026-05-12T11:00:00Z"),
      entry("done", "2026-05-12T11:00:00Z"),
    ];

    expect(phaseAt(history, "2026-05-12T08:00:00Z")).toBe("done");
  });
});

describe("roleOf", () => {
  it("returns `lead` when the agent is the work's lead", () => {
    const work = makeWork({ lead: "agent-claude" as AgentId });
    expect(roleOf(work, "agent-claude" as AgentId)).toBe("lead");
  });

  it("returns `assignee` when the agent is the assignee but not lead", () => {
    const work = makeWork({
      lead: "agent-other" as AgentId,
      assignee: "agent-claude" as AgentId,
    });
    expect(roleOf(work, "agent-claude" as AgentId)).toBe("assignee");
  });

  it("returns `reviewer` when the agent appears in reviewers[]", () => {
    const reviewer: ReviewAssignment = { agentId: "agent-claude" as AgentId, status: "pending" };
    const work = makeWork({ reviewers: [reviewer] });
    expect(roleOf(work, "agent-claude" as AgentId)).toBe("reviewer");
  });

  it("returns `enrichment` when the agent appears only in enrichmentRoles[]", () => {
    const role: EnrichmentAssignment = {
      role: "security",
      agentId: "agent-claude" as AgentId,
      status: "pending",
    };
    const work = makeWork({ enrichmentRoles: [role] });
    expect(roleOf(work, "agent-claude" as AgentId)).toBe("enrichment");
  });
});

function fakeWorkRepo(articles: WorkArticle[]): WorkArticleRepository {
  const byId = new Map<string, WorkArticle>();
  for (const a of articles) byId.set(a.id, a);
  const findById = async (id: string) => {
    const found = byId.get(id);
    if (!found) return err(new NotFoundError("work", id));
    return ok(found);
  };
  return { findById } as unknown as WorkArticleRepository;
}

function makeEvent(overrides: Partial<OrchestrationEvent> = {}): OrchestrationEvent {
  return {
    id: "e-test",
    workId: "w-12" as WorkId,
    eventType: "phase_advanced" as OrchestrationEvent["eventType"],
    details: {},
    createdAt: timestamp("2026-05-12T10:30:00Z"),
    ...overrides,
  };
}

describe("joinWorkTouched", () => {
  it("dedups events that reference the same workId into a single touched entry", async () => {
    const work: WorkArticle = makeWork({
      id: "w-12" as WorkId,
      title: "Auth refresh",
      lead: "agent-claude" as AgentId,
      phaseHistory: [
        { phase: "review" as WorkArticle["phase"], enteredAt: timestamp("2026-05-12T09:00:00Z") },
      ],
    });
    const repo = fakeWorkRepo([work]);
    const events = [
      makeEvent({ id: "e-1", workId: "w-12" as WorkId, createdAt: timestamp("2026-05-12T10:30:00Z") }),
      makeEvent({ id: "e-2", workId: "w-12" as WorkId, createdAt: timestamp("2026-05-12T10:45:00Z") }),
      makeEvent({ id: "e-3", workId: "w-12" as WorkId, createdAt: timestamp("2026-05-12T11:00:00Z") }),
    ];

    const touched = await joinWorkTouched({
      events,
      workRepo: repo,
      agentId: "agent-claude" as AgentId,
      openedAt: "2026-05-12T10:00:00Z",
      closedAt: "2026-05-12T11:30:00Z",
    });

    expect(touched).toHaveLength(1);
    expect(touched[0]).toMatchObject({ id: "w-12", title: "Auth refresh", role: "lead" });
  });

  it("uses `phaseAt` to compute phaseAtOpen vs phaseAtClose distinctly", async () => {
    const work: WorkArticle = makeWork({
      id: "w-13" as WorkId,
      title: "Phase-transition during session",
      lead: "agent-claude" as AgentId,
      phaseHistory: [
        {
          phase: "planning" as WorkArticle["phase"],
          enteredAt: timestamp("2026-05-12T09:00:00Z"),
          exitedAt: timestamp("2026-05-12T10:45:00Z"),
        },
        {
          phase: "review" as WorkArticle["phase"],
          enteredAt: timestamp("2026-05-12T10:45:00Z"),
        },
      ],
    });
    const repo = fakeWorkRepo([work]);
    const events = [makeEvent({ workId: "w-13" as WorkId })];

    const touched = await joinWorkTouched({
      events,
      workRepo: repo,
      agentId: "agent-claude" as AgentId,
      openedAt: "2026-05-12T10:00:00Z",
      closedAt: "2026-05-12T11:30:00Z",
    });

    expect(touched).toHaveLength(1);
    expect(touched[0]!.phaseAtOpen).toBe("planning");
    expect(touched[0]!.phaseAtClose).toBe("review");
  });
});
