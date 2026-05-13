import { describe, expect, it } from "vitest";
import { DefaultFactsExtractor } from "../../../src/sessions/facts-extractor.js";
import type { Session } from "../../../src/sessions/repository.js";
import type {
  OrchestrationEvent,
  OrchestrationEventRepository,
} from "../../../src/orchestration/repository.js";
import type {
  KnowledgeArticle,
  KnowledgeArticleRepository,
} from "../../../src/knowledge/repository.js";
import type { WorkArticle, WorkArticleRepository } from "../../../src/work/repository.js";
import type { CommandRunner, CommandSpec } from "../../../src/ops/command-runner.js";
import type { AgentId, ArticleId, WorkId } from "../../../src/core/types.js";
import { timestamp } from "../../../src/core/types.js";
import { ok, err } from "../../../src/core/result.js";
import { NotFoundError, StorageError } from "../../../src/core/errors.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses-test" as Session["id"],
    agentId: "claude-code" as AgentId,
    repo: "/tmp/repo",
    branch: null,
    openedAt: timestamp("2026-05-12T10:00:00Z"),
    closedAt: timestamp("2026-05-12T11:30:00Z"),
    status: "closed",
    handoffArticleId: null,
    factsPath: null,
    parentSessionId: null,
    abandonReason: null,
    quality: { score: null, degraded: false, model: null },
    intent: null,
    ...overrides,
  };
}

function makeWork(overrides: Partial<WorkArticle> = {}): WorkArticle {
  return {
    id: "w-12" as WorkId,
    title: "Auth refresh",
    template: "feature" as WorkArticle["template"],
    phase: "review" as WorkArticle["phase"],
    priority: "p2" as WorkArticle["priority"],
    author: "claude-code" as AgentId,
    lead: "claude-code" as AgentId,
    enrichmentRoles: [],
    reviewers: [],
    phaseHistory: [
      { phase: "review" as WorkArticle["phase"], enteredAt: timestamp("2026-05-12T09:00:00Z") },
    ],
    tags: [],
    references: [],
    codeRefs: [],
    dependencies: [],
    blockedBy: [],
    content: "",
    createdAt: timestamp("2026-05-12T09:00:00Z"),
    updatedAt: timestamp("2026-05-12T10:30:00Z"),
    ...overrides,
  };
}

function fakeEventRepo(events: OrchestrationEvent[]): OrchestrationEventRepository {
  return {
    findRecent: async () => ok([...events]),
    findInWindow: async (start: string, end: string, limit?: number) => {
      const inWindow = events
        .filter((e) => e.createdAt >= start && e.createdAt <= end)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return ok(limit != null ? inWindow.slice(0, limit) : inWindow);
    },
  } as unknown as OrchestrationEventRepository;
}

function fakeWorkRepo(articles: WorkArticle[]): WorkArticleRepository {
  const byId = new Map<string, WorkArticle>(articles.map((a) => [a.id as string, a]));
  return {
    findById: async (id: string) => {
      const found = byId.get(id);
      if (!found) return err(new NotFoundError("work", id));
      return ok(found);
    },
  } as unknown as WorkArticleRepository;
}

function fakeKnowledgeRepo(articles: KnowledgeArticle[]): KnowledgeArticleRepository {
  return {
    findMany: async () => ok([...articles]),
    findUpdatedSince: async (ts: string) =>
      ok(articles.filter((a) => a.updatedAt >= ts)),
  } as unknown as KnowledgeArticleRepository;
}

function scriptedRunner(routes: Record<string, string>): CommandRunner {
  return async (spec: CommandSpec) => {
    const key = `${spec.command} ${spec.args.join(" ")}`;
    if (key in routes) return ok({ stdout: routes[key]!, stderr: "" });
    return err(new StorageError(`unexpected command: ${key}`));
  };
}

function failingRunner(): CommandRunner {
  return async (spec: CommandSpec) =>
    err(new StorageError(`git not available for ${spec.command} ${spec.args.join(" ")}`));
}

