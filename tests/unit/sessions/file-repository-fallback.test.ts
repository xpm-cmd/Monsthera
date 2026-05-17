import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileSystemSessionRepository } from "../../../src/sessions/file-repository.js";
import { SessionStatus, type SessionFacts } from "../../../src/sessions/schemas.js";
import { agentId, sessionId, timestamp } from "../../../src/core/types.js";

/**
 * Worktree fallback tests for FileSystemSessionRepository.
 *
 * Layout: two on-disk knowledge roots simulate the worktree (primary)
 * and the main repo (fallback). The repo is constructed with both;
 * each test seeds files into one or both dirs and asserts the read /
 * write behaviour.
 */

interface SeedSession {
  readonly id: string;
  readonly agentId?: string;
  readonly repo?: string;
  readonly openedAt?: string;
  readonly closedAt?: string | null;
  readonly status?: SessionStatus;
  readonly handoffArticleId?: string | null;
  readonly intent?: string | null;
}

async function seed(dir: string, s: SeedSession): Promise<void> {
  const fm = {
    id: s.id,
    agentId: s.agentId ?? "claude-code",
    repo: s.repo ?? "/tmp/repo",
    branch: null,
    openedAt: s.openedAt ?? "2026-05-15T10:00:00Z",
    closedAt: s.closedAt === undefined ? "2026-05-15T11:00:00Z" : s.closedAt,
    status: s.status ?? SessionStatus.CLOSED,
    handoffArticleId: s.handoffArticleId ?? null,
    factsPath: null,
    parentSessionId: null,
    abandonReason: null,
    quality: { score: null, degraded: false, model: null },
    intent: s.intent ?? null,
  };
  await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "sessions", `${s.id}.json`),
    JSON.stringify(fm, null, 2),
    "utf-8",
  );
}

let primary: string;
let fallback: string;

beforeEach(async () => {
  primary = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-fallback-primary-"));
  fallback = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-fallback-fallback-"));
});

afterEach(async () => {
  await fs.rm(primary, { recursive: true, force: true });
  await fs.rm(fallback, { recursive: true, force: true });
});

