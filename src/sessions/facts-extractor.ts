import type { Result } from "../core/result.js";
import { ok } from "../core/result.js";
import type { StorageError } from "../core/errors.js";
import { timestamp } from "../core/types.js";
import type { Timestamp } from "../core/types.js";
import type { CommandRunner } from "../ops/command-runner.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { OrchestrationEventRepository } from "../orchestration/repository.js";
import type { WorkArticleRepository } from "../work/repository.js";
import type { Session } from "./repository.js";
import {
  type DiffSignals,
  extractDiffSignals,
  listCodeTouchedSinceBase,
  listCommitsInWindow,
  resolveBaseSha,
} from "./facts-extractor-git.js";
import { joinWorkTouched } from "./facts-extractor-joins.js";
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

export interface DefaultFactsExtractorDeps {
  readonly eventRepo: OrchestrationEventRepository;
  readonly workRepo: WorkArticleRepository;
  readonly knowledgeRepo: KnowledgeArticleRepository;
  readonly runner: CommandRunner;
  /** Cap on how many recent events to scan when filtering to the window. Default 500. */
  readonly recentEventsLimit?: number;
}

const DEFAULT_RECENT_EVENTS_LIMIT = 500;

/**
 * Production Stage A extractor. Joins six data sources (events, work,
 * knowledge, commits, code diff, diff-based signals) into a `SessionFacts`
 * payload that downstream LLM stages can ground their citations against.
 *
 * Hard rules:
 * - Pure dependency injection. No singletons, no module-level state.
 * - Git failures degrade to empty arrays — never aborts the pipeline.
 * - Cross-agent events are filtered out so a session for `claude-code`
 *   never inherits hypergraph entries authored by `codex-cli`.
 * - The just-generated handoff article is excluded from `knowledgeTouched`
 *   (filter on `category === "handoff"`) to avoid recursive self-reference.
 */
export class DefaultFactsExtractor implements FactsExtractor {
  constructor(private readonly deps: DefaultFactsExtractorDeps) {}

  async extract(
    session: Session,
    agentNote: string | null,
  ): Promise<Result<SessionFacts, StorageError>> {
    const closedAt: Timestamp = session.closedAt ?? timestamp();
    const limit = this.deps.recentEventsLimit ?? DEFAULT_RECENT_EVENTS_LIMIT;

    const windowResult = await this.deps.eventRepo.findInWindow(
      session.openedAt,
      closedAt,
      limit,
    );
    const windowEvents = windowResult.ok ? windowResult.value : [];
    const eventsInWindow = windowEvents.filter(
      (e) => e.agentId === undefined || e.agentId === session.agentId,
    );

    const workTouched = await joinWorkTouched({
      events: eventsInWindow,
      workRepo: this.deps.workRepo,
      agentId: session.agentId,
      openedAt: session.openedAt,
      closedAt,
    });

    const knowledgeResult = await this.deps.knowledgeRepo.findUpdatedSince(session.openedAt);
    const knowledgeTouched = knowledgeResult.ok
      ? knowledgeResult.value
          .filter((a) => a.category !== "handoff")
          .filter((a) => a.updatedAt <= closedAt)
          .map((a) => ({
            id: a.id,
            slug: a.slug,
            title: a.title,
            category: a.category,
            op:
              a.createdAt >= session.openedAt && a.createdAt <= closedAt
                ? ("created" as const)
                : ("updated" as const),
          }))
      : [];

    const baseShaResult = await resolveBaseSha({
      repo: session.repo,
      openedAt: session.openedAt,
      runner: this.deps.runner,
    });
    const baseSha = baseShaResult.ok ? baseShaResult.value : null;

    const commitsResult = await listCommitsInWindow({
      repo: session.repo,
      openedAt: session.openedAt,
      closedAt,
      runner: this.deps.runner,
    });
    const commits = commitsResult.ok ? commitsResult.value : [];

    let codeTouched: SessionFacts["codeTouched"] = [];
    let diffSignals: DiffSignals = { todosAdded: [], questions: [] };
    if (baseSha !== null) {
      const codeResult = await listCodeTouchedSinceBase({
        repo: session.repo,
        baseSha,
        runner: this.deps.runner,
      });
      if (codeResult.ok) codeTouched = codeResult.value;

      const signalsResult = await extractDiffSignals({
        repo: session.repo,
        baseSha,
        runner: this.deps.runner,
      });
      if (signalsResult.ok) diffSignals = signalsResult.value;
    }

    const testFailures = eventsInWindow
      .filter((e) => {
        if (e.eventType !== "agent_failed") return false;
        const role = (e.details as { role?: unknown }).role;
        return typeof role === "string" && role === "testing";
      })
      .map((e) => ({ event: e.id, details: JSON.stringify(e.details) }));

    const facts: SessionFacts = {
      sessionId: session.id,
      agent: session.agentId,
      repo: session.repo,
      branch: session.branch,
      window: { openedAt: session.openedAt, closedAt },
      events: eventsInWindow.map((e) => ({
        id: e.id,
        type: e.eventType,
        ...(e.workId !== undefined ? { workId: e.workId } : {}),
        ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
        timestamp: e.createdAt,
        details: e.details,
      })),
      workTouched,
      knowledgeTouched,
      codeTouched,
      commits,
      signals: {
        todosAdded: diffSignals.todosAdded.map((s) => ({
          path: s.path,
          line: s.line,
          text: s.text,
        })),
        questions: diffSignals.questions.map((s) => ({
          path: s.path,
          line: s.line,
          text: s.text,
        })),
        testFailures,
      },
      agentNote,
    };
    return ok(facts);
  }
}
