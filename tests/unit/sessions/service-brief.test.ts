import { describe, it, expect, beforeEach } from "vitest";
import { InMemorySessionRepository } from "../../../src/sessions/in-memory-repository.js";
import { SessionService } from "../../../src/sessions/service.js";
import { agentId, sessionId, slug as brandSlug, timestamp } from "../../../src/core/types.js";
import { SessionStatus, type SessionFacts } from "../../../src/sessions/schemas.js";
import { AbandonmentReason } from "../../../src/sessions/schemas.js";
import { ok, err } from "../../../src/core/result.js";
import { NotFoundError } from "../../../src/core/errors.js";
import type { FactsExtractor } from "../../../src/sessions/facts-extractor.js";
import type { KnowledgeService } from "../../../src/knowledge/service.js";
import type { KnowledgeArticle } from "../../../src/knowledge/repository.js";

const HANDOFF_BODY = `> **Session** \`ses-20260513-001000-claude-code\` · agent \`claude-code\` · 30 min
> Quality 4/5 (gemma4:latest)

## TL;DR

Shipped Phase 3d + 3e: lifted findRecent/findMany time filters to the repo layer.

## What happened

Two sibling phases shipped together because their call sites overlap.

### Decisions

- Bundle 3d + 3e into one feat commit, ship docs as a separate commit.

## What's next

### First action

**Open follow-up PR for Phase 4a (session brief CLI command).**

## Hypergraph

**Code touched** (top 3 of 8):
- \`src/orchestration/repository.ts\` (+5/-0)
- \`src/orchestration/in-memory-repository.ts\` (+13/-2)
- \`src/sessions/facts-extractor.ts\` (+12/-11)

Events in window: 4

## Facts (raw, for downstream LLM)

See [\`ses-20260513-001000-claude-code.facts.json\`](../sessions/ses-20260513-001000-claude-code.facts.json).
`;

function stubExtractor(): FactsExtractor {
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
      };
      return ok(facts);
    },
  };
}

function fakeKnowledgeService(articles: Record<string, string>): KnowledgeService {
  return {
    getArticle: async (id: string) => {
      const content = articles[id];
      if (content === undefined) return err(new NotFoundError("KnowledgeArticle", id));
      const article: KnowledgeArticle = {
        id: id as never,
        title: "Handoff: 2026-05-13",
        slug: brandSlug(`handoff-${id}`),
        category: "handoff",
        tags: ["session-handoff", "agent:claude-code"],
        codeRefs: [],
        references: [],
        content,
        createdAt: timestamp("2026-05-13T00:30:00Z"),
        updatedAt: timestamp("2026-05-13T00:30:00Z"),
      } as unknown as KnowledgeArticle;
      return ok(article);
    },
  } as unknown as KnowledgeService;
}

async function seedClosedSession(
  repo: InMemorySessionRepository,
  opts: { id: string; agentId: string; repo: string; openedAt: string; closedAt: string; handoffArticleId: string | null },
): Promise<void> {
  const created = await repo.create({
    id: sessionId(opts.id),
    agentId: agentId(opts.agentId),
    repo: opts.repo,
    branch: null,
    openedAt: timestamp(opts.openedAt),
    intent: null,
    parentSessionId: null,
  });
  if (!created.ok) throw new Error("seed create failed");
  const closed = await repo.close(sessionId(opts.id), {
    closedAt: timestamp(opts.closedAt),
    factsPath: `/tmp/fake/${opts.id}.facts.json`,
    qualityDegraded: false,
  });
  if (!closed.ok) throw new Error("seed close failed");
  if (opts.handoffArticleId !== null) {
    const attached = await repo.attachHandoff(sessionId(opts.id), {
      handoffArticleId: opts.handoffArticleId,
      qualityScore: 4,
      qualityModel: "gemma4:latest",
      qualityDegraded: false,
    });
    if (!attached.ok) throw new Error("seed attachHandoff failed");
  }
}

