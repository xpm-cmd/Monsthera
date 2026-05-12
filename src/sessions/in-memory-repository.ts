import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { NotFoundError, StateTransitionError } from "../core/errors.js";
import type { StorageError, ValidationError } from "../core/errors.js";
import type { SessionId, AgentId } from "../core/types.js";
import { SessionStatus, type SessionFacts } from "./schemas.js";
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
 * In-memory implementation of SessionRepository.
 *
 * Used in tests and by the runtime's degraded mode (Dolt unreachable). State
 * lives in a Map keyed by SessionId. `saveFacts` keeps the JSON payload in a
 * second Map; the "path" returned is a synthetic string so the in-memory and
 * file-backed repos share a uniform API surface.
 */
export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, Session>();
  private readonly factsByKey = new Map<string, SessionFacts>();

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
    this.sessions.set(record.id, session);
    return ok(session);
  }

  async close(
    id: SessionId,
    record: CloseSessionRecord,
  ): Promise<Result<Session, NotFoundError | StateTransitionError | StorageError>> {
    const existing = this.sessions.get(id);
    if (!existing) return err(new NotFoundError("Session", id));
    if (existing.status === SessionStatus.CLOSED) return ok(existing); // idempotent
    if (existing.status === SessionStatus.ABANDONED) {
      return err(
        new StateTransitionError(
          existing.status,
          SessionStatus.CLOSED,
          "Cannot close an abandoned session",
        ),
      );
    }
    const updated: Session = {
      ...existing,
      status: SessionStatus.CLOSED,
      closedAt: record.closedAt,
      factsPath: record.factsPath,
      quality: { ...existing.quality, degraded: record.qualityDegraded },
    };
    this.sessions.set(id, updated);
    return ok(updated);
  }

  async abandon(
    id: SessionId,
    record: AbandonSessionRecord,
  ): Promise<Result<Session, NotFoundError | StateTransitionError | StorageError>> {
    const existing = this.sessions.get(id);
    if (!existing) return err(new NotFoundError("Session", id));
    if (existing.status === SessionStatus.ABANDONED) return ok(existing); // idempotent
    if (existing.status === SessionStatus.CLOSED) {
      return err(
        new StateTransitionError(
          existing.status,
          SessionStatus.ABANDONED,
          "Cannot abandon a session that already closed normally",
        ),
      );
    }
    const updated: Session = {
      ...existing,
      status: SessionStatus.ABANDONED,
      closedAt: record.closedAt,
      abandonReason: record.reason,
    };
    this.sessions.set(id, updated);
    return ok(updated);
  }

  async attachHandoff(
    id: SessionId,
    record: AttachHandoffRecord,
  ): Promise<Result<Session, NotFoundError | StateTransitionError | StorageError>> {
    const existing = this.sessions.get(id);
    if (!existing) return err(new NotFoundError("Session", id));
    if (existing.status !== SessionStatus.CLOSED) {
      return err(
        new StateTransitionError(
          existing.status,
          "attach_handoff",
          "Handoff can only be attached to a closed session",
        ),
      );
    }
    const updated: Session = {
      ...existing,
      handoffArticleId: record.handoffArticleId,
      quality: {
        score: record.qualityScore,
        degraded: record.qualityDegraded,
        model: record.qualityModel,
      },
    };
    this.sessions.set(id, updated);
    return ok(updated);
  }

  async findById(id: SessionId): Promise<Result<Session, NotFoundError | StorageError>> {
    const found = this.sessions.get(id);
    if (!found) return err(new NotFoundError("Session", id));
    return ok(found);
  }

  async findMany(filter?: SessionListFilter): Promise<Result<Session[], StorageError>> {
    let results = [...this.sessions.values()];
    if (filter?.agentId !== undefined) results = results.filter((s) => s.agentId === filter.agentId);
    if (filter?.repo !== undefined) results = results.filter((s) => s.repo === filter.repo);
    if (filter?.status !== undefined) results = results.filter((s) => s.status === filter.status);
    results.sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0));
    if (filter?.limit !== undefined) results = results.slice(0, filter.limit);
    return ok(results);
  }

  async findOpen(
    agentId: AgentId,
    repo: string,
  ): Promise<Result<Session | null, StorageError>> {
    for (const s of this.sessions.values()) {
      if (s.agentId === agentId && s.repo === repo && s.status === SessionStatus.OPEN) {
        return ok(s);
      }
    }
    return ok(null);
  }

  async findLatestClosed(
    agentId: AgentId,
    repo: string,
  ): Promise<Result<Session | null, StorageError>> {
    const closed = [...this.sessions.values()].filter(
      (s) => s.agentId === agentId && s.repo === repo && s.status === SessionStatus.CLOSED && s.closedAt !== null,
    );
    if (closed.length === 0) return ok(null);
    closed.sort((a, b) => {
      const aT = a.closedAt ?? "";
      const bT = b.closedAt ?? "";
      return aT < bT ? 1 : aT > bT ? -1 : 0;
    });
    return ok(closed[0] ?? null);
  }

  async saveFacts(id: SessionId, facts: SessionFacts): Promise<Result<string, StorageError>> {
    this.factsByKey.set(id, facts);
    return ok(`memory://${id}.facts.json`);
  }

  async loadFacts(id: SessionId): Promise<Result<SessionFacts, NotFoundError | StorageError>> {
    const found = this.factsByKey.get(id);
    if (!found) return err(new NotFoundError("SessionFacts", id));
    return ok(found);
  }
}
