import { z } from "zod/v4";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { StorageError, ValidationError } from "../core/errors.js";
import type { MonstheraError } from "../core/errors.js";
import type { SessionFacts } from "./schemas.js";

/**
 * Stage B (retrospect) + Stage C (prospect) — combined.
 *
 * Implementation deviation from the original plan: v1 issues a SINGLE Ollama
 * call that emits both retrospect and prospect fields in one JSON object.
 * Rationale:
 *   - Ollama JSON-mode handles structured multi-field output well.
 *   - One round-trip per close is ~half the latency of two.
 *   - The schema below preserves the logical separation in the OUTPUT — the
 *     renderer can still surface "What happened" vs "What's next" as
 *     distinct sections.
 *   - If quality variance is observed, splitting into two prompts is a
 *     mechanical refactor (the renderer consumes the same schema either way).
 *
 * Stage D (self-eval) remains a separate small prompt — it judges the
 * already-produced output, so it cannot be combined.
 */

export const LLMSummarySchema = z.object({
  tldr: z.string().min(1).max(800),
  summary: z.string().min(1).max(3000),
  decisions: z
    .array(z.object({ text: z.string().min(1), evidence: z.array(z.string()).default([]) }))
    .default([]),
  blockers: z
    .array(z.object({ text: z.string().min(1), evidence: z.array(z.string()).default([]) }))
    .default([]),
  surprises: z.array(z.string()).default([]),
  deferred: z.array(z.string()).default([]),
  nextSteps: z
    .array(
      z.object({
        action: z.string().min(1),
        evidence: z.array(z.string()).default([]),
        why: z.string().default(""),
      }),
    )
    .default([]),
  openQuestions: z.array(z.string()).default([]),
  suggestedAgent: z.string().nullable().default(null),
});

export type LLMSummary = z.infer<typeof LLMSummarySchema>;

export const LLMQualityEvalSchema = z.object({
  score: z.number().int().min(1).max(5),
  reasoning: z.string().min(1).max(500),
});

export type LLMQualityEval = z.infer<typeof LLMQualityEvalSchema>;

// ─── Summarizer interface ─────────────────────────────────────────────────────

export interface LLMSummarizer {
  /** Stage B+C combined. */
  summarize(facts: SessionFacts): Promise<Result<LLMSummary, MonstheraError>>;
  /** Stage D self-eval. */
  evaluate(summary: LLMSummary, facts: SessionFacts): Promise<Result<LLMQualityEval, MonstheraError>>;
  /** Identifier of the underlying model (for `Session.quality.model`). */
  readonly modelName: string;
  /** Cheap reachability check; used by service to decide between LLM and T1-only paths. */
  healthCheck(): Promise<Result<{ ready: true }, MonstheraError>>;
}

// ─── Prompt builders (exposed for testing) ────────────────────────────────────

/**
 * Build the JSON-mode prompt for the combined retrospect+prospect stage.
 *
 * The prompt enforces grounding: the model is told to ONLY cite IDs that
 * appear in the provided facts payload. Citation validation runs after
 * the response is parsed (see `citation-validator.ts`), and unresolved
 * citations are pruned. The model never invents entities — at worst it
 * cites things that get pruned.
 *
 * Input compression: we strip event `details` payloads and trim long fields
 * to keep the prompt under ~2KB regardless of session size. Quality of
 * summaries depends much more on signal density than on raw input length.
 */
