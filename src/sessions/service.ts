import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { NotFoundError, StateTransitionError, StorageError, ValidationError } from "../core/errors.js";
import type { SessionId, AgentId, Timestamp } from "../core/types.js";
import { generateSessionId, timestamp } from "../core/types.js";
import { AbandonmentReason, SessionStatus, type SessionFacts } from "./schemas.js";
import type { Session, SessionRepository, SessionListFilter } from "./repository.js";
import type { FactsExtractor } from "./facts-extractor.js";
import type { LLMSummarizer, LLMSummary, LLMQualityEval } from "./llm-summarizer.js";
import { pruneSummaryCitations } from "./citation-validator.js";
import {
  buildHandoffSlug,
  buildHandoffTags,
  buildHandoffTitle,
  parseHandoffSections,
  renderBriefStandard,
  renderBriefTeaser,
  renderHandoffArticle,
  renderOrphanBrief,
} from "./handoff-renderer.js";
import {
  evaluateHandoffCoverage,
  renderCoverageSection,
} from "./coverage-validator.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { KnowledgeArticle } from "../knowledge/repository.js";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

// ─── Service inputs ───────────────────────────────────────────────────────────

export interface OpenSessionInput {
  readonly agentId: AgentId;
  readonly repo: string;
  readonly branch?: string | null;
  readonly intent?: string | null;
  readonly openedAt?: string;
}

export interface CloseSessionInput {
  /** Explicit session to close. If absent, the open session for (agentId, repo) is resolved. */
  readonly sessionId?: SessionId;
  readonly agentId?: AgentId;
  readonly repo?: string;
  readonly note?: string | null;
  readonly closedAt?: string;
  /** Skip the LLM pipeline (Stages B/C/D). Persists a T1-only handoff article. */
  readonly noLlm?: boolean;
  /**
   * Run Stages B/C/D + render + persist synchronously before returning.
   * Default `true` for direct service callers (tests, programmatic use).
   * The CLI flips this to `false` so `monsthera session close` returns in
   * ~100ms and the worker runs in a detached subprocess.
   */
  readonly sync?: boolean;
}

export interface OpenSessionOutput {
  readonly session: Session;
  /** Previous session that was auto-superseded (abandoned), if any. */
  readonly superseded: Session | null;
  /** Parent session pointer that was set (null if first session for this (agent, repo)). */
  readonly parent: Session | null;
  /**
   * Set when the previous closed session for this (agent, repo) was orphaned
   * (status=closed but handoffArticleId=null). Surfaced by the CLI in the
   * teaser so the next agent sees "the previous handoff did not finish".
   */
  readonly previousOrphan: Session | null;
}

export interface CloseSessionOutput {
  readonly session: Session;
  readonly facts: SessionFacts;
  /** LLM summary if the pipeline ran synchronously, else null. */
  readonly summary: LLMSummary | null;
  /** Self-eval score if Stage D ran, else null. */
  readonly evalResult: LLMQualityEval | null;
  /**
   * Article id (slug) when the pipeline ran inline. `null` in async dispatch
   * — the worker will populate `Session.handoffArticleId` later.
   */
  readonly handoffArticleId: string | null;
  /** True if Ollama was unreachable, --no-llm was set, or the LLM step is deferred to a worker. */
  readonly degraded: boolean;
  /** True if the caller dispatched an async worker and did not wait for it. */
  readonly asyncDispatched: boolean;
}

/** Output of the LLM pipeline (Stages B/C/D + render + persist + attach). */
export interface HandoffPipelineOutput {
  readonly session: Session;
  readonly summary: LLMSummary | null;
  readonly evalResult: LLMQualityEval | null;
  readonly handoffArticleId: string;
  readonly degraded: boolean;
}

// ─── Brief inputs / outputs ───────────────────────────────────────────────────

export type BriefDepth = "teaser" | "standard" | "full";

export interface BriefSessionInput {
  /** Explicit session to brief. If absent, the latest CLOSED for (agentId, repo) is used. */
  readonly sessionId?: SessionId;
  readonly agentId?: AgentId;
  readonly repo?: string;
  readonly depth: BriefDepth;
  /** When provided, the output includes counts of CLOSED sessions by OTHER agents since this timestamp. */
  readonly since?: Timestamp;
}