describe("DefaultFactsExtractor", () => {
  it("hydrates events, work, knowledge, commits, code, and signals from injected dependencies", async () => {
    const session = makeSession();
    const events: OrchestrationEvent[] = [
      {
        id: "e-1",
        workId: "w-12" as WorkId,
        eventType: "phase_advanced" as OrchestrationEvent["eventType"],
        agentId: "claude-code" as AgentId,
        details: {},
        createdAt: timestamp("2026-05-12T10:30:00Z"),
      },
    ];
    const knowledge: KnowledgeArticle[] = [
      {
        id: "k-1" as ArticleId,
        slug: "auth-design" as KnowledgeArticle["slug"],
        category: "decision",
        title: "Auth design",
        tags: [],
        references: [],
        codeRefs: [],
        content: "",
        createdAt: timestamp("2026-05-12T10:15:00Z"),
        updatedAt: timestamp("2026-05-12T10:15:00Z"),
      },
      {
        id: "k-handoff" as ArticleId,
        slug: "handoff-ses-test" as KnowledgeArticle["slug"],
        category: "handoff",
        title: "should be skipped",
        tags: [],
        references: [],
        codeRefs: [],
        content: "",
        createdAt: timestamp("2026-05-12T11:25:00Z"),
        updatedAt: timestamp("2026-05-12T11:25:00Z"),
      },
    ];
    const runner = scriptedRunner({
      "git rev-list -1 --before=2026-05-12T10:00:00Z HEAD": "abc1234\n",
      "git log --since=2026-05-12T10:00:00Z --until=2026-05-12T11:30:00Z --format=%H|%s|%cI":
        "abc1234deadbeef|feat: refresh tokens|2026-05-12T10:20:00+10:00\n",
      "git diff --numstat abc1234..HEAD": "10\t3\tsrc/auth/service.ts\n",
      "git diff --unified=0 abc1234..HEAD": [
        "diff --git a/src/auth/worker.ts b/src/auth/worker.ts",
        "--- a/src/auth/worker.ts",
        "+++ b/src/auth/worker.ts",
        "@@ -0,0 +42,1 @@",
        "+// TODO: wire refresh",
      ].join("\n"),
    });

    const extractor = new DefaultFactsExtractor({
      eventRepo: fakeEventRepo(events),
      workRepo: fakeWorkRepo([makeWork()]),
      knowledgeRepo: fakeKnowledgeRepo(knowledge),
      runner,
    });

    const result = await extractor.extract(session, "shipped refresh");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const facts = result.value;
    expect(facts.sessionId).toBe(session.id);
    expect(facts.agent).toBe(session.agentId);
    expect(facts.window).toEqual({ openedAt: session.openedAt, closedAt: session.closedAt });
    expect(facts.events).toHaveLength(1);
    expect(facts.workTouched).toEqual([
      {
        id: "w-12",
        title: "Auth refresh",
        phaseAtOpen: "review",
        phaseAtClose: "review",
        role: "lead",
      },
    ]);
    expect(facts.knowledgeTouched).toEqual([
      {
        id: "k-1",
        slug: "auth-design",
        title: "Auth design",
        category: "decision",
        op: "created",
      },
    ]);
    expect(facts.commits).toEqual([
      {
        sha: "abc1234deadbeef",
        subject: "feat: refresh tokens",
        timestamp: "2026-05-12T10:20:00+10:00",
      },
    ]);
    expect(facts.codeTouched).toEqual([
      { path: "src/auth/service.ts", linesAdded: 10, linesRemoved: 3 },
    ]);
    expect(facts.signals.todosAdded).toEqual([
      { path: "src/auth/worker.ts", line: 42, text: "// TODO: wire refresh" },
    ]);
    expect(facts.agentNote).toBe("shipped refresh");
  });

  it("degrades gracefully when git is unavailable: commits/code/signals stay empty, repo-backed sections still hydrate", async () => {
    const session = makeSession();
    const events: OrchestrationEvent[] = [
      {
        id: "e-1",
        workId: "w-12" as WorkId,
        eventType: "phase_advanced" as OrchestrationEvent["eventType"],
        agentId: "claude-code" as AgentId,
        details: {},
        createdAt: timestamp("2026-05-12T10:30:00Z"),
      },
    ];

    const extractor = new DefaultFactsExtractor({
      eventRepo: fakeEventRepo(events),
      workRepo: fakeWorkRepo([makeWork()]),
      knowledgeRepo: fakeKnowledgeRepo([]),
      runner: failingRunner(),
    });

    const result = await extractor.extract(session, null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const facts = result.value;
    expect(facts.events).toHaveLength(1);
    expect(facts.workTouched).toHaveLength(1);
    expect(facts.commits).toEqual([]);
    expect(facts.codeTouched).toEqual([]);
    expect(facts.signals).toEqual({ todosAdded: [], questions: [], testFailures: [] });
  });

  it("returns a well-formed empty SessionFacts when no source has data in the window", async () => {
    const session = makeSession();

    const extractor = new DefaultFactsExtractor({
      eventRepo: fakeEventRepo([]),
      workRepo: fakeWorkRepo([]),
      knowledgeRepo: fakeKnowledgeRepo([]),
      runner: failingRunner(),
    });

    const result = await extractor.extract(session, "empty");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      sessionId: session.id,
      agent: session.agentId,
      repo: session.repo,
      branch: session.branch,
      window: { openedAt: session.openedAt, closedAt: session.closedAt },
      events: [],
      workTouched: [],
      knowledgeTouched: [],
      codeTouched: [],
      commits: [],
      signals: { todosAdded: [], questions: [], testFailures: [] },
      agentNote: "empty",
    });
  });
});
