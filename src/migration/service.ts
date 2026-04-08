import type { Result } from "../core/result.js";
import type { Logger } from "../core/logger.js";
import type { MonstheraError } from "../core/errors.js";
import { ok } from "../core/result.js";
import { agentId, workId } from "../core/types.js";
import type { WorkArticleRepository, CreateWorkArticleInput } from "../work/repository.js";
import type {
  V2SourceReader,
  MigrationMode,
  MappedArticle,
  MigrationItemResult,
  MigrationReport,
} from "./types.js";
import { mapTicketToArticle } from "./mapper.js";
import { AliasStore } from "./alias-store.js";

// ─── Service Dependencies ────────────────────────────────────────────────────

export interface MigrationServiceDeps {
  readonly v2Reader: V2SourceReader;
  readonly workRepo: WorkArticleRepository;
  readonly logger: Logger;
}

// ─── MigrationService ────────────────────────────────────────────────────────

export class MigrationService {
  private readonly v2: V2SourceReader;
  private readonly workRepo: WorkArticleRepository;
  private readonly logger: Logger;
  readonly aliasStore = new AliasStore();

  constructor(deps: MigrationServiceDeps) {
    this.v2 = deps.v2Reader;
    this.workRepo = deps.workRepo;
    this.logger = deps.logger;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run migration in the specified mode.
   *
   * - dry-run:  map all tickets, report what would happen, write nothing
   * - validate: map all tickets, validate each against v3 schemas, write nothing
   * - execute:  map, validate, and write v3 work articles
   */
  async run(
    mode: MigrationMode,
    options?: { force?: boolean },
  ): Promise<Result<MigrationReport, MonstheraError>> {
    const force = options?.force ?? false;
    this.logger.info("Starting migration", { mode, force });

    // 1. Read all v2 tickets
    const ticketsResult = await this.v2.readTickets();
    if (!ticketsResult.ok) return ticketsResult;
    const tickets = ticketsResult.value;

    this.logger.info("Read v2 tickets", { count: tickets.length });

    // 2. Map each ticket
    const items: MigrationItemResult[] = [];

    for (const ticket of tickets) {
      const item = await this.processTicket(ticket.id, mode, force);
      items.push(item);
    }

    // 3. Build report
    const report: MigrationReport = {
      mode,
      total: items.length,
      created: items.filter((i) => i.status === "created").length,
      skipped: items.filter((i) => i.status === "skipped").length,
      failed: items.filter((i) => i.status === "failed").length,
      items,
    };

    this.logger.info("Migration complete", {
      mode,
      total: report.total,
      created: report.created,
      skipped: report.skipped,
      failed: report.failed,
    });

    return ok(report);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async processTicket(
    ticketId: string,
    mode: MigrationMode,
    force: boolean,
  ): Promise<MigrationItemResult> {
    // Read the full ticket data
    const ticketsResult = await this.v2.readTickets();
    if (!ticketsResult.ok) {
      return { v2Id: ticketId, status: "failed", reason: ticketsResult.error.message };
    }
    const ticket = ticketsResult.value.find((t) => t.id === ticketId);
    if (!ticket) {
      return { v2Id: ticketId, status: "failed", reason: "Ticket not found in v2 source" };
    }

    const verdictsResult = await this.v2.readVerdicts(ticketId);
    if (!verdictsResult.ok) {
      return { v2Id: ticketId, status: "failed", reason: verdictsResult.error.message };
    }

    const assignmentsResult = await this.v2.readAssignments(ticketId);
    if (!assignmentsResult.ok) {
      return { v2Id: ticketId, status: "failed", reason: assignmentsResult.error.message };
    }

    // Map to v3
    const mapped = mapTicketToArticle(ticket, verdictsResult.value, assignmentsResult.value);

    // Check idempotency — skip if already migrated (unless --force)
    if (!force && this.aliasStore.has(mapped.v2Id)) {
      this.logger.debug("Skipping already-migrated ticket", { v2Id: ticketId });
      return { v2Id: ticketId, status: "skipped", reason: "Already migrated" };
    }

    // Check existing articles by scanning for matching migration hash
    if (!force) {
      const existingCheck = await this.findByMigrationHash(mapped.migrationHash);
      if (existingCheck) {
        this.logger.debug("Skipping ticket with existing migration hash", { v2Id: ticketId });
        return { v2Id: ticketId, status: "skipped", reason: "Migration hash already exists in v3" };
      }
    }

    // Validate the mapped article
    const validationError = this.validateMapped(mapped);
    if (validationError) {
      return { v2Id: ticketId, status: "failed", reason: validationError };
    }

    // dry-run and validate stop here
    if (mode === "dry-run" || mode === "validate") {
      return { v2Id: ticketId, status: "created", reason: `Would create: ${mapped.title}` };
    }

    // Execute: write to v3
    const createResult = await this.writeArticle(mapped);
    if (!createResult.ok) {
      return { v2Id: ticketId, status: "failed", reason: createResult.error.message };
    }

    // Register alias
    this.aliasStore.register(mapped.v2Id, workId(createResult.value));

    this.logger.info("Migrated ticket", { v2Id: ticketId, v3Id: createResult.value });
    return { v2Id: ticketId, v3Id: createResult.value, status: "created" };
  }

  /** Validate a mapped article against v3 expectations */
  private validateMapped(mapped: MappedArticle): string | undefined {
    if (!mapped.title.trim()) return "Title is empty";
    if (!mapped.template) return "Template could not be inferred";
    if (!mapped.priority) return "Priority could not be mapped";
    if (mapped.aliases.length === 0) return "No aliases preserved";
    return undefined;
  }

  /** Write a mapped article to the v3 work repository */
  private async writeArticle(mapped: MappedArticle): Promise<Result<string, MonstheraError>> {
    const input: CreateWorkArticleInput = {
      title: mapped.title,
      template: mapped.template as "feature" | "bugfix" | "refactor" | "spike",
      priority: mapped.priority as "critical" | "high" | "medium" | "low",
      author: agentId("migration"),
      tags: [...mapped.tags, `v2:${mapped.v2Id}`, `migration-hash:${mapped.migrationHash}`],
      content: mapped.content,
    };

    const result = await this.workRepo.create(input);
    if (!result.ok) return result as Result<never, MonstheraError>;
    return ok(result.value.id);
  }

  /** Check if a migration hash already exists in v3 (via tag convention) */
  private async findByMigrationHash(hash: string): Promise<boolean> {
    const allResult = await this.workRepo.findMany();
    if (!allResult.ok) return false;
    return allResult.value.some((article) =>
      article.tags.includes(`migration-hash:${hash}`),
    );
  }
}
