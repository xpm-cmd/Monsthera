import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { NotFoundError, StateTransitionError, StorageError } from "../core/errors.js";
import type { ValidationError } from "../core/errors.js";
import type { SessionId, AgentId, Timestamp } from "../core/types.js";
import { sessionId as makeSessionId, agentId as makeAgentId, timestamp as makeTimestamp } from "../core/types.js";
import {
  SessionStatus,
  validateSessionFrontmatter,
  validateSessionFacts,
  type SessionFacts,
  type SessionFrontmatter,
} from "./schemas.js";
import type {
  Session,
  SessionRepository,
  CreateSessionRecord,
  CloseSessionRecord,
  AbandonSessionRecord,
  AttachHandoffRecord,
  SessionListFilter,
} from "./repository.js";

/**
 * Filesystem-backed SessionRepository.
 *
 * Storage choice (intentional deviation from the original plan):
 *   - Session records live as JSON files (`knowledge/sessions/<id>.json`),
 *     not as YAML-frontmatter Markdown. The existing `knowledge/markdown.ts`
 *     serializer is intentionally naive (flat key:value, no null support, no
 *     nested objects); supporting Session's nested `quality` object and
 *     pervasive null-valued fields would require either a YAML library or a
 *     bespoke serializer. JSON is the honest fit for operational state.
 *   - Stage A facts live alongside as `<id>.facts.json` (this part matches
 *     the plan).
 *   - Handoff articles (phase 3) remain Markdown knowledge articles —
 *     narrative content belongs in the corpus, not in operational storage.
 */
/**
 * Worktree fallback (added 2026-05-16):
 *
 * When constructed with `fallbackMarkdownRoot` (the main repo's
 * knowledge dir, resolved via `git rev-parse --git-common-dir`), the
 * repository aggregates reads from BOTH the worktree's `sessions/`
 * and the main repo's `sessions/`. Writes go ONLY to the primary —
 * the feature branch keeps its own session history committed
 * alongside the work that produced it.
 *
 * `findOpen` deliberately stays primary-only: an "open" session in
 * another worktree is not this worktree's to supersede.
 */
export class FileSystemSessionRepository implements SessionRepository {
  constructor(
    private readonly markdownRoot: string,
    private readonly fallbackMarkdownRoot: string | null = null,
  ) {}

  private get dir(): string {
    // `markdownRoot` already includes the `knowledge` segment from config
    // (`config.storage.markdownRoot` defaults to "knowledge"). Mirror the
    // FileSystemWorkArticleRepository pattern of joining a single bucket
    // directory beneath markdownRoot.
    return path.join(this.markdownRoot, "sessions");
  }

  private get fallbackDir(): string | null {
    return this.fallbackMarkdownRoot === null
      ? null
      : path.join(this.fallbackMarkdownRoot, "sessions");
  }

  private sessionPathIn(baseDir: string, id: string): string {
    return path.join(baseDir, `${id}.json`);
  }

  private factsPathIn(baseDir: string, id: string): string {
    return path.join(baseDir, `${id}.facts.json`);
  }

  private sessionPath(id: string): string {
    return this.sessionPathIn(this.dir, id);
  }