/** Counts of closed sessions per OTHER agent since the cutoff timestamp. */
export interface CrossAgentDelta {
  readonly since: Timestamp;
  /** Map of agentId → count of CLOSED sessions in the same repo, since the cutoff. */
  readonly byAgent: Record<string, number>;
}

export interface BriefSessionOutput {
  readonly session: Session;
  readonly handoffArticle: KnowledgeArticle | null;
  readonly body: string;
  readonly crossAgentDelta: CrossAgentDelta | null;
}

// ─── Optional clock + summarizer + knowledge for tests ────────────────────────

export interface SessionServiceDeps {
  readonly now?: () => Date;
  /** Optional LLM summarizer for Stages B/C/D. If absent, all closes run T1-only. */
  readonly summarizer?: LLMSummarizer | null;
  /** Knowledge service used to persist the handoff article. */
  readonly knowledgeService?: KnowledgeService | null;
  /**
   * Resolves the absolute path of the current process's entry script
   * (`process.argv[1]`). Override in tests where we don't want to spawn
   * a real subprocess. Returning `null` disables async dispatch (the
   * service falls back to sync).
   */
  readonly resolveWorkerScript?: () => string | null;
  /**
   * Spawn function used to dispatch the async handoff worker. Defaults to
   * `child_process.spawn`. Override in tests to record invocations.
   */
  readonly spawnWorker?: (cmd: string, args: string[], cwd?: string) => { unref(): void };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class SessionService {
  private readonly now: () => Date;
  private readonly summarizer: LLMSummarizer | null;
  private readonly knowledgeService: KnowledgeService | null;
  private readonly resolveWorkerScript: () => string | null;
  private readonly spawnWorker: (cmd: string, args: string[], cwd?: string) => { unref(): void };

  constructor(
    private readonly repo: SessionRepository,
    private readonly extractor: FactsExtractor,
    deps: SessionServiceDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
    this.summarizer = deps.summarizer ?? null;
    this.knowledgeService = deps.knowledgeService ?? null;
    this.resolveWorkerScript = deps.resolveWorkerScript ?? defaultResolveWorkerScript;
    this.spawnWorker = deps.spawnWorker ?? defaultSpawnWorker;
  }

  async open(
    input: OpenSessionInput,
  ): Promise<Result<OpenSessionOutput, ValidationError | StorageError>> {
    const when = input.openedAt !== undefined ? new Date(input.openedAt) : this.now();

    // 1. Supersede any existing open session for (agent, repo).
    const existingOpen = await this.repo.findOpen(input.agentId, input.repo);
    if (!existingOpen.ok) return existingOpen;
    let superseded: Session | null = null;
    if (existingOpen.value !== null) {
      const abandoned = await this.repo.abandon(existingOpen.value.id, {
        closedAt: timestamp(when.toISOString()),
        reason: AbandonmentReason.SUPERSEDED,
      });
      if (!abandoned.ok) {
        if (abandoned.error.code !== "STATE_TRANSITION_INVALID") return abandoned;
      } else {
        superseded = abandoned.value;
      }
    }

    // 2. Find latest closed session to set as parent + detect orphan state.
    const latestClosed = await this.repo.findLatestClosed(input.agentId, input.repo);
    if (!latestClosed.ok) return latestClosed;
    const parent: Session | null = latestClosed.value;
    const previousOrphan =
      parent !== null && parent.handoffArticleId === null ? parent : null;

    // 3. Create the new session.
    const newId = generateSessionId(input.agentId, when);
    const created = await this.repo.create({
      id: newId,
      agentId: input.agentId,
      repo: input.repo,
      branch: input.branch ?? null,
      openedAt: timestamp(when.toISOString()),
      intent: input.intent ?? null,
      parentSessionId: parent !== null ? parent.id : null,
    });
    if (!created.ok) return created;

    return ok({ session: created.value, superseded, parent, previousOrphan });
  }

  async close(
    input: CloseSessionInput,
  ): Promise<Result<CloseSessionOutput, ValidationError | NotFoundError | StateTransitionError | StorageError>> {
    const when = input.closedAt !== undefined ? new Date(input.closedAt) : this.now();

    // 1. Resolve target session.
    const resolved = await this.resolveClosingSession(input);
    if (!resolved.ok) return resolved;
    const targetSession = resolved.value;

    // 2. Stage A — extract facts.
    const sessionForExtract: Session = {
      ...targetSession,
      closedAt: timestamp(when.toISOString()),
    };
    const factsResult = await this.extractor.extract(sessionForExtract, input.note ?? null);
    if (!factsResult.ok) return factsResult;
    const facts = factsResult.value;

    // 3. Persist facts to disk.
    const factsPath = await this.repo.saveFacts(targetSession.id, facts);
    if (!factsPath.ok) return factsPath;

    // 4. Transition the session to `closed`. Quality is provisional — the
    //    handoff pipeline will update it via `attachHandoff` (sync mode) or
    //    the worker subprocess will (async mode). On orphan / worker crash,
    //    the next `session open` detects `handoffArticleId === null` and
    //    surfaces a warning.
    const closed = await this.repo.close(targetSession.id, {
      closedAt: timestamp(when.toISOString()),
      factsPath: factsPath.value,
      qualityDegraded: true,
    });
    if (!closed.ok) return closed;

    // 5. Branch: sync (run pipeline inline) vs async (dispatch worker).
    //    Tests and direct callers default to sync. The CLI flips this so the
    //    coding agent does not wait ~30-60s for Ollama at session close.
    const sync = input.sync !== false; // default true

    if (!sync && this.summarizer !== null && input.noLlm !== true) {
      const dispatched = this.tryDispatchWorker(closed.value.id, closed.value.repo);
      return ok({
        session: closed.value,
        facts,
        summary: null,
        evalResult: null,
        handoffArticleId: null,
        degraded: true,
        asyncDispatched: dispatched,
      });
    }

    // Sync path: run B/C/D inline (or skip if --no-llm / no summarizer).
    const pipelineResult = await this.runHandoffPipeline(closed.value, facts, input.noLlm === true);
    if (!pipelineResult.ok) return pipelineResult;
    return ok({
      session: pipelineResult.value.session,
      facts,
      summary: pipelineResult.value.summary,
      evalResult: pipelineResult.value.evalResult,
      handoffArticleId: pipelineResult.value.handoffArticleId,
      degraded: pipelineResult.value.degraded,
      asyncDispatched: false,
    });
  }

  /**
   * Worker-side entry point: run Stages B/C/D + render + persist + attach
   * handoff on a session that is already in `closed` status. Invoked by the
   * detached async subprocess.
   *
   * Idempotent: calling twice on the same session overwrites the previous
   * handoff article. That is by design — retries should produce fresh output.
   */
  async generateHandoff(
    sessionId: SessionId,
  ): Promise<Result<HandoffPipelineOutput, NotFoundError | StateTransitionError | StorageError>> {
    const session = await this.repo.findById(sessionId);
    if (!session.ok) return session;
    if (session.value.status !== SessionStatus.CLOSED) {
      return err(
        new StateTransitionError(
          session.value.status,
          "generate_handoff",
          "generateHandoff requires a closed session",
        ),
      );
    }
    if (session.value.factsPath === null) {
      return err(
        new StateTransitionError(
          session.value.status,
          "generate_handoff",
          "Session has no factsPath — cannot regenerate handoff without facts.json",
        ),
      );
    }
    const facts = await this.repo.loadFacts(sessionId);
    if (!facts.ok) {
      return err(
        new StorageError(`Failed to load facts for ${sessionId}: ${facts.error.message}`),
      );
    }
    return this.runHandoffPipeline(session.value, facts.value, /* skipLlm */ false);
  }

  async get(id: SessionId): Promise<Result<Session, NotFoundError | StorageError>> {
    return this.repo.findById(id);
  }

  async list(filter?: SessionListFilter): Promise<Result<Session[], StorageError>> {
    return this.repo.findMany(filter);
  }

  /**
   * Read-side complement to `session open --teaser-only`. Returns a depth-sliced
   * view of a session's handoff article so an agent can re-orient mid-flight
   * without paying the cost of loading the full article (or the cost of
   * regenerating it from facts.json).
   *
   * Resolution order:
   *   1. `input.sessionId` → exact lookup
   *   2. `input.agentId + input.repo` → most recent CLOSED for that pair
   *   3. otherwise ValidationError
   *
   * Orphan handling: if the resolved session has no `handoffArticleId`, the
   * body is a minimal "this handoff was never attached" message instead of
   * an error — the lifecycle facts are still useful.
   */
  async brief(
    input: BriefSessionInput,
  ): Promise<Result<BriefSessionOutput, NotFoundError | ValidationError | StorageError>> {
    const resolved = await this.resolveBriefingSession(input);
    if (!resolved.ok) return resolved;
    const session = resolved.value;

    let article: KnowledgeArticle | null = null;
    if (session.handoffArticleId !== null && this.knowledgeService !== null) {
      // `handoffArticleId` is a misnomer — the close path persists the article
      // and stores its SLUG here (see `persistHandoffArticle`), not the
      // article's `k-*` id. Look up by slug to match.
      const got = await this.knowledgeService.getArticleBySlug(session.handoffArticleId);
      if (got.ok) {
        article = got.value;
      }
      // NotFoundError falls through to orphan path so a missing article does
      // not crash the brief — agents would rather see "handoff missing" than
      // a hard error.
    }

    const body =
      article !== null
        ? this.renderBriefBody(article.content, input.depth)
        : renderOrphanBrief(session);

    const crossAgentDelta =
      input.since !== undefined
        ? await this.computeCrossAgentDelta(session, input.since)
        : null;

    return ok({ session, handoffArticle: article, body, crossAgentDelta });
  }

  private async resolveBriefingSession(
    input: BriefSessionInput,
  ): Promise<Result<Session, NotFoundError | ValidationError | StorageError>> {
    if (input.sessionId !== undefined) {
      return this.repo.findById(input.sessionId);
    }
    if (input.agentId === undefined || input.repo === undefined) {
      return err(
        new ValidationError(
          "brief requires either sessionId, or (agentId + repo) to resolve the latest closed session",
        ),
      );
    }
    const latest = await this.repo.findLatestClosed(input.agentId, input.repo);
    if (!latest.ok) return latest;
    if (latest.value === null) {
      return err(
        new NotFoundError(
          "Session",
          `no closed session for agent=${input.agentId} repo=${input.repo}`,
        ),
      );
    }
    return ok(latest.value);
  }

  private renderBriefBody(articleBody: string, depth: BriefDepth): string {
    if (depth === "full") return articleBody;
    const parsed = parseHandoffSections(articleBody);
    return depth === "teaser"
      ? renderBriefTeaser(parsed)
      : renderBriefStandard(parsed);
  }

  private async computeCrossAgentDelta(
    session: Session,
    since: Timestamp,
  ): Promise<CrossAgentDelta | null> {
    const all = await this.repo.findMany({
      repo: session.repo,
      status: SessionStatus.CLOSED,
    });
    if (!all.ok) return null;
    const byAgent: Record<string, number> = {};
    for (const s of all.value) {
      if (s.agentId === session.agentId) continue;
      if (s.closedAt === null) continue;
      if (s.closedAt < since) continue;
      byAgent[s.agentId] = (byAgent[s.agentId] ?? 0) + 1;
    }
    return { since, byAgent };
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private async resolveClosingSession(
    input: CloseSessionInput,
  ): Promise<Result<Session, ValidationError | NotFoundError | StorageError>> {
    if (input.sessionId !== undefined) {
      return this.repo.findById(input.sessionId);
    }
    if (input.agentId === undefined || input.repo === undefined) {
      return err(
        new ValidationError(
          "close requires either sessionId, or (agentId + repo) to resolve the implicit open session",
        ),
      );
    }
    const open = await this.repo.findOpen(input.agentId, input.repo);
    if (!open.ok) return open;
    if (open.value === null) {
      return err(new NotFoundError("Session.open", `${input.agentId}@${input.repo}`));
    }
    return ok(open.value);
  }

  /**
   * Full pipeline: Stages B/C/D + render markdown + persist via KnowledgeService
   * + attach handoff metadata to the session. Used by both the sync close path
   * and the async worker entry point (`generateHandoff`).
   *
   * When `skipLlm` is true (or the summarizer is unwired), the article is
   * still produced and persisted, but with the T1-only "degraded" body
   * (header + Hypergraph + Facts; no narrative). Quality.degraded ends up
   * true and Quality.score remains null.
   */
  private async runHandoffPipeline(
    closedSession: Session,
    facts: SessionFacts,
    skipLlm: boolean,
  ): Promise<Result<HandoffPipelineOutput, StateTransitionError | NotFoundError | StorageError>> {
    const llmOutcome = await this.runLlmStages(facts, skipLlm);

    // Render against a projected session that reflects the FINAL quality
    // state (after `attachHandoff` lands below), not the provisional
    // `degraded: true` set in `close()` while the pipeline was pending.
    // Otherwise the article header carries stale "degraded (Ollama
    // unavailable)" text even when Ollama succeeded. Discovered during
    // first real dogfood — see knowledge:cognitive-handoff-sessions.
    const projectedSession: Session = {
      ...closedSession,
      quality: {
        score: llmOutcome.evalResult?.score ?? null,
        degraded: llmOutcome.degraded,
        model: llmOutcome.modelName,
      },
    };
    const renderedBody = renderHandoffArticle(
      projectedSession,
      facts,
      llmOutcome.summary ?? emptyT1Summary(),
    );
    // Advisory coverage pass over the rendered article — surfaces unanswered
    // dimensions to the next agent without blocking persistence. The render is
    // not perfect; the coverage section is the article's own self-criticism.
    const coverageGaps = evaluateHandoffCoverage(renderedBody);
    const coverageSection = renderCoverageSection(coverageGaps);
    const articleBody = coverageSection.length > 0
      ? `${renderedBody.trimEnd()}\n\n${coverageSection}\n`
      : renderedBody;
    const slug = buildHandoffSlug(projectedSession);
    const handoffArticleId = await this.persistHandoffArticle(projectedSession, articleBody, slug);
    if (!handoffArticleId.ok) return handoffArticleId;

    const attached = await this.repo.attachHandoff(closedSession.id, {
      handoffArticleId: handoffArticleId.value,
      qualityScore: llmOutcome.evalResult?.score ?? null,
      qualityModel: llmOutcome.modelName,
      qualityDegraded: llmOutcome.degraded,
    });
    if (!attached.ok) return attached;

    return ok({
      session: attached.value,
      summary: llmOutcome.summary,
      evalResult: llmOutcome.evalResult,
      handoffArticleId: handoffArticleId.value,
      degraded: llmOutcome.degraded,
    });
  }

  /**
   * Run Stages B+C (combined) and D (self-eval). On any LLM failure or when
   * the pipeline is intentionally skipped, returns a `degraded` outcome with
   * `summary === null` — the caller then renders a T1-only article.
   */
  private async runLlmStages(
    facts: SessionFacts,
    skip: boolean,
  ): Promise<{
    summary: LLMSummary | null;
    evalResult: LLMQualityEval | null;
    degraded: boolean;
    modelName: string | null;
  }> {
    if (skip || this.summarizer === null) {
      return { summary: null, evalResult: null, degraded: true, modelName: null };
    }
    const health = await this.summarizer.healthCheck();
    if (!health.ok) {
      return { summary: null, evalResult: null, degraded: true, modelName: null };
    }
    const summaryResult = await this.summarizer.summarize(facts);
    if (!summaryResult.ok) {
      return { summary: null, evalResult: null, degraded: true, modelName: this.summarizer.modelName };
    }
    const { summary: prunedSummary } = pruneSummaryCitations(summaryResult.value, facts);
    const evalResult = await this.summarizer.evaluate(prunedSummary, facts);
    return {
      summary: prunedSummary,
      evalResult: evalResult.ok ? evalResult.value : null,
      degraded: false,
      modelName: this.summarizer.modelName,
    };
  }

  private async persistHandoffArticle(
    session: Session,
    body: string,
    slug: string,
  ): Promise<Result<string, StorageError>> {
    if (this.knowledgeService === null) {
      // No knowledge service wired — persist the article id as the slug anyway
      // so the Session record carries a stable reference. The body is dropped
      // in this path; that's the expected behavior for in-memory test runs.
      return ok(slug);
    }
    const codeRefs = collectCodeRefs(body);
    const references = collectArticleReferences(body);
    const input = {
      title: buildHandoffTitle(session),
      slug,
      category: "handoff",
      content: body,
      tags: buildHandoffTags(session),
      codeRefs,
      references,
    };
    // The knowledge service may return AlreadyExistsError on retry — that
    // means the handoff article already exists from a previous run. Treat
    // it as success and return the existing slug.
    const result = await this.knowledgeService.createArticle(input);
    if (!result.ok) {
      if (result.error.code === "ALREADY_EXISTS") {
        return ok(slug);
      }
      return err(
        new StorageError(
          `Failed to persist handoff article (${result.error.code}): ${result.error.message}`,
        ),
      );
    }
    return ok(result.value.slug);
  }

  /**
   * Spawn a detached subprocess running the same Monsthera entry point with
   * `session _generate-handoff <id>`. Returns `true` when a child was actually
   * spawned (and unref'd so the parent can exit), `false` when the worker
   * couldn't be dispatched (in which case the caller is expected to surface
   * a warning — the session stays in orphan state until manually retried).
   *
   * Dev-mode handling: when the entry script is a `.ts` file (running under
   * `pnpm exec tsx ...`), the child node would crash trying to resolve `.js`
   * imports without the tsx loader. We prepend `--import tsx` to register
   * the loader explicitly. In production (compiled `.js`) we go straight to
   * `node bin.js ...`.
   *
   * Cwd is intentionally *not* set to `repo`: in dev mode the tsx loader is
   * resolved from `node_modules/tsx` next to the entry script, so we keep
   * the parent's cwd (which is the Monsthera project). The target repo
   * travels via the `--repo` flag.
   */
  private tryDispatchWorker(sessionId: SessionId, repo: string): boolean {
    const script = this.resolveWorkerScript();
    if (script === null) return false;
    const isDevTs = script.endsWith(".ts");
    const childArgs = isDevTs
      ? ["--import", "tsx", script, "session", "_generate-handoff", sessionId, "--repo", repo]
      : [script, "session", "_generate-handoff", sessionId, "--repo", repo];
    try {
      const child = this.spawnWorker(process.execPath, childArgs);
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultResolveWorkerScript(): string | null {
  const script = process.argv[1];
  if (!script || script.length === 0) return null;
  return script;
}

function defaultSpawnWorker(cmd: string, args: string[], cwd?: string): { unref(): void } {
  // stdio: 'ignore' detaches the child's I/O so the parent can exit without
  // leaving dangling fds. env: inherits so a tsx-wrapped parent passes the
  // loader to the child via NODE_OPTIONS (set by tsx automatically).
  //
  // Debug hook: set MONSTHERA_SESSIONS_WORKER_LOG=/path/to/log.ndjson to
  // redirect the worker's stdout+stderr to a file for inspection. Otherwise
  // I/O is discarded — the worker writes the handoff article + emits an
  // event when done, which is the observable contract.
  const logPath = process.env["MONSTHERA_SESSIONS_WORKER_LOG"];
  if (logPath) {
    const fd = openSync(logPath, "a");
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      ...(cwd ? { cwd } : {}),
      env: process.env,
    });
    return child;
  }
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
    ...(cwd ? { cwd } : {}),
    env: process.env,
  });
  return child;
}

/**
 * Empty summary used when the LLM pipeline is skipped / degraded. The
 * renderer falls back to header + Hypergraph + Facts in this case.
 */
function emptyT1Summary(): LLMSummary {
  return {
    tldr: "_Handoff is degraded — LLM pipeline did not run. See Hypergraph and Facts below for raw context._",
    summary: "_No narrative available (Stage B/C skipped). The Hypergraph section below lists what changed; the Facts JSON has the full audit trail._",
    decisions: [],
    blockers: [],
    surprises: [],
    deferred: [],
    nextSteps: [],
    openQuestions: [],
    suggestedAgent: null,
  };
}

/**
 * Pull `src/...` and `path:...` references out of the rendered body so the
 * persisted article carries them as `codeRefs[]`. Cheap regex; the renderer
 * is the only producer of this body, so we know its shape.
 */
function collectCodeRefs(body: string): string[] {
  const refs = new Set<string>();
  for (const match of body.matchAll(/`([^`]+\.(?:ts|tsx|js|jsx|py|rs|go|md|sh|sql))`/g)) {
    if (match[1]) refs.add(match[1]);
  }
  for (const match of body.matchAll(/path:([^\],\s]+)/g)) {
    if (match[1]) refs.add(match[1]);
  }
  return [...refs];
}

/**
 * Pull work/knowledge ids out of the rendered body to seed the article's
 * `references[]` field for graph navigation.
 */
function collectArticleReferences(body: string): string[] {
  const refs = new Set<string>();
  for (const match of body.matchAll(/work:([a-z0-9-]+)/g)) {
    if (match[1]) refs.add(match[1]);
  }
  for (const match of body.matchAll(/knowledge:([a-z0-9-]+)/g)) {
    if (match[1]) refs.add(match[1]);
  }
  for (const match of body.matchAll(/handoff-(ses-[a-z0-9-]+)\.md/g)) {
    if (match[1]) refs.add(`handoff-${match[1]}`);
  }
  return [...refs];
}
