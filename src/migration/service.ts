import type { Result } from "../core/result.js";
import type { Logger } from "../core/logger.js";
import type { StatusReporter } from "../core/status.js";
import type { RuntimeStateStore } from "../core/runtime-state.js";
import type { MonstheraError } from "../core/errors.js";
import { ok, err } from "../core/result.js";
import { ConcurrencyConflictError } from "../core/errors.js";
import { agentId, timestamp, workId } from "../core/types.js";
import type { KnowledgeArticleRepository, CreateKnowledgeArticleInput } from "../knowledge/repository.js";
import type {
  WorkArticleRepository,
  CreateWorkArticleInput,
  PhaseHistoryEntry,
} from "../work/repository.js";
import type {
  V2SourceReader,
  MigrationMode,
  MigrationScope,
  MappedArticle,
  MappedKnowledgeArticle,
  MigrationItemResult,
  MigrationReport,
  V2Ticket,
  V2KnowledgeRecord,
  V2NoteRecord,
} from "./types.js";
import { mapKnowledgeToArticle, mapNoteToArticle, mapTicketToArticle } from "./mapper.js";
import { AliasStore } from "./alias-store.js";

const KNOWLEDGE_SOURCE_TAG_PREFIX = "v2-source:";
const MIGRATION_HASH_TAG_PREFIX = "migration-hash:";

// ─── Service Dependencies ────────────────────────────────────────────────────

export interface MigrationServiceDeps {
  readonly v2Reader: V2SourceReader;
  readonly knowledgeRepo: KnowledgeArticleRepository;
  readonly workRepo: WorkArticleRepository;
  readonly logger: Logger;
  readonly status?: StatusReporter;
  readonly runtimeState?: RuntimeStateStore;
}

interface MigrationState {
  readonly migratedWorkArticles: number;
  readonly migratedKnowledgeArticles: number;
}

// ─── MigrationService ────────────────────────────────────────────────────────

export class MigrationService {
  private readonly v2: V2SourceReader;
  private readonly knowledgeRepo: KnowledgeArticleRepository;
  private readonly workRepo: WorkArticleRepository;
  private readonly logger: Logger;
  private readonly status?: StatusReporter;
  private readonly runtimeState?: RuntimeStateStore;
  private running = false;
  readonly aliasStore = new AliasStore();