describe("SessionService.brief", () => {
  let repo: InMemorySessionRepository;
  let knowledge: KnowledgeService;
  let svc: SessionService;

  const SESSION_ID = "ses-20260513-001000-claude-code";
  const ARTICLE_ID = "k-handoff-001";

  beforeEach(async () => {
    repo = new InMemorySessionRepository();
    knowledge = fakeKnowledgeService({ [ARTICLE_ID]: HANDOFF_BODY });
    svc = new SessionService(repo, stubExtractor(), { knowledgeService: knowledge });
    await seedClosedSession(repo, {
      id: SESSION_ID,
      agentId: "claude-code",
      repo: "/tmp/repo-a",
      openedAt: "2026-05-13T00:00:00Z",
      closedAt: "2026-05-13T00:30:00Z",
      handoffArticleId: ARTICLE_ID,
    });
  });

  describe("depth=full", () => {
    it("returns the entire handoff article body", async () => {
      const result = await svc.brief({ sessionId: sessionId(SESSION_ID), depth: "full" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.body).toBe(HANDOFF_BODY);
      expect(result.value.session.id).toBe(SESSION_ID);
    });
  });

  describe("depth=standard", () => {
    it("includes the TL;DR, What's next, and Hypergraph sections", async () => {
      const result = await svc.brief({ sessionId: sessionId(SESSION_ID), depth: "standard" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.body).toContain("## TL;DR");
      expect(result.value.body).toContain("## What's next");
      expect(result.value.body).toContain("## Hypergraph");
    });

    it("omits the Facts pointer and the deep What-happened narrative", async () => {
      const result = await svc.brief({ sessionId: sessionId(SESSION_ID), depth: "standard" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.body).not.toContain("## Facts (raw, for downstream LLM)");
      expect(result.value.body).not.toContain("## What happened");
    });
  });

  describe("depth=teaser", () => {
    it("contains the TL;DR content", async () => {
      const result = await svc.brief({ sessionId: sessionId(SESSION_ID), depth: "teaser" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.body).toContain("Shipped Phase 3d + 3e");
    });

    it("does NOT include the full What happened narrative or Hypergraph table", async () => {
      const result = await svc.brief({ sessionId: sessionId(SESSION_ID), depth: "teaser" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.body).not.toContain("## What happened");
      expect(result.value.body).not.toContain("Events in window:");
    });
  });

  describe("resolution by (agentId, repo)", () => {
    it("returns the latest closed session when no sessionId is given", async () => {
      // Seed a second, newer closed session for the same agent
      const NEWER = "ses-20260513-020000-claude-code";
      await seedClosedSession(repo, {
        id: NEWER,
        agentId: "claude-code",
        repo: "/tmp/repo-a",
        openedAt: "2026-05-13T02:00:00Z",
        closedAt: "2026-05-13T02:15:00Z",
        handoffArticleId: ARTICLE_ID,
      });

      const result = await svc.brief({
        agentId: agentId("claude-code"),
        repo: "/tmp/repo-a",
        depth: "full",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.session.id).toBe(NEWER);
    });

    it("errors when no closed session exists for the given agent+repo", async () => {
      const result = await svc.brief({
        agentId: agentId("codex-cli"),
        repo: "/tmp/repo-a",
        depth: "full",
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("cross-agent delta via --since", () => {
    it("counts closed sessions from OTHER agents since the given timestamp", async () => {
      await seedClosedSession(repo, {
        id: "ses-20260513-010000-codex-cli",
        agentId: "codex-cli",
        repo: "/tmp/repo-a",
        openedAt: "2026-05-13T01:00:00Z",
        closedAt: "2026-05-13T01:10:00Z",
        handoffArticleId: ARTICLE_ID,
      });
      await seedClosedSession(repo, {
        id: "ses-20260513-015000-codex-cli",
        agentId: "codex-cli",
        repo: "/tmp/repo-a",
        openedAt: "2026-05-13T01:50:00Z",
        closedAt: "2026-05-13T01:55:00Z",
        handoffArticleId: ARTICLE_ID,
      });

      const result = await svc.brief({
        sessionId: sessionId(SESSION_ID),
        depth: "teaser",
        since: timestamp("2026-05-13T00:45:00Z"),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.crossAgentDelta).not.toBeNull();
      expect(result.value.crossAgentDelta?.byAgent).toEqual({
        "codex-cli": 2,
      });
    });

    it("returns null crossAgentDelta when --since is not provided", async () => {
      const result = await svc.brief({ sessionId: sessionId(SESSION_ID), depth: "teaser" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.crossAgentDelta).toBeNull();
    });
  });

  describe("orphan handling", () => {
    it("returns a degraded body when the session has no handoffArticleId", async () => {
      const ORPHAN = "ses-20260513-030000-claude-code";
      await seedClosedSession(repo, {
        id: ORPHAN,
        agentId: "claude-code",
        repo: "/tmp/repo-a",
        openedAt: "2026-05-13T03:00:00Z",
        closedAt: "2026-05-13T03:05:00Z",
        handoffArticleId: null,
      });

      const result = await svc.brief({ sessionId: sessionId(ORPHAN), depth: "standard" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.handoffArticle).toBeNull();
      expect(result.value.body).toContain(ORPHAN);
      expect(result.value.body.toLowerCase()).toContain("handoff");
    });
  });
});