export function buildRetrospectProspectPrompt(facts: SessionFacts): string {
  const compact = {
    sessionId: facts.sessionId,
    agent: facts.agent,
    repo: facts.repo,
    branch: facts.branch,
    window: facts.window,
    agentNote: facts.agentNote,
    events: facts.events.slice(0, 50).map((e) => ({
      id: e.id,
      type: e.type,
      workId: e.workId,
      agentId: e.agentId,
      timestamp: e.timestamp,
    })),
    workTouched: facts.workTouched,
    knowledgeTouched: facts.knowledgeTouched,
    codeTouched: facts.codeTouched.slice(0, 20),
    commits: facts.commits.slice(0, 30),
    signals: {
      todosAdded: facts.signals.todosAdded.slice(0, 10),
      questions: facts.signals.questions.slice(0, 10),
      testFailures: facts.signals.testFailures.slice(0, 5),
    },
  };

  return [
    "You produce a structured handoff document for the next AI coding agent that will pick up where this session left off.",
    "",
    "Rules:",
    "1. Output ONLY valid JSON matching the schema below. No prose outside the JSON object.",
    "2. Every `evidence` array entry MUST be a citation drawn from the FACTS below. Use these citation shapes:",
    '   - "evt:<event.id>"           for an event',
    '   - "work:<workTouched.id>"    for a work article touched',
    '   - "knowledge:<slug>"         for a knowledge article created or updated',
    '   - "commit:<sha-8>"           for a commit (use first 8 chars of sha)',
    '   - "path:<file>" or "path:<file>:<line>" for code/TODO/question references',
    "   Invented citations will be pruned automatically. Prefer fewer real citations over many fabricated ones.",
    "3. `suggestedAgent` is a short role hint (e.g. \"security-reviewer\", \"performance\", \"architecture\"), or null.",
    "4. Keep `tldr` to 2-3 sentences. Keep `summary` to 2-3 paragraphs.",
    "5. `nextSteps` must each pair an `action` with at least one piece of `evidence` whenever possible. Use the `why` field to mention a concrete verification command when applicable — e.g. \"verifies the regression with `pnpm test tests/sessions/foo.test.ts`\". Wrap file paths and shell commands in backticks (markdown convention) so the next agent can scan and run them.",
    "6. If there is no signal for a section (e.g. no blockers), return an empty array. Do not invent.",
    "7. Preserve specific identifiers from `agentNote` verbatim wherever they appear: PR numbers (`#NNN`), issue numbers, commit SHAs (8+ hex), exact line numbers (`file.ts:42`), exact symbol names (`SessionService.open`). Do NOT replace them with generic phrases (\"the PR\", \"the file\", \"the function\"). These identifiers are the next agent's cold-start hooks; losing them forces re-derivation from history.",
    "8. `nextSteps[].action` must start with an imperative verb (Edit, Run, Add, Fix, Verify, Implement, Rebase, Merge, etc.). NOT \"The next step is to…\", \"You should…\", \"It would be good to…\". The action field IS a command the next agent executes, not a description of what they will do.",
    "9. Statements in `agentNote` starting with \"do not\", \"must not\", \"watch out\", \"watch-out\", \"WATCH-OUT\", \"careful\", \"warning\", or framed as constraints belong in `blockers[]`, not in `decisions[]` or `summary`. The next agent reads `### Blockers` specifically to learn what to avoid. Burying watch-outs in narrative loses them.",
    "",
    "Schema (zod):",
    "{",
    '  "tldr": string,                              // 2-3 sentences',
    '  "summary": string,                            // 2-3 paragraphs',
    '  "decisions": [{ "text": string, "evidence": string[] }],',
    '  "blockers":  [{ "text": string, "evidence": string[] }],',
    '  "surprises": string[],',
    '  "deferred":  string[],',
    '  "nextSteps": [{ "action": string, "evidence": string[], "why": string }],',
    '  "openQuestions": string[],',
    '  "suggestedAgent": string | null',
    "}",
    "",
    "FACTS:",
    JSON.stringify(compact, null, 2),
    "",
    "Output the JSON now.",
  ].join("\n");
}

export function buildSelfEvalPrompt(summary: LLMSummary, facts: SessionFacts): string {
  // Pass enough narrative content for the LLM to rate quality, not just
  // counts. Trim long fields to keep the prompt bounded regardless of
  // session size. Counts on the FACTS side stay as numbers — coverage is
  // a function of what the SUMMARY says, not how many raw events existed.
  const summaryForEval = {
    tldr: summary.tldr,
    summary: summary.summary.slice(0, 1500),
    decisions: summary.decisions.slice(0, 5).map((d) => d.text),
    blockers: summary.blockers.slice(0, 5).map((b) => b.text),
    deferred: summary.deferred.slice(0, 5),
    nextSteps: summary.nextSteps.slice(0, 3).map((s) => ({
      action: s.action,
      why: s.why,
    })),
    openQuestions: summary.openQuestions.slice(0, 3),
    suggestedAgent: summary.suggestedAgent,
  };
  const factsShape = {
    eventCount: facts.events.length,
    workCount: facts.workTouched.length,
    knowledgeCount: facts.knowledgeTouched.length,
    codeCount: facts.codeTouched.length,
    commitCount: facts.commits.length,
    signalCount:
      facts.signals.todosAdded.length + facts.signals.questions.length + facts.signals.testFailures.length,
  };

  return [
    "You evaluate a session handoff document by scoring how well it answers the FIVE cold-start questions a brand-new agent has when picking up this work:",
    "",
    "  Q1. STATE — Where am I? (workstream state — what just shipped, what's open, what's closed)",
    "  Q2. INTENT — Why are we here? (the overarching goal / parent reason for this session)",
    "  Q3. ACTION — What do I do next? (concrete first step — file:line, command, or imperative verb tied to a target)",
    "  Q4. CONSTRAINTS — What must I not break? (blockers, deferred items, watch-outs, invariants)",
    "  Q5. VERIFICATION — How do I verify? (a concrete test command, doctor check, or observable signal)",
    "",
    "Scoring rubric (count how many of Q1-Q5 are CLEARLY answered with SPECIFICS — not generic prose):",
    "  5 = all five answered with specifics (file:line, command, identifier, exact symbol/PR number)",
    "  4 = four answered with specifics; one is missing or only generic",
    "  3 = three answered with specifics; the other two are missing or generic",
    "  2 = two answered; three missing or only generic prose",
    "  1 = one or zero answered (document is mostly empty or vague)",
    "",
    "A 'specific' answer cites something the next agent can grep, click, or run — e.g. `pnpm test tests/foo.test.ts`, `src/sessions/service.ts:192`, `PR #111`, `commit abc12345`. A 'generic' answer reads like \"review the changes\" or \"check the tests\".",
    "",
    "In the `reasoning` field, name which of Q1-Q5 you found and which were missing/generic — e.g. \"Q1,Q3,Q5 specific; Q2 generic; Q4 missing\".",
    "",
    "Output ONLY valid JSON: { \"score\": 1|2|3|4|5, \"reasoning\": \"one short sentence covering Q1-Q5\" }",
    "",
    "Handoff document content:",
    JSON.stringify(summaryForEval, null, 2),
    "",
    "Underlying facts (size only — for context on how much raw signal was available):",
    JSON.stringify(factsShape, null, 2),
    "",
    "Output the JSON now.",
  ].join("\n");
}