describe("FileSystemSessionRepository — worktree fallback", () => {
  describe("findLatestClosed", () => {
    it("returns the fallback's session when the primary has none for that agent+repo", async () => {
      await seed(fallback, {
        id: "ses-20260514-100000-claude-code",
        repo: "/tmp/repo",
        closedAt: "2026-05-14T11:00:00Z",
      });
      const repo = new FileSystemSessionRepository(primary, fallback);
      const found = await repo.findLatestClosed(agentId("claude-code"), "/tmp/repo");
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value).not.toBeNull();
      expect(found.value!.id).toBe("ses-20260514-100000-claude-code");
    });

    it("prefers primary over fallback when both have closed sessions for the same agent+repo", async () => {
      await seed(primary, {
        id: "ses-20260516-100000-claude-code",
        repo: "/tmp/repo",
        closedAt: "2026-05-16T10:30:00Z",
      });
      await seed(fallback, {
        id: "ses-20260514-100000-claude-code",
        repo: "/tmp/repo",
        closedAt: "2026-05-14T11:00:00Z",
      });
      const repo = new FileSystemSessionRepository(primary, fallback);
      const found = await repo.findLatestClosed(agentId("claude-code"), "/tmp/repo");
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      // Primary's session is more recent; that's the parent.
      expect(found.value!.id).toBe("ses-20260516-100000-claude-code");
    });

    it("returns the most recent across primary + fallback (closedAt sort beats filesystem origin)", async () => {
      await seed(primary, {
        id: "ses-20260510-100000-claude-code",
        repo: "/tmp/repo",
        closedAt: "2026-05-10T10:30:00Z",
      });
      await seed(fallback, {
        id: "ses-20260515-100000-claude-code",
        repo: "/tmp/repo",
        closedAt: "2026-05-15T10:30:00Z",
      });
      const repo = new FileSystemSessionRepository(primary, fallback);
      const found = await repo.findLatestClosed(agentId("claude-code"), "/tmp/repo");
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value!.id).toBe("ses-20260515-100000-claude-code");
    });
  });

  describe("findOpen", () => {
    it("does NOT consult fallback (open sessions are per-worktree)", async () => {
      await seed(fallback, {
        id: "ses-20260516-100000-claude-code",
        repo: "/tmp/repo",
        status: SessionStatus.OPEN,
        closedAt: null,
      });
      const repo = new FileSystemSessionRepository(primary, fallback);
      const found = await repo.findOpen(agentId("claude-code"), "/tmp/repo");
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      // Fallback session is open but we MUST NOT find it: an open session
      // in another worktree is not ours to supersede.
      expect(found.value).toBeNull();
    });

    it("finds open session in primary (status quo unchanged)", async () => {
      await seed(primary, {
        id: "ses-20260516-100000-claude-code",
        repo: "/tmp/repo",
        status: SessionStatus.OPEN,
        closedAt: null,
      });
      const repo = new FileSystemSessionRepository(primary, fallback);
      const found = await repo.findOpen(agentId("claude-code"), "/tmp/repo");
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value).not.toBeNull();
      expect(found.value!.id).toBe("ses-20260516-100000-claude-code");
    });
  });

  describe("findById", () => {
    it("returns the session from primary when it exists there", async () => {
      await seed(primary, { id: "ses-A" });
      const repo = new FileSystemSessionRepository(primary, fallback);
      const found = await repo.findById(sessionId("ses-A"));
      expect(found.ok).toBe(true);
    });

    it("falls back when the session is only in the fallback dir", async () => {
      await seed(fallback, { id: "ses-B" });
      const repo = new FileSystemSessionRepository(primary, fallback);
      const found = await repo.findById(sessionId("ses-B"));
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value.id).toBe("ses-B");
    });

    it("returns NotFoundError when neither dir has the session", async () => {
      const repo = new FileSystemSessionRepository(primary, fallback);
      const found = await repo.findById(sessionId("ses-missing"));
      expect(found.ok).toBe(false);
      if (found.ok) return;
      expect(found.error.code).toBe("NOT_FOUND");
    });
  });

  describe("findMany", () => {
    it("merges sessions from primary + fallback, deduplicating by id", async () => {
      await seed(primary, { id: "ses-A", openedAt: "2026-05-15T10:00:00Z" });
      await seed(fallback, { id: "ses-A", openedAt: "2026-05-14T10:00:00Z" });
      await seed(fallback, { id: "ses-B", openedAt: "2026-05-13T10:00:00Z" });

      const repo = new FileSystemSessionRepository(primary, fallback);
      const found = await repo.findMany();
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      // Primary wins for ses-A; ses-B comes from fallback.
      expect(found.value.length).toBe(2);
      const ids = found.value.map((s) => s.id);
      expect(ids).toContain("ses-A");
      expect(ids).toContain("ses-B");
      // Primary's ses-A has the newer openedAt; verify primary won.
      const sesA = found.value.find((s) => s.id === "ses-A");
      expect(sesA!.openedAt).toBe("2026-05-15T10:00:00Z");
    });

    it("respects the limit filter across the merged set", async () => {
      await seed(primary, { id: "ses-P1", openedAt: "2026-05-15T10:00:00Z" });
      await seed(fallback, { id: "ses-F1", openedAt: "2026-05-14T10:00:00Z" });
      await seed(fallback, { id: "ses-F2", openedAt: "2026-05-13T10:00:00Z" });

      const repo = new FileSystemSessionRepository(primary, fallback);
      const found = await repo.findMany({ limit: 2 });
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value.length).toBe(2);
      // Sort is newest-first by openedAt.
      expect(found.value[0]!.id).toBe("ses-P1");
      expect(found.value[1]!.id).toBe("ses-F1");
    });
  });

  describe("writes do not touch the fallback dir", () => {
    it("create() writes only to primary", async () => {
      const repo = new FileSystemSessionRepository(primary, fallback);
      const created = await repo.create({
        id: sessionId("ses-NEW"),
        agentId: agentId("claude-code"),
        repo: "/tmp/repo",
        branch: null,
        openedAt: timestamp("2026-05-16T10:00:00Z"),
        intent: null,
        parentSessionId: null,
      });
      expect(created.ok).toBe(true);

      const primaryFiles = await fs.readdir(path.join(primary, "sessions"));
      const fallbackFiles = await fs.readdir(fallback).catch(() => []);
      expect(primaryFiles).toContain("ses-NEW.json");
      // Fallback root has no sessions dir created by writes.
      expect(fallbackFiles).not.toContain("sessions");
    });

    it("close() writes the updated session to primary even when the source lives in fallback", async () => {
      await seed(fallback, {
        id: "ses-FROM-FALLBACK",
        status: SessionStatus.OPEN,
        closedAt: null,
      });
      const repo = new FileSystemSessionRepository(primary, fallback);
      const closed = await repo.close(sessionId("ses-FROM-FALLBACK"), {
        closedAt: timestamp("2026-05-16T12:00:00Z"),
        factsPath: "/tmp/facts.json",
        qualityDegraded: true,
      });
      // Behaviour: the read sees the fallback session, writes go to primary.
      // The fallback file stays untouched; primary now has the closed copy.
      expect(closed.ok).toBe(true);
      const primaryFiles = await fs.readdir(path.join(primary, "sessions"));
      expect(primaryFiles).toContain("ses-FROM-FALLBACK.json");
    });
  });

  describe("loadFacts", () => {
    it("loads facts from fallback when primary has no facts file", async () => {
      // Seed the session record on primary (so it's discoverable) and
      // the facts.json on fallback (simulating partial migration).
      await seed(primary, { id: "ses-X" });
      const facts: SessionFacts = {
        sessionId: "ses-X",
        agent: "claude-code",
        repo: "/tmp/repo",
        branch: null,
        window: { openedAt: "2026-05-15T10:00:00Z", closedAt: "2026-05-15T11:00:00Z" },
        events: [],
        workTouched: [],
        knowledgeTouched: [],
        codeTouched: [],
        commits: [],
        signals: { todosAdded: [], questions: [], testFailures: [] },
        agentNote: null,
      };
      await fs.mkdir(path.join(fallback, "sessions"), { recursive: true });
      await fs.writeFile(
        path.join(fallback, "sessions", "ses-X.facts.json"),
        JSON.stringify(facts, null, 2),
        "utf-8",
      );
      const repo = new FileSystemSessionRepository(primary, fallback);
      const loaded = await repo.loadFacts(sessionId("ses-X"));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.sessionId).toBe("ses-X");
    });
  });
});

describe("FileSystemSessionRepository — no fallback (regression guard)", () => {
  it("default constructor (no second arg) keeps pre-fallback behaviour", async () => {
    await seed(primary, { id: "ses-only-primary" });
    await seed(fallback, { id: "ses-only-fallback" });
    const repo = new FileSystemSessionRepository(primary); // no fallback
    const all = await repo.findMany();
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.length).toBe(1);
    expect(all.value[0]!.id).toBe("ses-only-primary");
  });
});