  constructor(deps: MigrationServiceDeps) {
    this.v2 = deps.v2Reader;
    this.knowledgeRepo = deps.knowledgeRepo;
    this.workRepo = deps.workRepo;
    this.logger = deps.logger.child({ domain: "migration" });
    this.status = deps.status;
    this.runtimeState = deps.runtimeState;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async getStatus(): Promise<Result<{
    aliasesRegistered: number;
    migratedWorkArticles: number;
    migratedKnowledgeArticles: number;
  }, MonstheraError>> {
    const hydrateResult = await this.hydrateMigrationState();
    if (!hydrateResult.ok) return hydrateResult;

    return ok({
      aliasesRegistered: this.aliasStore.size,
      migratedWorkArticles: hydrateResult.value.migratedWorkArticles,
      migratedKnowledgeArticles: hydrateResult.value.migratedKnowledgeArticles,
    });
  }

  async resolveAlias(alias: string): Promise<Result<string | undefined, MonstheraError>> {
    const hydrateResult = await this.hydrateMigrationState();
    if (!hydrateResult.ok) return hydrateResult;
    return this.aliasStore.resolve(alias);
  }

  async run(
    mode: MigrationMode,
    options?: { force?: boolean; scope?: MigrationScope },
  ): Promise<Result<MigrationReport, MonstheraError>> {
    if (this.running) {
      return err(new ConcurrencyConflictError("migration", { reason: "Migration is already running" }));
    }
    this.running = true;
    try {
      const startTime = Date.now();
      const force = options?.force ?? false;
      const scope = options?.scope ?? "all";
      this.logger.info("Starting migration", { operation: "run", mode, force, scope });

      const hydrateResult = await this.hydrateMigrationState();
      if (!hydrateResult.ok) return hydrateResult;

      const items: MigrationItemResult[] = [];

      if (scope === "work" || scope === "all") {
        const workItemsResult = await this.runWorkMigration(mode, force);
        if (!workItemsResult.ok) return workItemsResult;
        items.push(...workItemsResult.value);
      }

      if (scope === "knowledge" || scope === "all") {
        const knowledgeItemsResult = await this.runKnowledgeMigration(mode, force);
        if (!knowledgeItemsResult.ok) return knowledgeItemsResult;
        items.push(...knowledgeItemsResult.value);
      }

      const report: MigrationReport = {
        mode,
        scope,
        total: items.length,
        created: items.filter((item) => item.status === "created").length,
        skipped: items.filter((item) => item.status === "skipped").length,
        failed: items.filter((item) => item.status === "failed").length,
        items,
      };

      this.logger.info("Migration complete", {
        operation: "run",
        mode,
        scope,
        total: report.total,
        created: report.created,
        skipped: report.skipped,
        failed: report.failed,
        durationMs: Date.now() - startTime,
      });

      if (mode === "execute") {
        const migratedAt = new Date().toISOString();
        this.status?.recordStat("lastMigrationAt", migratedAt);
        if (this.runtimeState) {
          await this.runtimeState.write({ lastMigrationAt: migratedAt });
        }
      }

      return ok(report);
    } finally {
      this.running = false;
    }
  }

  // ─── Work Migration ─────────────────────────────────────────────────────────

  private async runWorkMigration(
    mode: MigrationMode,
    force: boolean,
  ): Promise<Result<MigrationItemResult[], MonstheraError>> {
    const ticketsResult = await this.v2.readTickets();
    if (!ticketsResult.ok) return ticketsResult;

    const tickets = ticketsResult.value;
    this.logger.info("Read v2 tickets", { operation: "runWorkMigration", count: tickets.length });

    const items: MigrationItemResult[] = [];
    for (const ticket of tickets) {
      const item = await this.processTicket(ticket, mode, force);
      items.push(item);
    }
    return ok(items);
  }

  private async processTicket(
    ticket: V2Ticket,
    mode: MigrationMode,
    force: boolean,
  ): Promise<MigrationItemResult> {
    const verdictsResult = await this.v2.readVerdicts(ticket.id);
    if (!verdictsResult.ok) {
      return { scope: "work", sourceId: ticket.id, status: "failed", reason: verdictsResult.error.message };
    }

    const assignmentsResult = await this.v2.readAssignments(ticket.id);
    if (!assignmentsResult.ok) {
      return { scope: "work", sourceId: ticket.id, status: "failed", reason: assignmentsResult.error.message };
    }

    const mapped = mapTicketToArticle(ticket, verdictsResult.value, assignmentsResult.value);

    if (!force && this.aliasStore.has(mapped.v2Id)) {
      this.logger.debug("Skipping already-migrated ticket", { operation: "processTicket", v2Id: ticket.id });
      return { scope: "work", sourceId: ticket.id, status: "skipped", reason: "Already migrated" };
    }

    if (!force) {
      const existingCheck = await this.findWorkByMigrationHash(mapped.migrationHash);
      if (existingCheck) {
        this.logger.debug("Skipping ticket with existing migration hash", { operation: "processTicket", v2Id: ticket.id });
        return { scope: "work", sourceId: ticket.id, status: "skipped", reason: "Migration hash already exists in v3" };
      }
    }

    const validationError = this.validateWorkMapped(mapped);
    if (validationError) {
      return { scope: "work", sourceId: ticket.id, status: "failed", reason: validationError };
    }

    if (mode === "dry-run" || mode === "validate") {
      return { scope: "work", sourceId: ticket.id, status: "created", reason: `Would create: ${mapped.title}` };
    }

    const createResult = await this.writeWorkArticle(mapped);
    if (!createResult.ok) {
      return { scope: "work", sourceId: ticket.id, status: "failed", reason: createResult.error.message };
    }

    for (const alias of mapped.aliases) {
      this.aliasStore.register(alias, workId(createResult.value));
    }

    this.logger.info("Migrated ticket", { operation: "processTicket", v2Id: ticket.id, v3Id: createResult.value });
    return { scope: "work", sourceId: ticket.id, v3Id: createResult.value, status: "created" };
  }

  private validateWorkMapped(mapped: MappedArticle): string | undefined {
    if (!mapped.title.trim()) return "Title is empty";
    if (!mapped.template) return "Template could not be inferred";
    if (!mapped.priority) return "Priority could not be mapped";
    if (mapped.aliases.length === 0) return "No aliases preserved";
    return undefined;
  }

  private buildPhaseHistory(mapped: MappedArticle): PhaseHistoryEntry[] {
    const createdAt = timestamp(mapped.createdAt);
    const updatedAt = timestamp(mapped.completedAt ?? mapped.updatedAt);

    if (mapped.phase === "planning") {
      return [{ phase: "planning", enteredAt: createdAt }];
    }

    return [
      { phase: "planning", enteredAt: createdAt, exitedAt: updatedAt },
      { phase: mapped.phase as PhaseHistoryEntry["phase"], enteredAt: updatedAt },
    ];
  }

  private async writeWorkArticle(mapped: MappedArticle): Promise<Result<string, MonstheraError>> {
    const input: CreateWorkArticleInput = {
      title: mapped.title,
      template: mapped.template as "feature" | "bugfix" | "refactor" | "spike",
      phase: mapped.phase as CreateWorkArticleInput["phase"],
      priority: mapped.priority as "critical" | "high" | "medium" | "low",
      author: agentId("migration"),
      assignee: mapped.assignee ? agentId(mapped.assignee) : undefined,
      tags: [
        ...mapped.tags,
        ...mapped.aliases.map((alias) => `v2:${alias}`),
        `${MIGRATION_HASH_TAG_PREFIX}${mapped.migrationHash}`,
      ],
      codeRefs: [...mapped.codeRefs],
      content: mapped.content,
      createdAt: timestamp(mapped.createdAt),
      updatedAt: timestamp(mapped.updatedAt),
      completedAt: mapped.completedAt ? timestamp(mapped.completedAt) : undefined,
      phaseHistory: this.buildPhaseHistory(mapped),
    };

    const result = await this.workRepo.create(input);
    if (!result.ok) return result as Result<never, MonstheraError>;
    return ok(result.value.id);
  }

  private async findWorkByMigrationHash(hash: string): Promise<boolean> {
    const allResult = await this.workRepo.findMany();
    if (!allResult.ok) return false;
    return allResult.value.some((article) =>
      article.tags.includes(`${MIGRATION_HASH_TAG_PREFIX}${hash}`),
    );
  }

  // ─── Knowledge Migration ───────────────────────────────────────────────────

  private async runKnowledgeMigration(
    mode: MigrationMode,
    force: boolean,
  ): Promise<Result<MigrationItemResult[], MonstheraError>> {
    const items: MigrationItemResult[] = [];

    const knowledgeResult = this.v2.readKnowledge ? await this.v2.readKnowledge() : ok<V2KnowledgeRecord[]>([]);
    if (!knowledgeResult.ok) return knowledgeResult;
    this.logger.info("Read v2 knowledge rows", { operation: "runKnowledgeMigration", count: knowledgeResult.value.length });

    for (const record of knowledgeResult.value) {
      items.push(await this.processKnowledgeRecord(record, mode, force));
    }

    const notesResult = this.v2.readNotes ? await this.v2.readNotes() : ok<V2NoteRecord[]>([]);
    if (!notesResult.ok) return notesResult;
    this.logger.info("Read v2 note rows", { operation: "runKnowledgeMigration", count: notesResult.value.length });

    for (const record of notesResult.value) {
      items.push(await this.processNoteRecord(record, mode, force));
    }

    return ok(items);
  }

  private async processKnowledgeRecord(
    record: V2KnowledgeRecord,
    mode: MigrationMode,
    force: boolean,
  ): Promise<MigrationItemResult> {
    const mapped = mapKnowledgeToArticle(record);
    return this.processKnowledgeMapped(mapped, mode, force);
  }

  private async processNoteRecord(
    record: V2NoteRecord,
    mode: MigrationMode,
    force: boolean,
  ): Promise<MigrationItemResult> {
    const mapped = mapNoteToArticle(record);
    return this.processKnowledgeMapped(mapped, mode, force);
  }

  private async processKnowledgeMapped(
    mapped: MappedKnowledgeArticle,
    mode: MigrationMode,
    force: boolean,
  ): Promise<MigrationItemResult> {
    if (!force) {
      const existingCheck = await this.findKnowledgeByMigrationHash(mapped.migrationHash);
      if (existingCheck) {
        this.logger.debug("Skipping knowledge item with existing migration hash", {
          operation: "processKnowledgeMapped",
          sourceKey: mapped.sourceKey,
        });
        return { scope: "knowledge", sourceId: mapped.sourceKey, status: "skipped", reason: "Migration hash already exists in v3" };
      }
    }

    const validationError = this.validateKnowledgeMapped(mapped);
    if (validationError) {
      return { scope: "knowledge", sourceId: mapped.sourceKey, status: "failed", reason: validationError };
    }

    if (mode === "dry-run" || mode === "validate") {
      return { scope: "knowledge", sourceId: mapped.sourceKey, status: "created", reason: `Would create: ${mapped.title}` };
    }

    const createResult = await this.writeKnowledgeArticle(mapped);
    if (!createResult.ok) {
      return { scope: "knowledge", sourceId: mapped.sourceKey, status: "failed", reason: createResult.error.message };
    }

    this.logger.info("Migrated knowledge", {
      operation: "processKnowledgeMapped",
      sourceKey: mapped.sourceKey,
      v3Id: createResult.value,
      sourceKind: mapped.sourceKind,
    });
    return { scope: "knowledge", sourceId: mapped.sourceKey, v3Id: createResult.value, status: "created" };
  }

  private validateKnowledgeMapped(mapped: MappedKnowledgeArticle): string | undefined {
    if (!mapped.title.trim()) return "Title is empty";
    if (!mapped.category.trim()) return "Category is empty";
    if (!mapped.content.trim()) return "Content is empty";
    return undefined;
  }

  private async writeKnowledgeArticle(mapped: MappedKnowledgeArticle): Promise<Result<string, MonstheraError>> {
    const input: CreateKnowledgeArticleInput = {
      title: mapped.title,
      category: mapped.category,
      content: mapped.content,
      tags: [
        ...mapped.tags,
        `${KNOWLEDGE_SOURCE_TAG_PREFIX}${mapped.sourceKind}:${mapped.sourceKey}`,
        `${MIGRATION_HASH_TAG_PREFIX}${mapped.migrationHash}`,
      ],
      codeRefs: [...mapped.codeRefs],
      createdAt: mapped.createdAt,
      updatedAt: mapped.updatedAt,
    };

    const result = await this.knowledgeRepo.create(input);
    if (!result.ok) return result as Result<never, MonstheraError>;
    return ok(result.value.id);
  }

  private async findKnowledgeByMigrationHash(hash: string): Promise<boolean> {
    const allResult = await this.knowledgeRepo.findMany();
    if (!allResult.ok) return false;
    return allResult.value.some((article) => article.tags.includes(`${MIGRATION_HASH_TAG_PREFIX}${hash}`));
  }

  // ─── State Hydration ────────────────────────────────────────────────────────

  private async hydrateMigrationState(): Promise<Result<MigrationState, MonstheraError>> {
    this.aliasStore.clear();

    const workResult = await this.workRepo.findMany();
    if (!workResult.ok) return workResult;

    let migratedWorkArticles = 0;
    for (const article of workResult.value) {
      const aliases = article.tags
        .filter((tag) => tag.startsWith("v2:"))
        .map((tag) => tag.slice(3))
        .filter(Boolean);

      if (aliases.length === 0) continue;
      migratedWorkArticles++;

      for (const alias of aliases) {
        this.aliasStore.register(alias, article.id);
      }
    }

    const knowledgeResult = await this.knowledgeRepo.findMany();
    if (!knowledgeResult.ok) return knowledgeResult;

    const migratedKnowledgeArticles = knowledgeResult.value.filter((article) =>
      article.tags.some((tag) => tag.startsWith(KNOWLEDGE_SOURCE_TAG_PREFIX)),
    ).length;

    return ok({ migratedWorkArticles, migratedKnowledgeArticles });
  }
}