  private factsPath(id: string): string {
    return this.factsPathIn(this.dir, id);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private toFrontmatter(s: Session): SessionFrontmatter {
    return {
      id: s.id,
      agentId: s.agentId,
      repo: s.repo,
      branch: s.branch,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      status: s.status,
      handoffArticleId: s.handoffArticleId,
      factsPath: s.factsPath,
      parentSessionId: s.parentSessionId,
      abandonReason: s.abandonReason,
      quality: {
        score: s.quality.score,
        degraded: s.quality.degraded,
        model: s.quality.model,
      },
      intent: s.intent,
    };
  }

  private fromFrontmatter(fm: SessionFrontmatter): Session {
    return {
      id: makeSessionId(fm.id),
      agentId: makeAgentId(fm.agentId),
      repo: fm.repo,
      branch: fm.branch,
      openedAt: makeTimestamp(fm.openedAt),
      closedAt: fm.closedAt === null ? null : makeTimestamp(fm.closedAt),
      status: fm.status,
      handoffArticleId: fm.handoffArticleId,
      factsPath: fm.factsPath,
      parentSessionId: fm.parentSessionId === null ? null : makeSessionId(fm.parentSessionId),
      abandonReason: fm.abandonReason as Session["abandonReason"],
      quality: { score: fm.quality.score, degraded: fm.quality.degraded, model: fm.quality.model },
      intent: fm.intent,
    };
  }

  private async writeSession(s: Session): Promise<Result<void, StorageError>> {
    await this.ensureDir();
    const fm = this.toFrontmatter(s);
    try {
      await fs.writeFile(this.sessionPath(s.id), JSON.stringify(fm, null, 2), "utf-8");
      return ok(undefined);
    } catch (error) {
      return err(new StorageError(`Failed to write session ${s.id}`, { cause: String(error) }));
    }
  }

  private async readSessionFrom(
    baseDir: string,
    id: string,
  ): Promise<Result<Session, NotFoundError | StorageError>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.sessionPathIn(baseDir, id), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return err(new NotFoundError("Session", id));
      }
      return err(new StorageError(`Failed to read session ${id}`, { cause: String(error) }));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return err(new StorageError(`Failed to parse session ${id}`, { cause: String(error) }));
    }
    const validated = validateSessionFrontmatter(parsed);
    if (!validated.ok) {
      return err(new StorageError(`Session ${id} on disk is malformed`, { issues: validated.error.details }));
    }
    return ok(this.fromFrontmatter(validated.value));
  }

  private async readSession(id: string): Promise<Result<Session, NotFoundError | StorageError>> {
    // Primary first. If the session lives in the worktree, this hits; we
    // never pay for a second filesystem read. Only when the worktree has
    // no record of this id do we consult the fallback.
    const primary = await this.readSessionFrom(this.dir, id);
    if (primary.ok) return primary;
    if (this.fallbackDir === null) return primary;
    if (primary.error.code !== "NOT_FOUND") return primary;
    return this.readSessionFrom(this.fallbackDir, id);
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  async create(
    record: CreateSessionRecord,
  ): Promise<Result<Session, ValidationError | StorageError>> {
    const session: Session = {
      id: record.id,
      agentId: record.agentId,
      repo: record.repo,
      branch: record.branch,
      openedAt: record.openedAt,
      closedAt: null,
      status: SessionStatus.OPEN,
      handoffArticleId: null,
      factsPath: null,
      parentSessionId: record.parentSessionId,
      abandonReason: null,
      quality: { score: null, degraded: false, model: null },
      intent: record.intent,
    };
    const wrote = await this.writeSession(session);
    if (!wrote.ok) return wrote;
    return ok(session);
  }

  async close(
    id: SessionId,
    record: CloseSessionRecord,
  ): Promise<Result<Session, NotFoundError | StateTransitionError | StorageError>> {
    const existing = await this.readSession(id);
    if (!existing.ok) return existing;
    const s = existing.value;
    if (s.status === SessionStatus.CLOSED) return ok(s);
    if (s.status === SessionStatus.ABANDONED) {
      return err(
        new StateTransitionError(
          s.status,
          SessionStatus.CLOSED,
          "Cannot close an abandoned session",
        ),
      );
    }
    const updated: Session = {
      ...s,
      status: SessionStatus.CLOSED,
      closedAt: record.closedAt as Timestamp,
      factsPath: record.factsPath,
      quality: { ...s.quality, degraded: record.qualityDegraded },
    };
    const wrote = await this.writeSession(updated);
    if (!wrote.ok) return wrote;
    return ok(updated);
  }

  async abandon(
    id: SessionId,
    record: AbandonSessionRecord,
  ): Promise<Result<Session, NotFoundError | StateTransitionError | StorageError>> {
    const existing = await this.readSession(id);
    if (!existing.ok) return existing;
    const s = existing.value;
    if (s.status === SessionStatus.ABANDONED) return ok(s);
    if (s.status === SessionStatus.CLOSED) {
      return err(
        new StateTransitionError(
          s.status,
          SessionStatus.ABANDONED,
          "Cannot abandon a session that already closed normally",
        ),
      );
    }
    const updated: Session = {
      ...s,
      status: SessionStatus.ABANDONED,
      closedAt: record.closedAt as Timestamp,
      abandonReason: record.reason,
    };
    const wrote = await this.writeSession(updated);
    if (!wrote.ok) return wrote;
    return ok(updated);
  }

  async attachHandoff(
    id: SessionId,
    record: AttachHandoffRecord,
  ): Promise<Result<Session, NotFoundError | StateTransitionError | StorageError>> {
    const existing = await this.readSession(id);
    if (!existing.ok) return existing;
    const s = existing.value;
    if (s.status !== SessionStatus.CLOSED) {
      return err(
        new StateTransitionError(
          s.status,
          "attach_handoff",
          "Handoff can only be attached to a closed session",
        ),
      );
    }
    const updated: Session = {
      ...s,
      handoffArticleId: record.handoffArticleId,
      quality: {
        score: record.qualityScore,
        degraded: record.qualityDegraded,
        model: record.qualityModel,
      },
    };
    const wrote = await this.writeSession(updated);
    if (!wrote.ok) return wrote;
    return ok(updated);
  }

  async findById(id: SessionId): Promise<Result<Session, NotFoundError | StorageError>> {
    return this.readSession(id);
  }

  /**
   * Read sessions from a single directory, applying the filter. Used as
   * the building block for both `findOpen` (primary-only) and
   * `findMany` (primary + fallback merged).
   */
  private async findManyInDir(
    baseDir: string,
    filter?: SessionListFilter,
  ): Promise<Result<Session[], StorageError>> {
    let entries: string[];
    try {
      entries = await fs.readdir(baseDir);
    } catch (error) {
      // Missing directory is not a read failure — treat as empty so the
      // fallback path stays untouched until something writes to it.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
      return err(new StorageError(`Failed to list sessions dir`, { cause: String(error) }));
    }
    const sessionFiles = entries.filter((e) => e.endsWith(".json") && !e.endsWith(".facts.json"));
    const results: Session[] = [];
    for (const f of sessionFiles) {
      const id = f.slice(0, -".json".length);
      const r = await this.readSessionFrom(baseDir, id);
      if (r.ok) results.push(r.value);
    }

    let filtered = results;
    if (filter?.agentId !== undefined) filtered = filtered.filter((s) => s.agentId === filter.agentId);
    if (filter?.repo !== undefined) filtered = filtered.filter((s) => s.repo === filter.repo);
    if (filter?.status !== undefined) filtered = filtered.filter((s) => s.status === filter.status);
    return ok(filtered);
  }

  async findMany(filter?: SessionListFilter): Promise<Result<Session[], StorageError>> {
    const primary = await this.findManyInDir(this.dir, filter);
    if (!primary.ok) return primary;

    let merged: Session[] = primary.value;
    if (this.fallbackDir !== null) {
      const fallback = await this.findManyInDir(this.fallbackDir, filter);
      // Soft-fail: a missing fallback dir is not a primary-read failure;
      // surface the primary result so the caller stays productive.
      if (fallback.ok) {
        const seen = new Set(merged.map((s) => s.id));
        for (const s of fallback.value) {
          if (!seen.has(s.id)) {
            seen.add(s.id);
            merged.push(s);
          }
        }
      }
    }

    merged.sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0));
    if (filter?.limit !== undefined) merged = merged.slice(0, filter.limit);
    return ok(merged);
  }

  async findOpen(
    agentIdArg: AgentId,
    repo: string,
  ): Promise<Result<Session | null, StorageError>> {
    // Primary-only: an "open" session in another worktree is not this
    // worktree's to supersede. Reading the fallback here would cause
    // spurious abandons of unrelated agents' active work.
    const filter = { agentId: agentIdArg, repo, status: SessionStatus.OPEN };
    const primary = await this.findManyInDir(this.dir, filter);
    if (!primary.ok) return primary;
    return ok(primary.value[0] ?? null);
  }

  async findLatestClosed(
    agentIdArg: AgentId,
    repo: string,
  ): Promise<Result<Session | null, StorageError>> {
    // Uses findMany so the fallback dir is consulted — cross-worktree
    // parent discovery is exactly what this method exists for.
    const all = await this.findMany({ agentId: agentIdArg, repo, status: SessionStatus.CLOSED });
    if (!all.ok) return all;
    const withClosedAt = all.value.filter((s) => s.closedAt !== null);
    withClosedAt.sort((a, b) => {
      const aT = a.closedAt ?? "";
      const bT = b.closedAt ?? "";
      return aT < bT ? 1 : aT > bT ? -1 : 0;
    });
    return ok(withClosedAt[0] ?? null);
  }

  async saveFacts(id: SessionId, facts: SessionFacts): Promise<Result<string, StorageError>> {
    await this.ensureDir();
    const fp = this.factsPath(id);
    try {
      await fs.writeFile(fp, JSON.stringify(facts, null, 2), "utf-8");
      return ok(fp);
    } catch (error) {
      return err(new StorageError(`Failed to write facts ${id}`, { cause: String(error) }));
    }
  }

  private async loadFactsFrom(
    baseDir: string,
    id: SessionId,
  ): Promise<Result<SessionFacts, NotFoundError | StorageError>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.factsPathIn(baseDir, id), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return err(new NotFoundError("SessionFacts", id));
      }
      return err(new StorageError(`Failed to read facts ${id}`, { cause: String(error) }));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return err(new StorageError(`Failed to parse facts ${id}`, { cause: String(error) }));
    }
    const validated = validateSessionFacts(parsed);
    if (!validated.ok) {
      return err(new StorageError(`Facts ${id} on disk are malformed`, { issues: validated.error.details }));
    }
    return ok(validated.value);
  }

  async loadFacts(id: SessionId): Promise<Result<SessionFacts, NotFoundError | StorageError>> {
    const primary = await this.loadFactsFrom(this.dir, id);
    if (primary.ok) return primary;
    if (this.fallbackDir === null) return primary;
    if (primary.error.code !== "NOT_FOUND") return primary;
    return this.loadFactsFrom(this.fallbackDir, id);
  }
}
