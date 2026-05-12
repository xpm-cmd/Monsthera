import type { Result } from "../core/result.js";
import type { SessionId, AgentId, Timestamp } from "../core/types.js";
import type { NotFoundError, StateTransitionError, StorageError, ValidationError } from "../core/errors.js";
import type { SessionStatus, SessionFacts, AbandonmentReason } from "./schemas.js";

// ─── Session entity ──────────────────────────────────────────────────────────

export interface SessionQualityState {
  readonly score: number | null;
  readonly degraded: boolean;
  readonly model: string | null;
}

export interface Session {
  readonly id: SessionId;
  readonly agentId: AgentId;
  readonly repo: string;
  readonly branch: string | null;
  readonly openedAt: Timestamp;
  readonly closedAt: Timestamp | null;
  readonly status: SessionStatus;
  readonly handoffArticleId: string | null;
  readonly factsPath: string | null;
  readonly parentSessionId: SessionId | null;
  readonly abandonReason: AbandonmentReason | null;
  readonly quality: SessionQualityState;
  readonly intent: string | null;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface CreateSessionRecord {
  readonly id: SessionId;
  readonly agentId: AgentId;
  readonly repo: string;
  readonly branch: string | null;
  readonly openedAt: Timestamp;
  readonly intent: string | null;
  readonly parentSessionId: SessionId | null;
}

export interface CloseSessionRecord {
  readonly closedAt: Timestamp;
  readonly factsPath: string;
  readonly qualityDegraded: boolean;
}

export interface AbandonSessionRecord {
  readonly closedAt: Timestamp;
  readonly reason: AbandonmentReason;
}

export interface AttachHandoffRecord {
  readonly handoffArticleId: string;
  readonly qualityScore: number | null;
  readonly qualityModel: string | null;
  readonly qualityDegraded: boolean;
}

export interface SessionListFilter {
  readonly agentId?: AgentId;
  readonly repo?: string;
  readonly status?: SessionStatus;
  readonly limit?: number;
}

// ─── Repository interface ─────────────────────────────────────────────────────

export interface SessionRepository {
  /** Persist a brand-new Session in `open` status. */
  create(
    record: CreateSessionRecord,
  ): Promise<Result<Session, ValidationError | StorageError>>;

  /** Mark a Session as `closed`. Idempotent if already closed (returns existing). */
  close(
    id: SessionId,
    record: CloseSessionRecord,
  ): Promise<Result<Session, NotFoundError | StateTransitionError | StorageError>>;

  /** Mark a Session as `abandoned` with a reason. Idempotent if already terminal. */
  abandon(
    id: SessionId,
    record: AbandonSessionRecord,
  ): Promise<Result<Session, NotFoundError | StateTransitionError | StorageError>>;

  /** Attach handoff article + quality metadata to an already-closed Session. */
  attachHandoff(
    id: SessionId,
    record: AttachHandoffRecord,
  ): Promise<Result<Session, NotFoundError | StateTransitionError | StorageError>>;

  /** Lookup by ID. */
  findById(id: SessionId): Promise<Result<Session, NotFoundError | StorageError>>;

  /** List sessions matching a filter, newest first. */
  findMany(filter?: SessionListFilter): Promise<Result<Session[], StorageError>>;

  /**
   * Find the single open Session for an (agent, repo) pair, if any.
   * Returns null if none. Returns the first match in case the invariant
   * is violated (shouldn't happen — open Sessions are auto-superseded).
   */
  findOpen(
    agentId: AgentId,
    repo: string,
  ): Promise<Result<Session | null, StorageError>>;

  /**
   * Find the most-recent CLOSED Session for an (agent, repo) pair, if any.
   * Used as parentSessionId target and as "last handoff" lookup. Returns
   * null if none.
   */
  findLatestClosed(
    agentId: AgentId,
    repo: string,
  ): Promise<Result<Session | null, StorageError>>;

  /** Persist Stage A facts as JSON next to the Session record. Returns the absolute path. */
  saveFacts(id: SessionId, facts: SessionFacts): Promise<Result<string, StorageError>>;

  /** Read previously-saved facts.json. */
  loadFacts(id: SessionId): Promise<Result<SessionFacts, NotFoundError | StorageError>>;
}
