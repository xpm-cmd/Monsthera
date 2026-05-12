import { describe, it, expect, beforeEach } from "vitest";
import { InMemorySessionRepository } from "../../../src/sessions/in-memory-repository.js";
import { SessionService } from "../../../src/sessions/service.js";
import { agentId, sessionId } from "../../../src/core/types.js";
import { SessionStatus, AbandonmentReason, type SessionFacts } from "../../../src/sessions/schemas.js";
import { ErrorCode } from "../../../src/core/errors.js";
import type { FactsExtractor } from "../../../src/sessions/facts-extractor.js";
import { ok } from "../../../src/core/result.js";

function stubExtractor(overrides: Partial<SessionFacts> = {}): FactsExtractor {
  return {
    async extract(session, agentNote) {
      const facts: SessionFacts = {
        sessionId: session.id,
        agent: session.agentId,
        repo: session.repo,
        branch: session.branch,
        window: {
          openedAt: session.openedAt,
          closedAt: session.closedAt ?? new Date().toISOString(),
        },
        events: [],
        workTouched: [],
        knowledgeTouched: [],
        codeTouched: [],
        commits: [],
        signals: { todosAdded: [], questions: [], testFailures: [] },
        agentNote: agentNote ?? null,
        ...overrides,
      };
      return ok(facts);
    },
  };
}

describe("SessionService.open", () => {
  let repo: InMemorySessionRepository;
  let svc: SessionService;
  let clock: () => Date;

  beforeEach(() => {
    repo = new InMemorySessionRepository();
    clock = () => new Date("2026-05-12T10:43:00Z");
    svc = new SessionService(repo, stubExtractor(), { now: clock });
  });

  it("creates a new open session with generated id", async () => {
    const result = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a", branch: "main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.status).toBe(SessionStatus.OPEN);
    expect(result.value.session.id).toMatch(/^ses-\d{8}-\d{6}-claude-code$/);
  });

  it("auto-supersedes a prior open session for the same (agent, repo)", async () => {
    const first = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Move clock forward so the second session gets a unique id
    clock = () => new Date("2026-05-12T11:00:00Z");
    svc = new SessionService(repo, stubExtractor(), { now: clock });

    const second = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // First should now be abandoned with reason=superseded
    const firstReload = await repo.findById(first.value.session.id);
    expect(firstReload.ok).toBe(true);
    if (!firstReload.ok) return;
    expect(firstReload.value.status).toBe(SessionStatus.ABANDONED);
    expect(firstReload.value.abandonReason).toBe(AbandonmentReason.SUPERSEDED);
  });

  it("does NOT supersede an open session for a different agent", async () => {
    await svc.open({ agentId: agentId("codex-cli"), repo: "/tmp/repo-a" });
    clock = () => new Date("2026-05-12T11:00:00Z");
    svc = new SessionService(repo, stubExtractor(), { now: clock });
    await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });

    const allOpen = await repo.findMany({ status: SessionStatus.OPEN });
    expect(allOpen.ok).toBe(true);
    if (!allOpen.ok) return;
    expect(allOpen.value).toHaveLength(2);
  });

  it("sets parentSessionId to the latest closed session for the same (agent, repo)", async () => {
    // Create + close an earlier session
    const first = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!first.ok) throw new Error("first open failed");
    clock = () => new Date("2026-05-12T10:55:00Z");
    svc = new SessionService(repo, stubExtractor(), { now: clock });
    await svc.close({ sessionId: first.value.session.id });

    clock = () => new Date("2026-05-12T11:00:00Z");
    svc = new SessionService(repo, stubExtractor(), { now: clock });
    const second = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.session.parentSessionId).toBe(first.value.session.id);
  });

  it("preserves intent when provided", async () => {
    const result = await svc.open({
      agentId: agentId("claude-code"),
      repo: "/tmp/repo-a",
      intent: "Land M3 phase 5",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.intent).toBe("Land M3 phase 5");
  });
});