// ─── Fake summarizer for tests ────────────────────────────────────────────────

export class FakeLLMSummarizer implements LLMSummarizer {
  readonly modelName = "fake";
  constructor(
    private readonly summary: LLMSummary,
    private readonly evalResult: LLMQualityEval = { score: 4, reasoning: "fake eval" },
    private readonly healthy: boolean = true,
  ) {}

  async summarize(_facts: SessionFacts): Promise<Result<LLMSummary, MonstheraError>> {
    return ok(this.summary);
  }

  async evaluate(
    _summary: LLMSummary,
    _facts: SessionFacts,
  ): Promise<Result<LLMQualityEval, MonstheraError>> {
    return ok(this.evalResult);
  }

  async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
    if (this.healthy) return ok({ ready: true });
    return err(new StorageError("FakeLLMSummarizer marked unhealthy"));
  }
}

// ─── Ollama summarizer ────────────────────────────────────────────────────────

export interface OllamaSummarizerOptions {
  readonly ollamaUrl: string;
  readonly model: string;
  /** Generation temperature. Default 0.2 — favor consistency over creativity for grounded output. */
  readonly temperature?: number;
  /** Hard cap on the request timeout. Default 60s. */
  readonly timeoutMs?: number;
}

export class OllamaSummarizer implements LLMSummarizer {
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(options: OllamaSummarizerOptions) {
    this.baseUrl = options.ollamaUrl.replace(/\/+$/, "");
    this.modelName = options.model;
    this.temperature = options.temperature ?? 0.2;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async summarize(facts: SessionFacts): Promise<Result<LLMSummary, MonstheraError>> {
    const prompt = buildRetrospectProspectPrompt(facts);
    const raw = await this.callOllama(prompt);
    if (!raw.ok) return raw;
    return this.parseSummary(raw.value);
  }

  async evaluate(
    summary: LLMSummary,
    facts: SessionFacts,
  ): Promise<Result<LLMQualityEval, MonstheraError>> {
    const prompt = buildSelfEvalPrompt(summary, facts);
    const raw = await this.callOllama(prompt);
    if (!raw.ok) return raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.value);
    } catch (e) {
      return err(
        new ValidationError("Ollama self-eval response was not valid JSON", {
          cause: e instanceof Error ? e.message : String(e),
        }),
      );
    }
    const validated = LLMQualityEvalSchema.safeParse(parsed);
    if (!validated.success) {
      return err(
        new ValidationError("Ollama self-eval response did not match schema", {
          issues: validated.error.issues,
        }),
      );
    }
    return ok(validated.data);
  }

  async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return err(new StorageError(`Ollama healthCheck failed (${response.status})`));
      }
      return ok({ ready: true });
    } catch (e) {
      return err(
        new StorageError("Ollama unreachable", {
          cause: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  /**
   * Call Ollama with format=json so the response is guaranteed to be parseable
   * JSON. Note: Ollama enforces this at the model level — the model is biased
   * to emit valid JSON but malformed responses still slip through occasionally,
   * which is why `parseSummary` is permissive about whitespace/wrapper text.
   */
  private async callOllama(prompt: string): Promise<Result<string, MonstheraError>> {
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.modelName,
          prompt,
          stream: false,
          format: "json",
          options: { temperature: this.temperature },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return err(
          new StorageError(`Ollama generate failed (${response.status})`, {
            status: response.status,
            body,
          }),
        );
      }

      const data = (await response.json()) as { response?: string };
      if (typeof data.response !== "string") {
        return err(new StorageError("Ollama response missing 'response' field"));
      }
      return ok(data.response);
    } catch (e) {
      return err(
        new StorageError("Ollama generate request failed", {
          cause: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  private parseSummary(raw: string): Result<LLMSummary, MonstheraError> {
    // Trim wrapper whitespace; Ollama sometimes wraps with extra newlines.
    const trimmed = raw.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return err(
        new ValidationError("Ollama summary response was not valid JSON", {
          cause: e instanceof Error ? e.message : String(e),
          rawHead: trimmed.slice(0, 200),
        }),
      );
    }
    const validated = LLMSummarySchema.safeParse(parsed);
    if (!validated.success) {
      return err(
        new ValidationError("Ollama summary response did not match schema", {
          issues: validated.error.issues,
        }),
      );
    }
    return ok(validated.data);
  }
}
