import { describe, it, expect, beforeEach } from "vitest";
import { InMemorySessionRepository } from "../../../src/sessions/in-memory-repository.js";
import {
  agentId,
  generateSessionId,
  sessionId,
  timestamp,
} from "../../../src/core/types.js";
import type { Session, CreateSessionRecord } from "../../../src/sessions/repository.js";
import { SessionStatus, AbandonmentReason, type SessionFacts } from "../../../src/sessions/schemas.js";
import { ErrorCode } from "../../../src/core/errors.js";

function makeCreate(overrides: Partial<CreateSessionRecord> = {}): CreateSessionRecord {
  return {
    id: generateSessionId("claude-code", new Date("2026-05-12T10:43:00Z")),
    agentId: agentId("claude-code"),
    repo: "/tmp/repo-a",
    branch: "main",
    openedAt: timestamp("2026-05-12T10:43:00Z"),
    intent: null,
    parentSessionId: null,
    ...overrides,
  };
}

function makeFacts(overrides: Partial<SessionFacts> = {}): SessionFacts {
  return {
    sessionId: "ses-test",
    agent: "claude-code",
    repo: "/tmp/repo-a",
    branch: "main",
    window: { openedAt: "2026-05-12T10:43:00Z", closedAt: "2026-05-12T11:30:00Z" },
    events: [],
    workTouched: [],
    knowledgeTouched: [],
    codeTouched: [],
    commits: [],
    signals: { todosAdded: [], questions: [], testFailures: [] },
    agentNote: null,
    ...overrides,
  };
}

describe("InMemorySessionRepository.create", () => {
  let repo: InMemorySessionRepository;
  beforeEach(() => {
    repo = new InMemorySessionRepository();
  });

  it("persists a session with status=open", async () => {
    const result = await repo.create(makeCreate());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe(SessionStatus.OPEN);
  });

  it("preserves the id, agentId, repo, branch, openedAt, intent, parentSessionId", async () => {
    const input = makeCreate({
      intent: "Land M3 phase 5",
      parentSessionId: sessionId("ses-prev"),
      branch: "feature/foo",
    });
    const result = await repo.create(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(input.id);
    expect(result.value.agentId).toBe(input.agentId);
    expect(result.value.repo).toBe(input.repo);
    expect(result.value.branch).toBe("feature/foo");
    expect(result.value.openedAt).toBe(input.openedAt);
    expect(result.value.intent).toBe("Land M3 phase 5");
    expect(result.value.parentSessionId).toBe("ses-prev");
  });

  it("initializes closedAt, handoffArticleId, factsPath, abandonReason as null", async () => {
    const result = await repo.create(makeCreate());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.closedAt).toBeNull();
    expect(result.value.handoffArticleId).toBeNull();
    expect(result.value.factsPath).toBeNull();
    expect(result.value.abandonReason).toBeNull();
  });

  it("initializes quality with writer='ollama' (ADR-019 default for backward compat)", async () => {
    const result = await repo.create(makeCreate());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quality).toEqual({
      score: null,
      degraded: false,
      model: null,
      writer: "ollama",
    });
  });
});

