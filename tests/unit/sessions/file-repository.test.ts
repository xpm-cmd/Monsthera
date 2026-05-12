import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSystemSessionRepository } from "../../../src/sessions/file-repository.js";
import { agentId, generateSessionId, sessionId, timestamp } from "../../../src/core/types.js";
import type { CreateSessionRecord } from "../../../src/sessions/repository.js";
import { SessionStatus, AbandonmentReason, type SessionFacts } from "../../../src/sessions/schemas.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "monsthera-sessions-"));
}

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

describe("FileSystemSessionRepository", () => {
  let root: string;
  let repo: FileSystemSessionRepository;

  beforeEach(async () => {
    root = await tmpDir();
    repo = new FileSystemSessionRepository(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes a .json file under <markdownRoot>/sessions/<id>.json on create", async () => {
    // Storage deviation from original spec: Session records are JSON, not
    // YAML-frontmatter Markdown. See FileSystemSessionRepository class doc
    // for rationale (existing markdown serializer can't round-trip nulls
    // or nested objects without a YAML library).
    //
    // Path note: the `root` in this test plays the role of `markdownRoot`
    // (which already includes the `knowledge` segment from config). Mirroring
    // the work/knowledge repos, sessions live at `<markdownRoot>/sessions/`.
    const input = makeCreate();
    const created = await repo.create(input);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const filePath = path.join(root, "sessions", `${input.id}.json`);
    const exists = await fs.stat(filePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("persists frontmatter + body that round-trips through findById", async () => {
    const input = makeCreate({
      intent: "Land M3 phase 5",
      parentSessionId: sessionId("ses-prev"),
      branch: "feature/foo",
    });
    const created = await repo.create(input);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const found = await repo.findById(input.id);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.id).toBe(input.id);
    expect(found.value.agentId).toBe("claude-code");
    expect(found.value.intent).toBe("Land M3 phase 5");
    expect(found.value.parentSessionId).toBe("ses-prev");
    expect(found.value.branch).toBe("feature/foo");
    expect(found.value.status).toBe(SessionStatus.OPEN);
  });

  it("close() updates status, closedAt, factsPath on disk", async () => {
    const input = makeCreate();
    await repo.create(input);
    const closed = await repo.close(input.id, {
      closedAt: timestamp("2026-05-12T11:30:00Z"),
      factsPath: `${input.id}.facts.json`,
      qualityDegraded: false,
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.status).toBe(SessionStatus.CLOSED);

    // Re-read from disk to confirm persistence
    const reloaded = await repo.findById(input.id);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.status).toBe(SessionStatus.CLOSED);
    expect(reloaded.value.closedAt).toBe("2026-05-12T11:30:00Z");
    expect(reloaded.value.factsPath).toBe(`${input.id}.facts.json`);
    expect(reloaded.value.quality.degraded).toBe(false);
  });

  it("abandon() persists status + reason", async () => {
    const input = makeCreate();
    await repo.create(input);
    await repo.abandon(input.id, {
      closedAt: timestamp("2026-05-12T12:00:00Z"),
      reason: AbandonmentReason.SUPERSEDED,
    });
    const reloaded = await repo.findById(input.id);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.status).toBe(SessionStatus.ABANDONED);
    expect(reloaded.value.abandonReason).toBe(AbandonmentReason.SUPERSEDED);
  });

  it("attachHandoff persists handoffArticleId + quality", async () => {
    const input = makeCreate();
    await repo.create(input);
    await repo.close(input.id, {
      closedAt: timestamp(),
      factsPath: `${input.id}.facts.json`,
      qualityDegraded: false,
    });
    await repo.attachHandoff(input.id, {
      handoffArticleId: "handoff-ses-x",
      qualityScore: 4,
      qualityModel: "qwen2.5-coder:7b",
      qualityDegraded: false,
    });
    const reloaded = await repo.findById(input.id);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.handoffArticleId).toBe("handoff-ses-x");
    expect(reloaded.value.quality.score).toBe(4);
    expect(reloaded.value.quality.model).toBe("qwen2.5-coder:7b");
  });

  it("findMany returns all sessions newest-first", async () => {
    const a = makeCreate({ id: sessionId("ses-old"), openedAt: timestamp("2026-05-01T00:00:00Z") });
    const b = makeCreate({ id: sessionId("ses-new"), openedAt: timestamp("2026-05-11T00:00:00Z") });
    await repo.create(a);
    await repo.create(b);
    const result = await repo.findMany();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.id)).toEqual(["ses-new", "ses-old"]);
  });

  it("findOpen returns the open session for (agent, repo)", async () => {
    const a = makeCreate({ id: sessionId("ses-a") });
    await repo.create(a);
    const found = await repo.findOpen(agentId("claude-code"), "/tmp/repo-a");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.id).toBe("ses-a");
  });

  it("findLatestClosed returns the most recent closed session", async () => {
    const a = makeCreate({ id: sessionId("ses-a") });
    const b = makeCreate({ id: sessionId("ses-b") });
    await repo.create(a);
    await repo.create(b);
    await repo.close(a.id, { closedAt: timestamp("2026-05-10T00:00:00Z"), factsPath: "a.facts.json", qualityDegraded: false });
    await repo.close(b.id, { closedAt: timestamp("2026-05-11T00:00:00Z"), factsPath: "b.facts.json", qualityDegraded: false });
    const latest = await repo.findLatestClosed(agentId("claude-code"), "/tmp/repo-a");
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value?.id).toBe("ses-b");
  });

  it("saveFacts persists JSON, loadFacts reads it back", async () => {
    const a = makeCreate({ id: sessionId("ses-a") });
    await repo.create(a);
    const facts = makeFacts({ sessionId: "ses-a", agentNote: "hello" });
    const saved = await repo.saveFacts(a.id, facts);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value).toContain("ses-a.facts.json");

    // File should physically exist
    const exists = await fs.stat(saved.value).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const loaded = await repo.loadFacts(a.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.agentNote).toBe("hello");
  });
});
