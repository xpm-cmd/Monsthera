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
});

describe("buildSelfEvalPrompt", () => {
  it("scores 1-5 with reasoning, surfacing summary shape (not raw content) for the eval", () => {
    const prompt = buildSelfEvalPrompt(makeSummary(), makeFacts());
    expect(prompt).toContain("1-5 scale");
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain("decisionCount");
    expect(prompt).toContain("blockerCount");
  });
});