describe("SessionService.close", () => {
  let repo: InMemorySessionRepository;
  let svc: SessionService;

  beforeEach(async () => {
    repo = new InMemorySessionRepository();
    svc = new SessionService(repo, stubExtractor(), { now: () => new Date("2026-05-12T10:43:00Z") });
  });

  it("closes the implicit open session for (agent, repo) when no sessionId is provided", async () => {
    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");
    const result = await svc.close({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.status).toBe(SessionStatus.CLOSED);
    expect(result.value.session.id).toBe(opened.value.session.id);
  });

  it("persists facts via the extractor and sets factsPath", async () => {
    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");
    const result = await svc.close({ sessionId: opened.value.session.id, note: "smoke test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.factsPath).not.toBeNull();
    expect(result.value.facts.agentNote).toBe("smoke test");
  });

  it("returns NotFoundError when no matching open session exists", async () => {
    const result = await svc.close({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("returns NotFoundError when passed an unknown sessionId", async () => {
    const result = await svc.close({ sessionId: sessionId("ses-does-not-exist") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("SessionService.close — LLM pipeline integration", () => {
  let repo: InMemorySessionRepository;

  beforeEach(() => {
    repo = new InMemorySessionRepository();
  });

  it("attaches summary + evalResult + handoffArticleId when summarizer is healthy", async () => {
    const { FakeLLMSummarizer } = await import("../../../src/sessions/llm-summarizer.js");
    const fakeSummary = {
      tldr: "Shipped M3 phase 5.",
      summary: "Did the thing.\n\nReview passed.",
      decisions: [{ text: "use refresh tokens", evidence: [] }],
      blockers: [],
      surprises: [],
      deferred: [],
      nextSteps: [{ action: "smoke test", evidence: [], why: "validate" }],
      openQuestions: [],
      suggestedAgent: "performance",
    };
    const summarizer = new FakeLLMSummarizer(fakeSummary, { score: 5, reasoning: "complete" });
    const svc = new SessionService(repo, stubExtractor(), { now: () => new Date("2026-05-12T10:43:00Z"), summarizer });

    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");

    const closed = await svc.close({ sessionId: opened.value.session.id });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;

    expect(closed.value.summary?.tldr).toBe("Shipped M3 phase 5.");
    expect(closed.value.evalResult?.score).toBe(5);
    expect(closed.value.degraded).toBe(false);
    expect(closed.value.handoffArticleId).toMatch(/^handoff-ses-/);
    expect(closed.value.session.quality.score).toBe(5);
    expect(closed.value.session.quality.degraded).toBe(false);
    expect(closed.value.session.quality.model).toBe("fake");
    expect(closed.value.session.handoffArticleId).toBe(closed.value.handoffArticleId);
  });

  it("falls back to T1-only handoff when --no-llm is set", async () => {
    const { FakeLLMSummarizer } = await import("../../../src/sessions/llm-summarizer.js");
    const fakeSummary = {
      tldr: "should not be used",
      summary: "x",
      decisions: [], blockers: [], surprises: [], deferred: [], nextSteps: [], openQuestions: [], suggestedAgent: null,
    };
    const summarizer = new FakeLLMSummarizer(fakeSummary);
    const svc = new SessionService(repo, stubExtractor(), { now: () => new Date("2026-05-12T10:43:00Z"), summarizer });

    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");

    const closed = await svc.close({ sessionId: opened.value.session.id, noLlm: true });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.summary).toBeNull();
    expect(closed.value.evalResult).toBeNull();
    expect(closed.value.degraded).toBe(true);
    expect(closed.value.session.quality.degraded).toBe(true);
    expect(closed.value.session.quality.score).toBeNull();
  });

  it("falls back to T1-only when summarizer healthCheck fails", async () => {
    const { FakeLLMSummarizer } = await import("../../../src/sessions/llm-summarizer.js");
    const fakeSummary = {
      tldr: "x", summary: "x",
      decisions: [], blockers: [], surprises: [], deferred: [], nextSteps: [], openQuestions: [], suggestedAgent: null,
    };
    const unhealthy = new FakeLLMSummarizer(fakeSummary, { score: 4, reasoning: "x" }, /* healthy: */ false);
    const svc = new SessionService(repo, stubExtractor(), { now: () => new Date("2026-05-12T10:43:00Z"), summarizer: unhealthy });

    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");

    const closed = await svc.close({ sessionId: opened.value.session.id });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.summary).toBeNull();
    expect(closed.value.degraded).toBe(true);
  });

  it("prunes invalid citations from the summary before attaching", async () => {
    const { FakeLLMSummarizer } = await import("../../../src/sessions/llm-summarizer.js");
    const fakeSummary = {
      tldr: "x",
      summary: "x",
      decisions: [{ text: "valid evidence kept, fake pruned", evidence: ["work:w-nope", "evt:e-fake"] }],
      blockers: [],
      surprises: [],
      deferred: [],
      nextSteps: [],
      openQuestions: [],
      suggestedAgent: null,
    };
    const summarizer = new FakeLLMSummarizer(fakeSummary);
    const svc = new SessionService(repo, stubExtractor(), { now: () => new Date("2026-05-12T10:43:00Z"), summarizer });

    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");

    const closed = await svc.close({ sessionId: opened.value.session.id });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    // The fake summary cited two ids that don't exist in the (empty) stub facts.
    // Both should have been pruned, leaving the decision text intact but evidence=[].
    expect(closed.value.summary?.decisions[0]?.evidence).toEqual([]);
    expect(closed.value.summary?.decisions[0]?.text).toContain("valid evidence kept");
  });
});

describe("SessionService.close — async dispatch", () => {
  let repo: InMemorySessionRepository;
  let spawned: Array<{ cmd: string; args: string[]; cwd?: string }>;

  beforeEach(() => {
    repo = new InMemorySessionRepository();
    spawned = [];
  });

  it("dispatches a detached worker subprocess and returns immediately when sync=false", async () => {
    const { FakeLLMSummarizer } = await import("../../../src/sessions/llm-summarizer.js");
    const fakeSummary = {
      tldr: "x", summary: "x",
      decisions: [], blockers: [], surprises: [], deferred: [], nextSteps: [], openQuestions: [], suggestedAgent: null,
    };
    const summarizer = new FakeLLMSummarizer(fakeSummary);

    const svc = new SessionService(repo, stubExtractor(), {
      now: () => new Date("2026-05-12T10:43:00Z"),
      summarizer,
      resolveWorkerScript: () => "/fake/path/to/bin.js",
      spawnWorker: (cmd, args, cwd) => {
        spawned.push({ cmd, args, cwd });
        return { unref: () => undefined };
      },
    });

    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");

    const closed = await svc.close({ sessionId: opened.value.session.id, sync: false });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;

    expect(closed.value.asyncDispatched).toBe(true);
    expect(closed.value.summary).toBeNull();
    expect(closed.value.handoffArticleId).toBeNull();
    expect(closed.value.degraded).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toContain("session");
    expect(spawned[0]?.args).toContain("_generate-handoff");
    expect(spawned[0]?.args).toContain(opened.value.session.id);
  });

  it("falls back to sync when summarizer is unwired even with sync=false", async () => {
    const svc = new SessionService(repo, stubExtractor(), {
      now: () => new Date("2026-05-12T10:43:00Z"),
      // summarizer omitted → null
      resolveWorkerScript: () => "/fake/path/to/bin.js",
      spawnWorker: (cmd, args, cwd) => {
        spawned.push({ cmd, args, cwd });
        return { unref: () => undefined };
      },
    });
    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");

    const closed = await svc.close({ sessionId: opened.value.session.id, sync: false });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.asyncDispatched).toBe(false);
    expect(spawned).toHaveLength(0);
    // Sync path with no summarizer → T1-only handoff but article id is set.
    expect(closed.value.handoffArticleId).toMatch(/^handoff-ses-/);
  });

  it("runs sync inline when --no-llm even with sync=false", async () => {
    const { FakeLLMSummarizer } = await import("../../../src/sessions/llm-summarizer.js");
    const fakeSummary = {
      tldr: "x", summary: "x",
      decisions: [], blockers: [], surprises: [], deferred: [], nextSteps: [], openQuestions: [], suggestedAgent: null,
    };
    const summarizer = new FakeLLMSummarizer(fakeSummary);
    const svc = new SessionService(repo, stubExtractor(), {
      now: () => new Date("2026-05-12T10:43:00Z"),
      summarizer,
      resolveWorkerScript: () => "/fake/path/to/bin.js",
      spawnWorker: (cmd, args, cwd) => {
        spawned.push({ cmd, args, cwd });
        return { unref: () => undefined };
      },
    });
    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");
    const closed = await svc.close({ sessionId: opened.value.session.id, sync: false, noLlm: true });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.asyncDispatched).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(closed.value.handoffArticleId).toMatch(/^handoff-ses-/);
  });

  it("returns asyncDispatched=false when resolveWorkerScript returns null", async () => {
    const { FakeLLMSummarizer } = await import("../../../src/sessions/llm-summarizer.js");
    const fakeSummary = {
      tldr: "x", summary: "x",
      decisions: [], blockers: [], surprises: [], deferred: [], nextSteps: [], openQuestions: [], suggestedAgent: null,
    };
    const summarizer = new FakeLLMSummarizer(fakeSummary);
    const svc = new SessionService(repo, stubExtractor(), {
      now: () => new Date("2026-05-12T10:43:00Z"),
      summarizer,
      resolveWorkerScript: () => null, // can't resolve worker script
      spawnWorker: (cmd, args, cwd) => {
        spawned.push({ cmd, args, cwd });
        return { unref: () => undefined };
      },
    });
    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");
    const closed = await svc.close({ sessionId: opened.value.session.id, sync: false });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    // The session is closed, but no worker was dispatched and the handoff
    // article is missing. The next `session open` should surface this as an orphan.
    expect(closed.value.asyncDispatched).toBe(false);
    expect(closed.value.handoffArticleId).toBeNull();
    expect(spawned).toHaveLength(0);
  });
});

describe("SessionService.generateHandoff", () => {
  let repo: InMemorySessionRepository;

  beforeEach(() => {
    repo = new InMemorySessionRepository();
  });

  it("produces a handoff article for an already-closed session", async () => {
    const { FakeLLMSummarizer } = await import("../../../src/sessions/llm-summarizer.js");
    const fakeSummary = {
      tldr: "after the fact",
      summary: "ran in worker",
      decisions: [], blockers: [], surprises: [], deferred: [], nextSteps: [], openQuestions: [], suggestedAgent: null,
    };
    const summarizer = new FakeLLMSummarizer(fakeSummary, { score: 4, reasoning: "ok" });

    // First: close with sync=false and a null worker resolver to produce an
    // orphan session. Then re-attach a summarizer and run generateHandoff.
    const svcSync = new SessionService(repo, stubExtractor(), {
      now: () => new Date("2026-05-12T10:43:00Z"),
      summarizer,
      resolveWorkerScript: () => null, // disable dispatch — produce orphan
    });
    const opened = await svcSync.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");
    const closed = await svcSync.close({ sessionId: opened.value.session.id, sync: false });
    if (!closed.ok) throw new Error("close failed");
    expect(closed.value.handoffArticleId).toBeNull(); // orphan confirmed

    // Now run generateHandoff (simulating the worker subprocess).
    const result = await svcSync.generateHandoff(opened.value.session.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary?.tldr).toBe("after the fact");
    expect(result.value.evalResult?.score).toBe(4);
    expect(result.value.degraded).toBe(false);
    expect(result.value.handoffArticleId).toMatch(/^handoff-ses-/);
    expect(result.value.session.handoffArticleId).toBe(result.value.handoffArticleId);
  });

  it("returns StateTransitionError on an open session", async () => {
    const { FakeLLMSummarizer } = await import("../../../src/sessions/llm-summarizer.js");
    const summarizer = new FakeLLMSummarizer({
      tldr: "x", summary: "x",
      decisions: [], blockers: [], surprises: [], deferred: [], nextSteps: [], openQuestions: [], suggestedAgent: null,
    });
    const svc = new SessionService(repo, stubExtractor(), {
      now: () => new Date("2026-05-12T10:43:00Z"),
      summarizer,
    });
    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");
    const result = await svc.generateHandoff(opened.value.session.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("STATE_TRANSITION_INVALID");
  });

  it("returns NotFoundError for unknown session id", async () => {
    const svc = new SessionService(repo, stubExtractor(), {
      now: () => new Date("2026-05-12T10:43:00Z"),
    });
    const result = await svc.generateHandoff(sessionId("ses-nope"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("SessionService.open — orphan detection", () => {
  it("surfaces previousOrphan when last closed session has handoffArticleId=null", async () => {
    const repo = new InMemorySessionRepository();
    const svc = new SessionService(repo, stubExtractor(), {
      now: () => new Date("2026-05-12T10:43:00Z"),
      // No summarizer, no worker — close produces an orphan synchronously.
      resolveWorkerScript: () => null,
    });

    // First session: open + close (sync, no LLM → no summary, no orphan since handoff article is still made)
    const first = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!first.ok) throw new Error("open failed");
    // Force orphan by closing with sync=false + no summarizer + no worker resolution
    await svc.close({ sessionId: first.value.session.id, sync: false });

    // Bypass: directly clear handoffArticleId on the in-memory repo to simulate
    // a worker crash. (In production this happens naturally when the subprocess dies.)
    const closedAfter = await repo.findById(first.value.session.id);
    if (!closedAfter.ok) throw new Error("findById failed");
    // Hack: mutate via re-create. The in-memory repo's create overwrites.
    await repo.create({
      id: closedAfter.value.id,
      agentId: closedAfter.value.agentId,
      repo: closedAfter.value.repo,
      branch: closedAfter.value.branch,
      openedAt: closedAfter.value.openedAt,
      intent: closedAfter.value.intent,
      parentSessionId: closedAfter.value.parentSessionId,
    });
    await repo.close(closedAfter.value.id, {
      closedAt: closedAfter.value.closedAt ?? closedAfter.value.openedAt,
      factsPath: closedAfter.value.factsPath ?? "x.facts.json",
      qualityDegraded: true,
    });
    // (handoff NOT attached → orphan)

    // Second session: open should detect orphan.
    const second = await svc.open({
      agentId: agentId("claude-code"),
      repo: "/tmp/repo-a",
      openedAt: "2026-05-12T11:00:00Z",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.previousOrphan?.id).toBe(first.value.session.id);
  });

  it("returns previousOrphan=null when last closed has a handoff article", async () => {
    const { FakeLLMSummarizer } = await import("../../../src/sessions/llm-summarizer.js");
    const repo = new InMemorySessionRepository();
    const summarizer = new FakeLLMSummarizer({
      tldr: "x", summary: "x",
      decisions: [], blockers: [], surprises: [], deferred: [], nextSteps: [], openQuestions: [], suggestedAgent: null,
    });
    const svc = new SessionService(repo, stubExtractor(), {
      now: () => new Date("2026-05-12T10:43:00Z"),
      summarizer,
    });
    const first = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!first.ok) throw new Error("open failed");
    // Close sync → handoff attached
    await svc.close({ sessionId: first.value.session.id });

    const second = await svc.open({
      agentId: agentId("claude-code"),
      repo: "/tmp/repo-a",
      openedAt: "2026-05-12T11:00:00Z",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.previousOrphan).toBeNull();
  });
});

describe("SessionService.get / list", () => {
  let repo: InMemorySessionRepository;
  let svc: SessionService;

  beforeEach(() => {
    repo = new InMemorySessionRepository();
    svc = new SessionService(repo, stubExtractor(), { now: () => new Date("2026-05-12T10:43:00Z") });
  });

  it("get returns the session by id", async () => {
    const opened = await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    if (!opened.ok) throw new Error("open failed");
    const got = await svc.get(opened.value.session.id);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.id).toBe(opened.value.session.id);
  });

  it("list returns sessions matching filter", async () => {
    await svc.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
    const listed = await svc.list({ agentId: agentId("claude-code") });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
  });
});
