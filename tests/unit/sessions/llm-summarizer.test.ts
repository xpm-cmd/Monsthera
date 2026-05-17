import { describe, it, expect } from "vitest";
import {
  buildRetrospectProspectPrompt,
  buildSelfEvalPrompt,
  type LLMSummary,
} from "../../../src/sessions/llm-summarizer.js";
import type { SessionFacts } from "../../../src/sessions/schemas.js";

function makeFacts(): SessionFacts {
  return {
    sessionId: "ses-x",
    agent: "claude-code",
    repo: "/tmp/repo",
    branch: "main",
    window: { openedAt: "2026-05-12T10:00:00Z", closedAt: "2026-05-12T11:00:00Z" },
    events: [],
    workTouched: [],
    knowledgeTouched: [],
    codeTouched: [],
    commits: [],
    signals: { todosAdded: [], questions: [], testFailures: [] },
    agentNote: null,
  };
}

function makeSummary(): LLMSummary {
  return {
    tldr: "tl;dr",
    summary: "summary",
    decisions: [],
    blockers: [],
    surprises: [],
    deferred: [],
    nextSteps: [],
    openQuestions: [],
    suggestedAgent: null,
  };
}

describe("buildRetrospectProspectPrompt", () => {
  it("declares the citation shapes the LLM must use for grounding", () => {
    const prompt = buildRetrospectProspectPrompt(makeFacts());
    expect(prompt).toContain('"evt:<event.id>"');
    expect(prompt).toContain('"work:<workTouched.id>"');
    expect(prompt).toContain('"knowledge:<slug>"');
    expect(prompt).toContain('"commit:<sha-8>"');
  });

  it("asks the LLM to put a verification command in nextSteps[].why so coverage-validator credits it", () => {
    const prompt = buildRetrospectProspectPrompt(makeFacts());
    // Rule 5 must mention the why-field-as-verification convention. This pins
    // the contract the coverage validator's hasVerification heuristic relies
    // on. If this assertion ever breaks, audit src/sessions/coverage-validator.ts
    // to confirm the heuristic still has something to match.
    expect(prompt).toContain("verification command");
    expect(prompt).toContain("`why` field");
  });

  it("instructs the LLM to wrap file paths and commands in backticks (markdown convention)", () => {
    const prompt = buildRetrospectProspectPrompt(makeFacts());
    expect(prompt).toContain("backticks");
  });

  it("enforces the no-invention rule for empty sections", () => {
    const prompt = buildRetrospectProspectPrompt(makeFacts());
    expect(prompt).toContain("Do not invent");
  });

  it("emits the JSON schema so Ollama format=json can validate", () => {
    const prompt = buildRetrospectProspectPrompt(makeFacts());
    expect(prompt).toContain("Schema (zod):");
    expect(prompt).toContain('"tldr"');
    expect(prompt).toContain('"nextSteps"');
    expect(prompt).toContain('"blockers"');
  });

  it("compresses event details out of the facts payload to keep prompt small", () => {
    const facts = makeFacts();
    facts.events = Array.from({ length: 100 }, (_, i) => ({
      id: `e-${i}`,
      type: "phase_advanced" as const,
      timestamp: "2026-05-12T10:30:00Z",
    }));
    const prompt = buildRetrospectProspectPrompt(facts);
    // Only the first 50 events should appear by id; details payloads should not.
    expect(prompt).toContain("e-0");
    expect(prompt).toContain("e-49");
    expect(prompt).not.toContain("e-50");
  });

  // ─── Round 5 prompt improvements ──────────────────────────────────────────

  it("instructs the LLM to preserve identifiers verbatim (PRs, SHAs, line numbers, symbols)", () => {
    const prompt = buildRetrospectProspectPrompt(makeFacts());
    // Rule 7: identifier preservation. Specifically calls out `#NNN`, SHA
    // length, and the anti-pattern of generic replacements.
    expect(prompt).toContain("Preserve specific identifiers");
    expect(prompt).toContain("#NNN");
    expect(prompt).toContain("Do NOT replace them with generic phrases");
  });

  it("requires imperative voice in nextSteps[].action", () => {
    const prompt = buildRetrospectProspectPrompt(makeFacts());
    // Rule 8: action field IS a command, not a description.
    expect(prompt).toContain("imperative verb");
    expect(prompt).toContain("Edit, Run, Add");
    expect(prompt).toContain("NOT \"The next step is to…\"");
  });

  it("routes watch-outs from agentNote into blockers, not decisions", () => {
    const prompt = buildRetrospectProspectPrompt(makeFacts());
    // Rule 9: warning-style phrases belong in blockers. The coverage
    // validator's hasConstraints check reads `### Blockers` specifically;
    // burying watch-outs in the summary loses them.
    expect(prompt).toContain("watch out");
    expect(prompt).toContain("`blockers[]`");
    expect(prompt).toContain("not in `decisions[]`");
  });
});

