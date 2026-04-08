import { describe, it, expect, beforeEach } from "vitest";
import { MigrationService } from "../../../src/migration/service.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import type { V2SourceReader, V2Ticket, V2Verdict, V2CouncilAssignment } from "../../../src/migration/types.js";
import { ok } from "../../../src/core/result.js";

// ---------------------------------------------------------------------------
// In-memory V2 source reader for tests
// ---------------------------------------------------------------------------

class StubV2Reader implements V2SourceReader {
  tickets: V2Ticket[] = [];
  verdicts: Map<string, V2Verdict[]> = new Map();
  assignments: Map<string, V2CouncilAssignment[]> = new Map();

  async readTickets() {
    return ok(this.tickets);
  }

  async readVerdicts(ticketId: string) {
    return ok(this.verdicts.get(ticketId) ?? []);
  }

  async readAssignments(ticketId: string) {
    return ok(this.assignments.get(ticketId) ?? []);
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
  const workRepo = new InMemoryWorkArticleRepository();
  const logger = createLogger({ level: "warn", domain: "test" });
  const service = new MigrationService({ v2Reader: reader, workRepo, logger });
  return { service, reader, workRepo, logger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MigrationService", () => {
  let service: MigrationService;
  let reader: StubV2Reader;
  let workRepo: InMemoryWorkArticleRepository;

  beforeEach(() => {
    ({ service, reader, workRepo } = createService());
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
  });
});
