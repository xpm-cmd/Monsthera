import { describe, it, expect, beforeEach } from "vitest";
import { MigrationService } from "../../../src/migration/service.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { timestamp } from "../../../src/core/types.js";
import type { RuntimeStateSnapshot, RuntimeStateStore } from "../../../src/core/runtime-state.js";
import type {
  V2SourceReader,
  V2Ticket,
  V2Verdict,
  V2CouncilAssignment,
  V2KnowledgeRecord,
  V2NoteRecord,
} from "../../../src/migration/types.js";
import { ok } from "../../../src/core/result.js";

// ---------------------------------------------------------------------------
// In-memory V2 source reader for tests
// ---------------------------------------------------------------------------

class StubV2Reader implements V2SourceReader {
  tickets: V2Ticket[] = [];
  verdicts: Map<string, V2Verdict[]> = new Map();
  assignments: Map<string, V2CouncilAssignment[]> = new Map();
  knowledge: V2KnowledgeRecord[] = [];
  notes: V2NoteRecord[] = [];

  async readTickets() {
    return ok(this.tickets);
  }

  async readVerdicts(ticketId: string) {
    return ok(this.verdicts.get(ticketId) ?? []);
  }

  async readAssignments(ticketId: string) {
    return ok(this.assignments.get(ticketId) ?? []);
  }

  async readKnowledge() {
    return ok(this.knowledge);
  }

  async readNotes() {
    return ok(this.notes);
  }

  async close() {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTicket(overrides?: Partial<V2Ticket>): V2Ticket {
  return {
    id: "T-2001",
    title: "Implement search",
    body: "Full-text search for knowledge articles.",
    status: "open",
    priority: "p2",
    assignee: "bob",
    tags: ["search"],
    codeRefs: ["src/search.ts"],
    acceptance_criteria: "Search returns relevant results.",
    created_at: "2025-02-01T10:00:00Z",
    updated_at: "2025-02-02T12:00:00Z",
    resolved_at: null,
    ...overrides,
  };
}

function makeVerdict(ticketId: string): V2Verdict {
  return {
    ticket_id: ticketId,
    council_member: "arch-bot",
    outcome: "approved",
    reasoning: "Architecture looks solid.",
    created_at: "2025-02-01T11:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createService() {
  const reader = new StubV2Reader();
  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const logger = createLogger({ level: "warn", domain: "test" });
  const runtimeState: RuntimeStateStore & { snapshot: RuntimeStateSnapshot } = {
    snapshot: {},
    async read() {
      return this.snapshot;
    },
    async write(patch) {
      this.snapshot = { ...this.snapshot, ...patch };
      return this.snapshot;
    },
  };
  const status = {
    register: () => {},
    unregister: () => {},
    getStatus: () => ({ version: "test", uptime: 0, timestamp: timestamp("2026-01-01T00:00:00Z"), subsystems: [] }),
    recordStat: (_key: string, _value: unknown) => {},
  };
  const service = new MigrationService({ v2Reader: reader, knowledgeRepo, workRepo, logger, runtimeState, status });
  return { service, reader, knowledgeRepo, workRepo, logger, runtimeState };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MigrationService", () => {
  let service: MigrationService;
  let reader: StubV2Reader;
  let knowledgeRepo: InMemoryKnowledgeArticleRepository;
  let workRepo: InMemoryWorkArticleRepository;
  let runtimeState: RuntimeStateStore & { snapshot: RuntimeStateSnapshot };

  beforeEach(() => {
    ({ service, reader, knowledgeRepo, workRepo, runtimeState } = createService());
  });

  // ─── dry-run mode ────────────────────────────────────────────────────────

  describe("dry-run mode", () => {
    it("reports what would be created without writing anything", async () => {
      reader.tickets = [makeTicket()];

      const result = await service.run("dry-run");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.mode).toBe("dry-run");
      expect(result.value.total).toBe(1);
      expect(result.value.created).toBe(1);
      expect(result.value.skipped).toBe(0);
      expect(result.value.failed).toBe(0);

      // Nothing written to repo
      const all = await workRepo.findMany();
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.value).toHaveLength(0);

      const knowledgeAll = await knowledgeRepo.findMany();
      expect(knowledgeAll.ok).toBe(true);
      if (!knowledgeAll.ok) return;
      expect(knowledgeAll.value).toHaveLength(0);
    });

    it("handles empty source gracefully", async () => {
      reader.tickets = [];

      const result = await service.run("dry-run");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.total).toBe(0);
    });
  });

  // ─── validate mode ──────────────────────────────────────────────────────

  describe("validate mode", () => {
    it("validates mapped articles without writing", async () => {
      reader.tickets = [makeTicket(), makeTicket({ id: "T-2002", title: "Add caching" })];

      const result = await service.run("validate");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.mode).toBe("validate");
      expect(result.value.total).toBe(2);
      expect(result.value.created).toBe(2);

      // Nothing written
      const all = await workRepo.findMany();
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.value).toHaveLength(0);
    });

