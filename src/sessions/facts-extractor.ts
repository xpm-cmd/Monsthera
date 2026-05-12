import type { Result } from "../core/result.js";
import { ok } from "../core/result.js";
import type { StorageError } from "../core/errors.js";
import type { Session } from "./repository.js";
import type { SessionFacts } from "./schemas.js";

/**
 * Stage A — Extraction. Produces the deterministic `SessionFacts` artifact
 * that downstream LLM stages (B retrospect, C prospect) consume.
 *
 * Phase 1 ships only the interface plus a minimal stub. The production
 * extractor — which joins events, work-articles, knowledge mutations, code
 * impact, git diff stats, and TODO/question/test-failure signals — lands in
 * Phase 3 alongside the Ollama summarizer that consumes its output.
 *
 * The interface stays stable across phases so Phase 1 wiring does not have
 * to change when the real extractor lands.
 */
export interface FactsExtractor {
  /**
   * Build a `SessionFacts` payload for a session that has just closed.
   * `agentNote` is the optional one-line intent string the agent passed at
   * `session close --note`. It is plumbed through unchanged so downstream
   * stages can use it without re-reading the Session record.
   */
  extract(
    session: Session,
    agentNote: string | null,
  ): Promise<Result<SessionFacts, StorageError>>;
}

/**
 * Minimal extractor for Phase 1: returns a well-formed SessionFacts skeleton
 * with just the lifecycle window and the agent's note. Downstream consumers
 * (briefing renderer, LLM pipeline) can read this without crashing, and the
 * real Phase 3 extractor swaps in without changing call sites.
 */
export class MinimalFactsExtractor implements FactsExtractor {
  async extract(
    session: Session,
    agentNote: string | null,
  ): Promise<Result<SessionFacts, StorageError>> {
    const closedAt = session.closedAt ?? new Date().toISOString();
    const facts: SessionFacts = {
      sessionId: session.id,
      agent: session.agentId,
      repo: session.repo,
      branch: session.branch,
      window: { openedAt: session.openedAt, closedAt },
      events: [],
      workTouched: [],
      knowledgeTouched: [],
      codeTouched: [],
      commits: [],
      signals: { todosAdded: [], questions: [], testFailures: [] },
      agentNote,
    };
    return ok(facts);
  }
}