describe("buildSelfEvalPrompt — 5-question coverage rubric (round 5)", () => {
  it("rates on the 5 cold-start questions, not count proxies", () => {
    const prompt = buildSelfEvalPrompt(makeSummary(), makeFacts());
    // The new rubric explicitly enumerates Q1-Q5 (STATE / INTENT / ACTION /
    // CONSTRAINTS / VERIFICATION) and asks the eval to count how many are
    // CLEARLY answered with SPECIFICS. Pins the alignment with the coverage
    // validator's dimensions.
    expect(prompt).toContain("Q1. STATE");
    expect(prompt).toContain("Q2. INTENT");
    expect(prompt).toContain("Q3. ACTION");
    expect(prompt).toContain("Q4. CONSTRAINTS");
    expect(prompt).toContain("Q5. VERIFICATION");
  });

  it("distinguishes 'specific' from 'generic' answers in the rubric", () => {
    const prompt = buildSelfEvalPrompt(makeSummary(), makeFacts());
    // The rubric must teach the LLM what counts as specific. Without this,
    // it tends to credit verbose-but-vague prose as 'covered'.
    expect(prompt).toContain("with SPECIFICS");
    expect(prompt).toContain("not generic prose");
    expect(prompt).toMatch(/file:line|pnpm test/);
  });

  it("asks the LLM to name which Qs were specific vs missing in the reasoning", () => {
    const prompt = buildSelfEvalPrompt(makeSummary(), makeFacts());
    // The `reasoning` field becomes diagnostic — operators can read the
    // self-eval and see which dimensions the LLM thought were weak.
    expect(prompt).toContain("name which of Q1-Q5");
  });

  it("passes narrative content (tldr, summary, decisions, blockers) to the eval — not just counts", () => {
    const summary: LLMSummary = {
      tldr: "TLDR-MARKER",
      summary: "SUMMARY-MARKER",
      decisions: [{ text: "DECISION-MARKER", evidence: [] }],
      blockers: [{ text: "BLOCKER-MARKER", evidence: [] }],
      surprises: [],
      deferred: [],
      nextSteps: [{ action: "ACTION-MARKER", evidence: [], why: "WHY-MARKER" }],
      openQuestions: ["QUESTION-MARKER"],
      suggestedAgent: "agent-marker",
    };
    const prompt = buildSelfEvalPrompt(summary, makeFacts());
    // Each narrative field must appear so the eval can rate on content,
    // not on counts alone.
    expect(prompt).toContain("TLDR-MARKER");
    expect(prompt).toContain("SUMMARY-MARKER");
    expect(prompt).toContain("DECISION-MARKER");
    expect(prompt).toContain("BLOCKER-MARKER");
    expect(prompt).toContain("ACTION-MARKER");
    expect(prompt).toContain("WHY-MARKER");
  });

  it("emits valid JSON shape { score, reasoning } so the LLMQualityEvalSchema validates", () => {
    const prompt = buildSelfEvalPrompt(makeSummary(), makeFacts());
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain("Output ONLY valid JSON");
  });
});