    it("reports validation failure for empty title", async () => {
      reader.tickets = [makeTicket({ title: "" })];

      const result = await service.run("validate");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.failed).toBe(1);
      expect(result.value.items[0]!.reason).toContain("Title is empty");
    });
  });

  // ─── execute mode ───────────────────────────────────────────────────────

  describe("execute mode", () => {
    it("creates v3 work articles from v2 tickets", async () => {
      reader.tickets = [makeTicket()];
      reader.verdicts.set("T-2001", [makeVerdict("T-2001")]);

      const result = await service.run("execute");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.created).toBe(1);
      expect(result.value.items[0]!.v3Id).toBeDefined();

      // Article exists in repo
      const all = await workRepo.findMany();
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.value).toHaveLength(1);
      expect(all.value[0]!.title).toBe("Implement search");
      expect(all.value[0]!.tags).toContain("v2:T-2001");
      expect(all.value[0]!.codeRefs).toContain("src/search.ts");
      expect(all.value[0]!.createdAt).toBe("2025-02-01T10:00:00Z");
    });

    it("registers aliases after creation", async () => {
      reader.tickets = [makeTicket()];

      const result = await service.run("execute");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(service.aliasStore.has("T-2001")).toBe(true);
      const resolved = service.aliasStore.resolve("T-2001");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value).toBeDefined();
    });

    it("records lastMigrationAt in runtime state on execute", async () => {
      reader.tickets = [makeTicket()];

      const result = await service.run("execute");
      expect(result.ok).toBe(true);
      expect(runtimeState.snapshot.lastMigrationAt).toBeTruthy();
    });

    it("rehydrates aliases from migrated articles after a restart", async () => {
      reader.tickets = [makeTicket()];

      const firstRun = await service.run("execute");
      expect(firstRun.ok).toBe(true);
      if (!firstRun.ok) return;

      const secondService = new MigrationService({
        v2Reader: reader,
        knowledgeRepo,
        workRepo,
        logger: createLogger({ level: "warn", domain: "test" }),
      });

      const resolved = await secondService.resolveAlias("T-2001");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value).toBe(firstRun.value.items[0]!.v3Id);
    });

    it("skips already-migrated tickets on second run", async () => {
      reader.tickets = [makeTicket()];

      // First run
      await service.run("execute");

      // Second run
      const result = await service.run("execute");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.skipped).toBe(1);
      expect(result.value.created).toBe(0);

      // Still only one article
      const all = await workRepo.findMany();
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.value).toHaveLength(1);
    });

    it("re-migrates with force flag", async () => {
      reader.tickets = [makeTicket()];

      // First run
      await service.run("execute");

      // Second run with force
      const result = await service.run("execute", { force: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.created).toBe(1);
      expect(result.value.skipped).toBe(0);
    });

    it("migrates multiple tickets", async () => {
      reader.tickets = [
        makeTicket({ id: "T-3001", title: "Feature A" }),
        makeTicket({ id: "T-3002", title: "Feature B", tags: ["bug"] }),
        makeTicket({ id: "T-3003", title: "Refactor C", tags: ["refactor"] }),
      ];

      const result = await service.run("execute");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.total).toBe(3);
      expect(result.value.created).toBe(3);

      const all = await workRepo.findMany();
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.value).toHaveLength(3);
    });

    it("migrates knowledge rows and notes when scope includes knowledge", async () => {
      reader.knowledge = [{
        key: "context:architecture-overview",
        type: "context",
        scope: "repo",
        title: "Architecture Overview",
        content: "System architecture summary.",
        tags: ["architecture"],
        created_at: "2025-02-01T10:00:00Z",
        updated_at: "2025-02-02T12:00:00Z",
      }];
      reader.notes = [{
        key: "runbook:def544c78b44",
        type: "runbook",
        content: "Post-Commit Agora Maintenance\n\nRun indexing after every commit.",
        tags: ["topic:maintenance"],
        codeRefs: ["src/index.ts"],
        created_at: "2025-02-03T10:00:00Z",
        updated_at: "2025-02-03T12:00:00Z",
      }];

      const result = await service.run("execute", { scope: "knowledge" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.scope).toBe("knowledge");
      expect(result.value.total).toBe(2);
      expect(result.value.created).toBe(2);

      const knowledgeArticles = await knowledgeRepo.findMany();
      expect(knowledgeArticles.ok).toBe(true);
      if (!knowledgeArticles.ok) return;
      expect(knowledgeArticles.value).toHaveLength(2);
      expect(knowledgeArticles.value.some((article) => article.codeRefs.includes("src/index.ts"))).toBe(true);
      expect(knowledgeArticles.value.some((article) => article.tags.some((tag) => tag.startsWith("v2-source:note:")))).toBe(true);
    });
  });
});
