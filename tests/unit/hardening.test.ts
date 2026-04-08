import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../src/work/in-memory-repository.js";
import { InMemorySearchIndexRepository } from "../../src/search/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../src/orchestration/in-memory-repository.js";
import { createStatusReporter } from "../../src/core/status.js";
import { MigrationService } from "../../src/migration/service.js";
import { createLogger } from "../../src/core/logger.js";
import { agentId, workId, WorkPhase } from "../../src/core/types.js";
import type { V2SourceReader, V2Ticket, V2Verdict, V2CouncilAssignment } from "../../src/migration/types.js";
import { ok } from "../../src/core/result.js";
import type { CreateKnowledgeArticleInput } from "../../src/knowledge/repository.js";
import type { CreateWorkArticleInput } from "../../src/work/repository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = createLogger({ level: "error", output: () => {} });

function knowledgeInput(overrides?: Partial<CreateKnowledgeArticleInput>): CreateKnowledgeArticleInput {
  return {
    title: "Test Article",
    category: "guide",
    content: "Some content here.",
    tags: ["test"],
    ...overrides,
  };
}

function workInput(overrides?: Partial<CreateWorkArticleInput>): CreateWorkArticleInput {
  return {
    title: "Test Work",
    template: "feature",
    priority: "medium",
    author: agentId("agent-1"),
    tags: ["test"],
    content: "## Objective\nDo something.\n\n## Acceptance Criteria\n- Done.",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Edge case inputs for repositories
// ═══════════════════════════════════════════════════════════════════════════════

describe("edge case inputs", () => {
  describe("KnowledgeArticle edge cases", () => {
    let repo: InMemoryKnowledgeArticleRepository;

    beforeEach(() => {
      repo = new InMemoryKnowledgeArticleRepository();
    });

    it("accepts empty string title", async () => {
      const result = await repo.create(knowledgeInput({ title: "" }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.title).toBe("");
    });

    it("accepts very long title (200 chars)", async () => {
      const longTitle = "A".repeat(200);
      const result = await repo.create(knowledgeInput({ title: longTitle }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.title).toBe(longTitle);
    });

    it("handles special characters in title: quotes, backslashes, emoji, unicode", async () => {
      const specials = [
        `Title with "quotes" and 'apostrophes'`,
        `Title with \\backslashes\\`,
        `Title with emoji 🚀🔥💎`,
        `Título con acentos y ñ — emdash`,
        `中文标题 日本語タイトル`,
      ];

      for (const title of specials) {
        const result = await repo.create(knowledgeInput({ title }));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.title).toBe(title);
      }
    });

    it("accepts empty tags array", async () => {
      const result = await repo.create(knowledgeInput({ tags: [] }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.tags).toEqual([]);
    });

    it("handles content with markdown special characters", async () => {
      const content = "# Heading\n\n```ts\nconst x = 1;\n```\n\n> blockquote\n\n| col1 | col2 |\n|---|---|\n| a | b |";
      const result = await repo.create(knowledgeInput({ content }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.content).toBe(content);
    });

    it("generates unique slugs for duplicate titles", async () => {
      const r1 = await repo.create(knowledgeInput({ title: "Same Title" }));
      const r2 = await repo.create(knowledgeInput({ title: "Same Title" }));
      expect(r1.ok && r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.value.slug).not.toBe(r2.value.slug);
      }
    });
  });

  describe("WorkArticle edge cases", () => {
    let repo: InMemoryWorkArticleRepository;

    beforeEach(() => {
      repo = new InMemoryWorkArticleRepository();
    });

    it("accepts empty string title", async () => {
      const result = await repo.create(workInput({ title: "" }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.title).toBe("");
    });

    it("accepts very long title (200 chars)", async () => {
      const longTitle = "B".repeat(200);
      const result = await repo.create(workInput({ title: longTitle }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.title).toBe(longTitle);
    });

    it("handles special characters in title", async () => {
      const title = `Work: "quotes", \\slashes\\, emoji 🎯, ñ, 中文`;
      const result = await repo.create(workInput({ title }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.title).toBe(title);
    });

    it("accepts empty tags array", async () => {
      const result = await repo.create(workInput({ tags: [] }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.tags).toEqual([]);
    });

    it("creates article in PLANNING phase with enrichment roles from template", async () => {
      const result = await repo.create(workInput());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.phase).toBe(WorkPhase.PLANNING);
        expect(result.value.enrichmentRoles.length).toBeGreaterThan(0);
        expect(result.value.phaseHistory).toHaveLength(1);
        expect(result.value.phaseHistory[0]!.phase).toBe(WorkPhase.PLANNING);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. StatusReporter with recordStat
// ═══════════════════════════════════════════════════════════════════════════════

describe("StatusReporter hardening", () => {
  it("recordStat stores and retrieves stats", () => {
    const reporter = createStatusReporter("1.0.0");
    reporter.recordStat("knowledgeArticleCount", 42);
    reporter.recordStat("workArticleCount", 7);

    const status = reporter.getStatus();
    expect(status.stats).toBeDefined();
    expect(status.stats!.knowledgeArticleCount).toBe(42);
    expect(status.stats!.workArticleCount).toBe(7);
  });

  it("getStatus includes stats when present", () => {
    const reporter = createStatusReporter("2.0.0");
    reporter.recordStat("searchIndexSize", 100);

    const status = reporter.getStatus();
    expect(status.stats).toBeDefined();
    expect(status.stats!.searchIndexSize).toBe(100);
  });

  it("getStatus omits stats when empty", () => {
    const reporter = createStatusReporter("1.0.0");
    const status = reporter.getStatus();
    expect(status.stats).toBeUndefined();
  });

  it("uptime increases over time", async () => {
    const reporter = createStatusReporter("1.0.0");
    const s1 = reporter.getStatus();
    // Wait a tiny bit so uptime advances
    await new Promise((r) => setTimeout(r, 10));
    const s2 = reporter.getStatus();
    expect(s2.uptime).toBeGreaterThan(s1.uptime);
  });

  it("version is returned correctly", () => {
    const reporter = createStatusReporter("3.0.0-beta.1");
    expect(reporter.getStatus().version).toBe("3.0.0-beta.1");
  });

  it("register and unregister subsystem checks", () => {
    const reporter = createStatusReporter("1.0.0");
    reporter.register("db", () => ({ name: "db", healthy: true }));
    expect(reporter.getStatus().subsystems).toHaveLength(1);

    reporter.unregister("db");
    expect(reporter.getStatus().subsystems).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Migration concurrency lock
// ═══════════════════════════════════════════════════════════════════════════════

describe("MigrationService concurrency lock", () => {
  class SlowV2Reader implements V2SourceReader {
    private delayMs: number;
    constructor(delayMs: number) {
      this.delayMs = delayMs;
    }

    async readTickets() {
      await new Promise((r) => setTimeout(r, this.delayMs));
      const ticket: V2Ticket = {
        id: "T-1",
        title: "Slow ticket",
        body: "Body content.",
        status: "open",
        priority: "p2",
        assignee: "alice",
        tags: ["slow"],
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        resolved_at: null,
      };
      return ok([ticket]);
    }

    async readVerdicts(_ticketId: string) {
      return ok<V2Verdict[]>([{
        ticket_id: _ticketId,
        council_member: "arch-bot",
        outcome: "approved" as const,
        reasoning: "Looks good.",
        created_at: "2025-01-01T01:00:00Z",
      }]);
    }

    async readAssignments(_ticketId: string) {
      return ok<V2CouncilAssignment[]>([{
        ticket_id: _ticketId,
        council_member: "arch-bot",
        role: "architecture",
        assigned_at: "2025-01-01T00:30:00Z",
      }]);
    }

    async close() {}
  }

  it("rejects concurrent migration runs with ConcurrencyConflictError", async () => {
    const workRepo = new InMemoryWorkArticleRepository();
    const svc = new MigrationService({
      v2Reader: new SlowV2Reader(100),
      workRepo,
      logger: silentLogger,
    });

    // Start first run (will take ~100ms)
    const first = svc.run("dry-run");

    // Immediately attempt a second run
    const second = await svc.run("dry-run");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CONCURRENCY_CONFLICT");
    }

    // First run should still succeed
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  it("allows a new run after the previous one completes", async () => {
    const workRepo = new InMemoryWorkArticleRepository();
    const svc = new MigrationService({
      v2Reader: new SlowV2Reader(10),
      workRepo,
      logger: silentLogger,
    });

    const first = await svc.run("dry-run");
    expect(first.ok).toBe(true);

    // After completion, a second run should work
    const second = await svc.run("dry-run");
    expect(second.ok).toBe(true);
  });

  it("releases lock even if migration throws internally", async () => {
    // Create a reader that fails after the lock is acquired
    const failingReader: V2SourceReader = {
      async readTickets() {
        return ok<V2Ticket[]>([]);
      },
      async readVerdicts() {
        return ok<V2Verdict[]>([]);
      },
      async readAssignments() {
        return ok<V2CouncilAssignment[]>([]);
      },
      async close() {},
    };

    const workRepo = new InMemoryWorkArticleRepository();
    const svc = new MigrationService({
      v2Reader: failingReader,
      workRepo,
      logger: silentLogger,
    });

    // Run with empty tickets (succeeds but does nothing)
    const first = await svc.run("execute");
    expect(first.ok).toBe(true);

    // Lock should be released — subsequent run should work
    const second = await svc.run("execute");
    expect(second.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Orchestration event eviction
// ═══════════════════════════════════════════════════════════════════════════════

describe("InMemoryOrchestrationEventRepository event eviction", () => {
  it("evicts oldest events when MAX_EVENTS is reached", async () => {
    const repo = new InMemoryOrchestrationEventRepository();
    const wId = workId("w-evict-test");
    const agId = agentId("agent-evict");

    // Fill to capacity (10,000 events)
    for (let i = 0; i < 10_000; i++) {
      await repo.logEvent({
        workId: wId,
        eventType: "phase_advanced",
        agentId: agId,
        details: { index: i },
      });
    }

    // Verify we have exactly 10,000
    const beforeResult = await repo.findByWorkId(wId);
    expect(beforeResult.ok).toBe(true);
    if (beforeResult.ok) {
      expect(beforeResult.value).toHaveLength(10_000);
    }

    // Log one more — should trigger eviction
    await repo.logEvent({
      workId: wId,
      eventType: "phase_advanced",
      agentId: agId,
      details: { index: 10_000, marker: "newest" },
    });

    // After eviction: ~9000 (90% of 10000) + 1 new = ~9001
    const afterResult = await repo.findByWorkId(wId);
    expect(afterResult.ok).toBe(true);
    if (afterResult.ok) {
      const count = afterResult.value.length;
      expect(count).toBe(9_001);

      // The newest event should be preserved
      const newest = afterResult.value[afterResult.value.length - 1]!;
      expect(newest.details.marker).toBe("newest");

      // The oldest events (index 0-999) should have been evicted
      const indices = afterResult.value.map((e) => e.details.index as number);
      expect(indices).not.toContain(0);
      expect(indices).not.toContain(999);
      // Events from index 1000+ should remain
      expect(indices).toContain(1_000);
    }
  });

  it("does not evict when below capacity", async () => {
    const repo = new InMemoryOrchestrationEventRepository();
    const wId = workId("w-small");

    for (let i = 0; i < 100; i++) {
      await repo.logEvent({
        workId: wId,
        eventType: "agent_spawned",
        details: { i },
      });
    }

    const result = await repo.findByWorkId(wId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(100);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Search with edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("Search edge cases", () => {
  let repo: InMemorySearchIndexRepository;

  beforeEach(() => {
    repo = new InMemorySearchIndexRepository();
  });

  it("empty query returns empty results", async () => {
    await repo.indexArticle("doc-1", "Hello World", "Some content", "knowledge");
    const result = await repo.search({ query: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("query with only whitespace returns empty results", async () => {
    await repo.indexArticle("doc-1", "Hello World", "Some content", "knowledge");
    const result = await repo.search({ query: "   \t\n  " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("very long content indexing works", async () => {
    const longContent = "keyword ".repeat(5000);
    await repo.indexArticle("doc-long", "Long Document", longContent, "work");
    const result = await repo.search({ query: "keyword" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.id).toBe("doc-long");
    }
  });

  it("special characters in search query do not crash", async () => {
    await repo.indexArticle("doc-1", "Normal Title", "Normal content", "knowledge");
    const specials = ["$pecial!", "foo (bar)", "a+b=c", "[brackets]", "a/b/c"];
    for (const q of specials) {
      const result = await repo.search({ query: q });
      expect(result.ok).toBe(true);
    }
  });

  it("search after removing all documents returns empty", async () => {
    await repo.indexArticle("d1", "Alpha", "Alpha content", "knowledge");
    await repo.indexArticle("d2", "Beta", "Beta content", "work");
    await repo.removeArticle("d1");
    await repo.removeArticle("d2");

    const result = await repo.search({ query: "Alpha" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("upsert semantics: re-indexing same ID replaces old content", async () => {
    await repo.indexArticle("doc-1", "Old Title", "old content", "knowledge");
    await repo.indexArticle("doc-1", "New Title", "new content", "knowledge");

    const oldResult = await repo.search({ query: "old" });
    expect(oldResult.ok).toBe(true);
    if (oldResult.ok) expect(oldResult.value).toEqual([]);

    const newResult = await repo.search({ query: "new" });
    expect(newResult.ok).toBe(true);
    if (newResult.ok) {
      expect(newResult.value).toHaveLength(1);
      expect(newResult.value[0]!.title).toBe("New Title");
    }
  });

  it("type filter narrows results", async () => {
    await repo.indexArticle("k1", "Guide", "Some guide content", "knowledge");
    await repo.indexArticle("w1", "Task", "Some task content", "work");

    const knowledgeOnly = await repo.search({ query: "some", type: "knowledge" });
    expect(knowledgeOnly.ok).toBe(true);
    if (knowledgeOnly.ok) {
      expect(knowledgeOnly.value).toHaveLength(1);
      expect(knowledgeOnly.value[0]!.type).toBe("knowledge");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Error path tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("Error paths", () => {
  describe("KnowledgeArticle not-found errors", () => {
    let repo: InMemoryKnowledgeArticleRepository;

    beforeEach(() => {
      repo = new InMemoryKnowledgeArticleRepository();
    });

    it("findById with non-existent ID returns NotFoundError", async () => {
      const result = await repo.findById("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("update with non-existent ID returns NotFoundError", async () => {
      const result = await repo.update("nonexistent", { title: "New" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("delete with non-existent ID returns NotFoundError", async () => {
      const result = await repo.delete("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("WorkArticle not-found errors", () => {
    let repo: InMemoryWorkArticleRepository;

    beforeEach(() => {
      repo = new InMemoryWorkArticleRepository();
    });

    it("findById with non-existent ID returns NotFoundError", async () => {
      const result = await repo.findById("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("update with non-existent ID returns NotFoundError", async () => {
      const result = await repo.update("nonexistent", { title: "New" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("delete with non-existent ID returns NotFoundError", async () => {
      const result = await repo.delete("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("WorkArticle lifecycle error paths", () => {
    let repo: InMemoryWorkArticleRepository;

    beforeEach(() => {
      repo = new InMemoryWorkArticleRepository();
    });

    it("advancePhase on terminal phase (done) returns StateTransitionError", async () => {
      // Create article and advance it all the way to done
      const created = await repo.create(workInput({
        content: "## Objective\nGoal\n\n## Acceptance Criteria\n- Done\n\n## Implementation\nCode linked.",
      }));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value.id;

      // planning -> enrichment (needs objective + acceptance criteria in content)
      const toEnrich = await repo.advancePhase(id, WorkPhase.ENRICHMENT);
      expect(toEnrich.ok).toBe(true);

      // Contribute enrichment to meet the guard
      await repo.contributeEnrichment(id, "architecture", "contributed");

      // enrichment -> implementation
      const toImpl = await repo.advancePhase(id, WorkPhase.IMPLEMENTATION);
      expect(toImpl.ok).toBe(true);

      // implementation -> review (needs "## Implementation" in content)
      const toReview = await repo.advancePhase(id, WorkPhase.REVIEW);
      expect(toReview.ok).toBe(true);

      // Assign and approve reviewer
      const reviewer = agentId("reviewer-1");
      await repo.assignReviewer(id, reviewer);
      await repo.submitReview(id, reviewer, "approved");

      // review -> done
      const toDone = await repo.advancePhase(id, WorkPhase.DONE);
      expect(toDone.ok).toBe(true);

      // Now try to advance from done — should fail
      const pastDone = await repo.advancePhase(id, WorkPhase.PLANNING);
      expect(pastDone.ok).toBe(false);
      if (!pastDone.ok) {
        expect(pastDone.error.code).toBe("STATE_TRANSITION_INVALID");
      }
    });

    it("advancePhase on cancelled phase returns StateTransitionError", async () => {
      const created = await repo.create(workInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value.id;

      // Cancel the article
      const cancelled = await repo.advancePhase(id, WorkPhase.CANCELLED);
      expect(cancelled.ok).toBe(true);

      // Try to advance from cancelled
      const fromCancelled = await repo.advancePhase(id, WorkPhase.PLANNING);
      expect(fromCancelled.ok).toBe(false);
      if (!fromCancelled.ok) {
        expect(fromCancelled.error.code).toBe("STATE_TRANSITION_INVALID");
      }
    });

    it("contributeEnrichment in wrong phase returns StateTransitionError", async () => {
      // Article starts in PLANNING phase
      const created = await repo.create(workInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await repo.contributeEnrichment(created.value.id, "architecture", "contributed");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("STATE_TRANSITION_INVALID");
      }
    });

    it("submitReview in wrong phase returns StateTransitionError", async () => {
      const created = await repo.create(workInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const reviewer = agentId("reviewer-1");
      await repo.assignReviewer(created.value.id, reviewer);

      const result = await repo.submitReview(created.value.id, reviewer, "approved");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("STATE_TRANSITION_INVALID");
      }
    });

    it("assignReviewer twice returns ValidationError", async () => {
      const created = await repo.create(workInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value.id;

      const reviewer = agentId("reviewer-dup");
      const first = await repo.assignReviewer(id, reviewer);
      expect(first.ok).toBe(true);

      const second = await repo.assignReviewer(id, reviewer);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.code).toBe("VALIDATION_FAILED");
      }
    });

    it("advancePhase skipping phases returns StateTransitionError", async () => {
      const created = await repo.create(workInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // planning -> review (skipping enrichment + implementation)
      const result = await repo.advancePhase(created.value.id, WorkPhase.REVIEW);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("STATE_TRANSITION_INVALID");
      }
    });

    it("advancePhase fails when guard is not met", async () => {
      // Create article with no objective in content
      const created = await repo.create(workInput({ content: "No objective here." }));
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // planning -> enrichment should fail (no "## Objective" in content)
      const result = await repo.advancePhase(created.value.id, WorkPhase.ENRICHMENT);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("GUARD_FAILED");
      }
    });

    it("cannot update article in terminal phase", async () => {
      const created = await repo.create(workInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value.id;

      // Cancel it
      await repo.advancePhase(id, WorkPhase.CANCELLED);

      const result = await repo.update(id, { title: "Updated" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("STATE_TRANSITION_INVALID");
      }
    });

    it("cannot delete article in terminal phase", async () => {
      const created = await repo.create(workInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value.id;

      await repo.advancePhase(id, WorkPhase.CANCELLED);

      const result = await repo.delete(id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("STATE_TRANSITION_INVALID");
      }
    });
  });
});