describe("InMemorySessionRepository.findById", () => {
  let repo: InMemorySessionRepository;
  beforeEach(() => {
    repo = new InMemorySessionRepository();
  });

  it("returns the persisted session", async () => {
    const created = await repo.create(makeCreate());
    if (!created.ok) throw new Error("create failed");
    const found = await repo.findById(created.value.id);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toEqual(created.value);
  });

  it("returns NotFoundError for unknown id", async () => {
    const result = await repo.findById(sessionId("ses-does-not-exist"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("InMemorySessionRepository.close", () => {
  let repo: InMemorySessionRepository;
  let openSession: Session;
  beforeEach(async () => {
    repo = new InMemorySessionRepository();
    const created = await repo.create(makeCreate());
    if (!created.ok) throw new Error("create failed");
    openSession = created.value;
  });

  it("transitions status to closed and stamps closedAt", async () => {
    const result = await repo.close(openSession.id, {
      closedAt: timestamp("2026-05-12T11:30:00Z"),
      factsPath: "ses-x.facts.json",
      qualityDegraded: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe(SessionStatus.CLOSED);
    expect(result.value.closedAt).toBe("2026-05-12T11:30:00Z");
    expect(result.value.factsPath).toBe("ses-x.facts.json");
    expect(result.value.quality.degraded).toBe(false);
  });

  it("sets quality.degraded=true when passed", async () => {
    const result = await repo.close(openSession.id, {
      closedAt: timestamp("2026-05-12T11:30:00Z"),
      factsPath: "ses-x.facts.json",
      qualityDegraded: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quality.degraded).toBe(true);
  });

  it("returns NotFoundError for unknown id", async () => {
    const result = await repo.close(sessionId("ses-nope"), {
      closedAt: timestamp(),
      factsPath: "x.facts.json",
      qualityDegraded: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects close on an already-abandoned session", async () => {
    await repo.abandon(openSession.id, {
      closedAt: timestamp(),
      reason: AbandonmentReason.MANUAL,
    });
    const result = await repo.close(openSession.id, {
      closedAt: timestamp(),
      factsPath: "x.facts.json",
      qualityDegraded: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.STATE_TRANSITION_INVALID);
  });
});

describe("InMemorySessionRepository.abandon", () => {
  let repo: InMemorySessionRepository;
  let openSession: Session;
  beforeEach(async () => {
    repo = new InMemorySessionRepository();
    const created = await repo.create(makeCreate());
    if (!created.ok) throw new Error("create failed");
    openSession = created.value;
  });

  it("transitions status to abandoned and records reason", async () => {
    const result = await repo.abandon(openSession.id, {
      closedAt: timestamp("2026-05-12T12:00:00Z"),
      reason: AbandonmentReason.SUPERSEDED,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe(SessionStatus.ABANDONED);
    expect(result.value.abandonReason).toBe(AbandonmentReason.SUPERSEDED);
    expect(result.value.closedAt).toBe("2026-05-12T12:00:00Z");
  });

  it("rejects abandon on a closed session", async () => {
    await repo.close(openSession.id, {
      closedAt: timestamp(),
      factsPath: "x.facts.json",
      qualityDegraded: false,
    });
    const result = await repo.abandon(openSession.id, {
      closedAt: timestamp(),
      reason: AbandonmentReason.MANUAL,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.STATE_TRANSITION_INVALID);
  });
});

describe("InMemorySessionRepository.attachHandoff", () => {
  let repo: InMemorySessionRepository;
  let closedSession: Session;
  beforeEach(async () => {
    repo = new InMemorySessionRepository();
    const created = await repo.create(makeCreate());
    if (!created.ok) throw new Error("create failed");
    const closed = await repo.close(created.value.id, {
      closedAt: timestamp("2026-05-12T11:30:00Z"),
      factsPath: "ses-x.facts.json",
      qualityDegraded: false,
    });
    if (!closed.ok) throw new Error("close failed");
    closedSession = closed.value;
  });

  it("attaches a handoff article id and quality metadata", async () => {
    const result = await repo.attachHandoff(closedSession.id, {
      handoffArticleId: "handoff-ses-x",
      qualityScore: 4,
      qualityModel: "qwen2.5-coder:7b",
      qualityDegraded: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.handoffArticleId).toBe("handoff-ses-x");
    expect(result.value.quality.score).toBe(4);
    expect(result.value.quality.model).toBe("qwen2.5-coder:7b");
    expect(result.value.quality.degraded).toBe(false);
  });

  it("rejects attach on an open session", async () => {
    const fresh = await repo.create(makeCreate({ id: sessionId("ses-fresh") }));
    if (!fresh.ok) throw new Error("create failed");
    const result = await repo.attachHandoff(fresh.value.id, {
      handoffArticleId: "x",
      qualityScore: 3,
      qualityModel: "m",
      qualityDegraded: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.STATE_TRANSITION_INVALID);
  });
});

describe("InMemorySessionRepository.findOpen", () => {
  let repo: InMemorySessionRepository;
  beforeEach(() => {
    repo = new InMemorySessionRepository();
  });

  it("returns null when no open session exists for the (agent, repo)", async () => {
    const result = await repo.findOpen(agentId("claude-code"), "/tmp/repo-a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("returns the open session for matching (agent, repo)", async () => {
    const created = await repo.create(makeCreate());
    if (!created.ok) throw new Error("create failed");
    const found = await repo.findOpen(agentId("claude-code"), "/tmp/repo-a");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.id).toBe(created.value.id);
  });

  it("does not return a session for a different agent", async () => {
    await repo.create(makeCreate({ agentId: agentId("codex-cli") }));
    const found = await repo.findOpen(agentId("claude-code"), "/tmp/repo-a");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toBeNull();
  });

  it("does not return a session for a different repo", async () => {
    await repo.create(makeCreate({ repo: "/tmp/repo-b" }));
    const found = await repo.findOpen(agentId("claude-code"), "/tmp/repo-a");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toBeNull();
  });

  it("does not return a closed session", async () => {
    const created = await repo.create(makeCreate());
    if (!created.ok) throw new Error("create failed");
    await repo.close(created.value.id, {
      closedAt: timestamp(),
      factsPath: "x.facts.json",
      qualityDegraded: false,
    });
    const found = await repo.findOpen(agentId("claude-code"), "/tmp/repo-a");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toBeNull();
  });
});

describe("InMemorySessionRepository.findLatestClosed", () => {
  let repo: InMemorySessionRepository;
  beforeEach(() => {
    repo = new InMemorySessionRepository();
  });

  it("returns null when no closed session exists for the (agent, repo)", async () => {
    const result = await repo.findLatestClosed(agentId("claude-code"), "/tmp/repo-a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("returns the most-recent closed session by closedAt", async () => {
    // older
    const a = await repo.create(makeCreate({ id: sessionId("ses-a"), openedAt: timestamp("2026-05-10T09:00:00Z") }));
    if (!a.ok) throw new Error("create a failed");
    await repo.close(a.value.id, {
      closedAt: timestamp("2026-05-10T10:00:00Z"),
      factsPath: "a.facts.json",
      qualityDegraded: false,
    });
    // newer
    const b = await repo.create(makeCreate({ id: sessionId("ses-b"), openedAt: timestamp("2026-05-11T09:00:00Z") }));
    if (!b.ok) throw new Error("create b failed");
    await repo.close(b.value.id, {
      closedAt: timestamp("2026-05-11T10:00:00Z"),
      factsPath: "b.facts.json",
      qualityDegraded: false,
    });

    const latest = await repo.findLatestClosed(agentId("claude-code"), "/tmp/repo-a");
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value?.id).toBe("ses-b");
  });

  it("ignores abandoned sessions", async () => {
    const a = await repo.create(makeCreate({ id: sessionId("ses-a") }));
    if (!a.ok) throw new Error("create failed");
    await repo.abandon(a.value.id, {
      closedAt: timestamp("2026-05-11T10:00:00Z"),
      reason: AbandonmentReason.SUPERSEDED,
    });
    const latest = await repo.findLatestClosed(agentId("claude-code"), "/tmp/repo-a");
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value).toBeNull();
  });
});

describe("InMemorySessionRepository.findMany", () => {
  let repo: InMemorySessionRepository;
  beforeEach(() => {
    repo = new InMemorySessionRepository();
  });

  it("returns all sessions when filter is empty", async () => {
    await repo.create(makeCreate({ id: sessionId("ses-a") }));
    await repo.create(makeCreate({ id: sessionId("ses-b"), agentId: agentId("codex-cli") }));
    const result = await repo.findMany();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
  });

  it("filters by agentId", async () => {
    await repo.create(makeCreate({ id: sessionId("ses-a") }));
    await repo.create(makeCreate({ id: sessionId("ses-b"), agentId: agentId("codex-cli") }));
    const result = await repo.findMany({ agentId: agentId("codex-cli") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.agentId).toBe("codex-cli");
  });

  it("filters by status", async () => {
    const a = await repo.create(makeCreate({ id: sessionId("ses-a") }));
    if (!a.ok) throw new Error("create failed");
    await repo.create(makeCreate({ id: sessionId("ses-b") })); // stays open
    await repo.close(a.value.id, {
      closedAt: timestamp(),
      factsPath: "a.facts.json",
      qualityDegraded: false,
    });
    const result = await repo.findMany({ status: SessionStatus.OPEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.id).toBe("ses-b");
  });

  it("respects limit", async () => {
    await repo.create(makeCreate({ id: sessionId("ses-a") }));
    await repo.create(makeCreate({ id: sessionId("ses-b") }));
    await repo.create(makeCreate({ id: sessionId("ses-c") }));
    const result = await repo.findMany({ limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
  });

  it("returns newest-first by openedAt", async () => {
    await repo.create(makeCreate({ id: sessionId("ses-old"), openedAt: timestamp("2026-05-01T00:00:00Z") }));
    await repo.create(makeCreate({ id: sessionId("ses-new"), openedAt: timestamp("2026-05-11T00:00:00Z") }));
    const result = await repo.findMany();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.id).toBe("ses-new");
    expect(result.value[1]?.id).toBe("ses-old");
  });
});

describe("InMemorySessionRepository.saveFacts / loadFacts", () => {
  let repo: InMemorySessionRepository;
  beforeEach(() => {
    repo = new InMemorySessionRepository();
  });

  it("returns a synthetic path for saved facts (in-memory)", async () => {
    const result = await repo.saveFacts(sessionId("ses-x"), makeFacts({ sessionId: "ses-x" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatch(/ses-x/);
  });

  it("can read back saved facts", async () => {
    const facts = makeFacts({ sessionId: "ses-x", agentNote: "hello" });
    await repo.saveFacts(sessionId("ses-x"), facts);
    const loaded = await repo.loadFacts(sessionId("ses-x"));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.agentNote).toBe("hello");
  });

  it("loadFacts returns NotFoundError when nothing saved", async () => {
    const loaded = await repo.loadFacts(sessionId("ses-nope"));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});
