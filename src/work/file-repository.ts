import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import {
  NotFoundError,
  ValidationError,
  StateTransitionError,
  StorageError,
} from "../core/errors.js";
import { generateWorkId, timestamp, workId, agentId, WorkPhase } from "../core/types.js";
import type { WorkId, AgentId, WorkPhase as WorkPhaseType } from "../core/types.js";
import { parseMarkdown, serializeMarkdown } from "../knowledge/markdown.js";
import { checkTransition } from "./lifecycle.js";
import { WORK_TEMPLATES, generateInitialContent } from "./templates.js";
import { validateWorkFrontmatter } from "./schemas.js";
import type {
  WorkArticle,
  WorkArticleRepository,
  CreateWorkArticleInput,
  UpdateWorkArticleInput,
  EnrichmentAssignment,
  ReviewAssignment,
  PhaseHistoryEntry,
} from "./repository.js";

const TERMINAL_PHASES = new Set<WorkPhaseType>([WorkPhase.DONE, WorkPhase.CANCELLED]);

function parseJsonArray<T>(raw: unknown, fallback: T[]): T[] {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as T[];
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "items" in parsed &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      return (parsed as { items: T[] }).items;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function aliasesFromTags(tags: readonly string[]): string[] {
  return tags
    .filter((tag) => tag.startsWith("v2:"))
    .map((tag) => tag.slice(3))
    .filter(Boolean);
}

function migrationHashFromTags(tags: readonly string[]): string | undefined {
  return tags.find((tag) => tag.startsWith("migration-hash:"))?.slice("migration-hash:".length);
}

export class FileSystemWorkArticleRepository implements WorkArticleRepository {
  constructor(private readonly markdownRoot: string) {}

  private get workDir(): string {
    return path.join(this.markdownRoot, "work-articles");
  }

  private articlePath(id: string): string {
    return path.join(this.workDir, `${id}.md`);
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.workDir, { recursive: true });
  }

  private async readFromPath(filePath: string): Promise<Result<WorkArticle, NotFoundError | StorageError>> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return err(new NotFoundError("WorkArticle", path.basename(filePath, ".md")));
      }
      return err(new StorageError(`Failed to read work article: ${filePath}`, { cause: String(error) }));
    }

    const parsed = parseMarkdown(raw);
    if (!parsed.ok) {
      return err(new StorageError(`Failed to parse work article markdown: ${filePath}`, { cause: parsed.error.message }));
    }

    const frontmatterResult = validateWorkFrontmatter(parsed.value.frontmatter);
    if (!frontmatterResult.ok) {
      return err(new StorageError(`Invalid work article frontmatter: ${filePath}`, { cause: frontmatterResult.error.message }));
    }

    const rawFrontmatter = parsed.value.frontmatter;
    const frontmatter = frontmatterResult.value;
    const enrichmentRoles = parseJsonArray<EnrichmentAssignment>(
      rawFrontmatter["enrichmentRolesJson"],
      WORK_TEMPLATES[frontmatter.template].defaultEnrichmentRoles.map((role) => ({
        role,
        agentId: agentId(frontmatter.author),
        status: "pending" as const,
      })),
    ).map((entry) => ({
      role: entry.role,
      agentId: agentId(String(entry.agentId)),
      status: entry.status,
      contributedAt: entry.contributedAt ? timestamp(String(entry.contributedAt)) : undefined,
    }));

    const reviewers = parseJsonArray<ReviewAssignment>(rawFrontmatter["reviewersJson"], []).map((entry) => ({
      agentId: agentId(String(entry.agentId)),
      status: entry.status,
      reviewedAt: entry.reviewedAt ? timestamp(String(entry.reviewedAt)) : undefined,
    }));

    const phaseHistory = parseJsonArray<PhaseHistoryEntry>(rawFrontmatter["phaseHistoryJson"], [
      { phase: frontmatter.phase, enteredAt: timestamp(frontmatter.createdAt) },
    ]).map((entry) => ({
      phase: entry.phase,
      enteredAt: timestamp(String(entry.enteredAt)),
      exitedAt: entry.exitedAt ? timestamp(String(entry.exitedAt)) : undefined,
    }));

    return ok({
      id: workId(frontmatter.id),
      title: frontmatter.title,
      template: frontmatter.template,
      phase: frontmatter.phase,
      priority: frontmatter.priority,
      author: agentId(frontmatter.author),
      lead: frontmatter.lead ? agentId(frontmatter.lead) : undefined,
      assignee: frontmatter.assignee ? agentId(frontmatter.assignee) : undefined,
      enrichmentRoles,
      reviewers,
      phaseHistory,
      tags: frontmatter.tags,
      references: frontmatter.references,
      codeRefs: frontmatter.codeRefs,
      dependencies: frontmatter.dependencies.map((id) => workId(id)),
      blockedBy: frontmatter.blockedBy.map((id) => workId(id)),
      content: parsed.value.body,
      createdAt: timestamp(frontmatter.createdAt),
      updatedAt: timestamp(frontmatter.updatedAt),
      completedAt: frontmatter.completedAt ? timestamp(frontmatter.completedAt) : undefined,
    });
  }

  private async loadAll(): Promise<Result<WorkArticle[], StorageError>> {
    await this.ensureDirectory();

    let entries: string[];
    try {
      entries = await fs.readdir(this.workDir);
    } catch (error) {
      return err(new StorageError(`Failed to list work articles in ${this.workDir}`, { cause: String(error) }));
    }

    const articles: WorkArticle[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const articleResult = await this.readFromPath(path.join(this.workDir, entry));
      if (!articleResult.ok) {
        if (articleResult.error instanceof NotFoundError) continue;
        return articleResult;
      }
      articles.push(articleResult.value);
    }

    return ok(articles);
  }

  private async writeArticle(article: WorkArticle): Promise<Result<WorkArticle, StorageError>> {
    await this.ensureDirectory();

    const aliases = aliasesFromTags(article.tags);
    const migrationHash = migrationHashFromTags(article.tags);
    const frontmatter: Record<string, unknown> = {
      id: article.id,
      title: article.title,
      template: article.template,
      phase: article.phase,
      priority: article.priority,
      author: article.author,
      tags: [...article.tags],
      references: [...article.references],
      codeRefs: [...article.codeRefs],
      dependencies: [...article.dependencies],
      blockedBy: [...article.blockedBy],
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
      enrichmentRolesJson: JSON.stringify({ items: article.enrichmentRoles }),
      reviewersJson: JSON.stringify({ items: article.reviewers }),
      phaseHistoryJson: JSON.stringify({ items: article.phaseHistory }),
    };

    if (article.lead) frontmatter["lead"] = article.lead;
    if (article.assignee) frontmatter["assignee"] = article.assignee;
    if (article.completedAt) frontmatter["completedAt"] = article.completedAt;
    if (aliases.length > 0) frontmatter["aliases"] = aliases;
    if (migrationHash) frontmatter["migrationHash"] = migrationHash;

    try {
      await fs.writeFile(this.articlePath(article.id), serializeMarkdown(frontmatter, article.content), "utf-8");
      return ok(article);
    } catch (error) {
      return err(new StorageError(`Failed to write work article: ${article.id}`, { cause: String(error) }));
    }
  }

  private async getMutable(id: string): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>> {
    const existing = await this.findById(id);
    if (!existing.ok) return existing;
    if (TERMINAL_PHASES.has(existing.value.phase)) {
      return err(new StateTransitionError(existing.value.phase, "mutation", `Cannot modify article in terminal phase "${existing.value.phase}"`));
    }
    return existing;
  }

  async findById(id: string): Promise<Result<WorkArticle, NotFoundError | StorageError>> {
    return this.readFromPath(this.articlePath(id));
  }

  async findMany(_filter?: Record<string, unknown>): Promise<Result<WorkArticle[], StorageError>> {
    return this.loadAll();
  }

  async create(input: CreateWorkArticleInput): Promise<Result<WorkArticle, ValidationError | StorageError>> {
    const id = generateWorkId();
    const now = timestamp();
    const templateConfig = WORK_TEMPLATES[input.template];

    const article: WorkArticle = {
      id,
      title: input.title,
      template: input.template,
      phase: WorkPhase.PLANNING,
      priority: input.priority,
      author: input.author,
      lead: input.lead,
      assignee: undefined,
      enrichmentRoles: templateConfig.defaultEnrichmentRoles.map((role) => ({
        role,
        agentId: input.author,
        status: "pending" as const,
      })),
      reviewers: [],
      phaseHistory: [{ phase: WorkPhase.PLANNING, enteredAt: now }],
      tags: input.tags ?? [],
      references: [],
      codeRefs: [],
      dependencies: [],
      blockedBy: [],
      content: input.content ?? generateInitialContent(input.template),
      createdAt: now,
      updatedAt: now,
    };

    return this.writeArticle(article);
  }

  async update(
    id: string,
    input: UpdateWorkArticleInput,
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const existing = await this.getMutable(id);
    if (!existing.ok) return existing;

    const updated: WorkArticle = {
      ...existing.value,
      title: input.title ?? existing.value.title,
      priority: input.priority ?? existing.value.priority,
      lead: input.lead !== undefined ? input.lead : existing.value.lead,
      assignee: input.assignee !== undefined ? input.assignee : existing.value.assignee,
      tags: input.tags ?? existing.value.tags,
      references: input.references ?? existing.value.references,
      codeRefs: input.codeRefs ?? existing.value.codeRefs,
      content: input.content ?? existing.value.content,
      updatedAt: timestamp(),
    };

    return this.writeArticle(updated);
  }

  async delete(id: string): Promise<Result<void, NotFoundError | StateTransitionError | StorageError>> {
    const existing = await this.getMutable(id);
    if (!existing.ok) return existing;

    try {
      await fs.rm(this.articlePath(id), { force: true });
    } catch (error) {
      return err(new StorageError(`Failed to delete work article: ${id}`, { cause: String(error) }));
    }

    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;

    for (const article of allResult.value) {
      if (!article.blockedBy.includes(workId(id)) && !article.dependencies.includes(workId(id))) continue;
      const updated: WorkArticle = {
        ...article,
        blockedBy: article.blockedBy.filter((dep) => dep !== id),
        dependencies: article.dependencies.filter((dep) => dep !== id),
        updatedAt: timestamp(),
      };
      const writeResult = await this.writeArticle(updated);
      if (!writeResult.ok) return writeResult;
    }

    return ok(undefined);
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fs.access(this.articlePath(id));
      return true;
    } catch {
      return false;
    }
  }

  async findByPhase(phase: WorkPhaseType): Promise<Result<WorkArticle[], StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    return ok(allResult.value.filter((article) => article.phase === phase));
  }

  async findByAssignee(agentIdParam: AgentId): Promise<Result<WorkArticle[], StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    return ok(allResult.value.filter((article) => article.assignee === agentIdParam));
  }

  async findByPriority(priority: string): Promise<Result<WorkArticle[], StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    return ok(allResult.value.filter((article) => article.priority === priority));
  }

  async findActive(): Promise<Result<WorkArticle[], StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    return ok(allResult.value.filter((article) => !TERMINAL_PHASES.has(article.phase)));
  }

  async findBlocked(): Promise<Result<WorkArticle[], StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    return ok(allResult.value.filter((article) => article.blockedBy.length > 0));
  }

  async advancePhase(
    id: WorkId,
    targetPhase: WorkPhaseType,
  ): Promise<Result<WorkArticle, StateTransitionError | NotFoundError | StorageError>> {
    const existing = await this.findById(id);
    if (!existing.ok) return existing;

    const transitionResult = checkTransition(existing.value, targetPhase);
    if (!transitionResult.ok) return transitionResult;

    const now = timestamp();
    const updatedHistory = existing.value.phaseHistory.map((entry, index) =>
      index === existing.value.phaseHistory.length - 1 && !entry.exitedAt
        ? { ...entry, exitedAt: now }
        : entry,
    );

    const updated: WorkArticle = {
      ...existing.value,
      phase: targetPhase,
      phaseHistory: [...updatedHistory, { phase: targetPhase, enteredAt: now }],
      updatedAt: now,
      completedAt: targetPhase === WorkPhase.DONE ? now : existing.value.completedAt,
    };

    return this.writeArticle(updated);
  }

  async contributeEnrichment(
    id: WorkId,
    role: string,
    status: "contributed" | "skipped",
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const existing = await this.getMutable(id);
    if (!existing.ok) return existing;

    if (existing.value.phase !== WorkPhase.ENRICHMENT) {
      return err(new StateTransitionError(existing.value.phase, "contributeEnrichment", "Enrichment contributions are only accepted during the enrichment phase"));
    }

    const index = existing.value.enrichmentRoles.findIndex((entry) => entry.role === role);
    if (index === -1) {
      return err(new ValidationError(`Enrichment role "${role}" not found on this article`));
    }

    const now = timestamp();
    const updatedRoles = [...existing.value.enrichmentRoles];
    const current = updatedRoles[index]!;
    updatedRoles[index] = {
      role: current.role,
      agentId: current.agentId,
      status,
      contributedAt: now,
    };

    return this.writeArticle({
      ...existing.value,
      enrichmentRoles: updatedRoles,
      updatedAt: now,
    });
  }

  async assignReviewer(
    id: WorkId,
    reviewerAgentId: AgentId,
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const existing = await this.getMutable(id);
    if (!existing.ok) return existing;

    if (existing.value.reviewers.some((reviewer) => reviewer.agentId === reviewerAgentId)) {
      return err(new ValidationError(`Reviewer "${reviewerAgentId}" is already assigned`));
    }

    return this.writeArticle({
      ...existing.value,
      reviewers: [...existing.value.reviewers, { agentId: reviewerAgentId, status: "pending" }],
      updatedAt: timestamp(),
    });
  }

  async submitReview(
    id: WorkId,
    reviewerAgentId: AgentId,
    status: "approved" | "changes-requested",
  ): Promise<Result<WorkArticle, NotFoundError | ValidationError | StateTransitionError | StorageError>> {
    const existing = await this.getMutable(id);
    if (!existing.ok) return existing;

    if (existing.value.phase !== WorkPhase.REVIEW) {
      return err(new StateTransitionError(existing.value.phase, "submitReview", "Reviews are only accepted during the review phase"));
    }

    const index = existing.value.reviewers.findIndex((reviewer) => reviewer.agentId === reviewerAgentId);
    if (index === -1) {
      return err(new ValidationError(`Reviewer "${reviewerAgentId}" is not assigned to this article`));
    }

    const now = timestamp();
    const updatedReviewers = [...existing.value.reviewers];
    updatedReviewers[index] = {
      agentId: reviewerAgentId,
      status,
      reviewedAt: now,
    };

    return this.writeArticle({
      ...existing.value,
      reviewers: updatedReviewers,
      updatedAt: now,
    });
  }

  async addDependency(
    id: WorkId,
    blockedById: WorkId,
  ): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>> {
    const existing = await this.getMutable(id);
    if (!existing.ok) return existing;

    const blockerExists = await this.exists(blockedById);
    if (!blockerExists) {
      return err(new NotFoundError("WorkArticle", blockedById));
    }

    if (existing.value.blockedBy.includes(blockedById)) {
      return ok(existing.value);
    }

    const nextBlockedBy = [...existing.value.blockedBy, blockedById];
    const nextDependencies = existing.value.dependencies.includes(blockedById)
      ? existing.value.dependencies
      : [...existing.value.dependencies, blockedById];

    return this.writeArticle({
      ...existing.value,
      blockedBy: nextBlockedBy,
      dependencies: nextDependencies,
      updatedAt: timestamp(),
    });
  }

  async removeDependency(
    id: WorkId,
    blockedById: WorkId,
  ): Promise<Result<WorkArticle, NotFoundError | StateTransitionError | StorageError>> {
    const existing = await this.getMutable(id);
    if (!existing.ok) return existing;

    return this.writeArticle({
      ...existing.value,
      blockedBy: existing.value.blockedBy.filter((dep) => dep !== blockedById),
      dependencies: existing.value.dependencies.filter((dep) => dep !== blockedById),
      updatedAt: timestamp(),
    });
  }
}
