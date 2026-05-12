import { describe, it, expect } from "vitest";
import { pruneSummaryCitations, citationsInFacts } from "../../../src/sessions/citation-validator.js";
import type { LLMSummary } from "../../../src/sessions/llm-summarizer.js";
import type { SessionFacts } from "../../../src/sessions/schemas.js";

function makeFacts(overrides: Partial<SessionFacts> = {}): SessionFacts {
  return {
    sessionId: "ses-test",
    agent: "claude-code",
    repo: "/tmp/repo-a",
    branch: "main",
    window: { openedAt: "2026-05-12T10:43:00Z", closedAt: "2026-05-12T11:30:00Z" },
    events: [
      { id: "e-001", type: "phase_advanced", timestamp: "2026-05-12T11:00:00Z" },
      { id: "e-002", type: "agent_completed", timestamp: "2026-05-12T11:10:00Z" },
    ],
    workTouched: [
      { id: "w-12", title: "Auth refresh", phaseAtOpen: "planning", phaseAtClose: "review", role: "lead" },
    ],
    knowledgeTouched: [
      { id: "k-1", slug: "auth-design", title: "Auth design", category: "decision", op: "created" },
    ],
    codeTouched: [{ path: "src/auth/service.ts", linesAdded: 47, linesRemoved: 12 }],
    commits: [{ sha: "abc12345def", subject: "feat: refresh tokens", timestamp: "2026-05-12T11:05:00Z" }],
    signals: {
      todosAdded: [{ path: "src/auth/worker.ts", line: 42, text: "TODO: wire refresh" }],
      questions: [],
      testFailures: [],
    },
    agentNote: null,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<LLMSummary> = {}): LLMSummary {
  return {
    tldr: "shipped auth refresh",
    summary: "We shipped auth refresh and decided to defer scope X.",
    decisions: [{ text: "use refresh tokens", evidence: ["work:w-12"] }],
    blockers: [],
    surprises: [],
    deferred: [],
    nextSteps: [{ action: "wire AuthService.refresh", evidence: ["path:src/auth/worker.ts:42", "work:w-12"], why: "TODO open" }],
    openQuestions: [],
    suggestedAgent: null,
    ...overrides,
  };
}

describe("citationsInFacts", () => {
  it("recognises evt: citations whose id appears in facts.events", () => {
    expect(citationsInFacts("evt:e-001", makeFacts())).toBe(true);
    expect(citationsInFacts("evt:e-nope", makeFacts())).toBe(false);
  });

  it("recognises work: citations", () => {
    expect(citationsInFacts("work:w-12", makeFacts())).toBe(true);
    expect(citationsInFacts("work:w-99", makeFacts())).toBe(false);
  });

  it("recognises knowledge: citations by id or slug", () => {
    expect(citationsInFacts("knowledge:k-1", makeFacts())).toBe(true);
    expect(citationsInFacts("knowledge:auth-design", makeFacts())).toBe(true);
    expect(citationsInFacts("knowledge:nope", makeFacts())).toBe(false);
  });

  it("recognises commit: citations by sha prefix", () => {
    expect(citationsInFacts("commit:abc12345", makeFacts())).toBe(true);
    expect(citationsInFacts("commit:abc12345def", makeFacts())).toBe(true);
    expect(citationsInFacts("commit:deadbeef", makeFacts())).toBe(false);
  });

  it("recognises path: citations against codeTouched + signal paths", () => {
    expect(citationsInFacts("path:src/auth/service.ts", makeFacts())).toBe(true);
    expect(citationsInFacts("path:src/auth/worker.ts:42", makeFacts())).toBe(true); // from todosAdded
    expect(citationsInFacts("path:src/missing.ts", makeFacts())).toBe(false);
  });

  it("rejects malformed or empty citations", () => {
    expect(citationsInFacts("", makeFacts())).toBe(false);
    expect(citationsInFacts("e-001", makeFacts())).toBe(false); // missing prefix
    expect(citationsInFacts("unknown:foo", makeFacts())).toBe(false);
  });
});

describe("pruneSummaryCitations", () => {
  it("returns the input unchanged when every citation is valid", () => {
    const facts = makeFacts();
    const summary = makeSummary();
    const result = pruneSummaryCitations(summary, facts);
    expect(result.summary).toEqual(summary);
    expect(result.prunedCount).toBe(0);
  });

  it("strips invalid citations from decisions and nextSteps", () => {
    const facts = makeFacts();
    const summary = makeSummary({
      decisions: [
        { text: "valid", evidence: ["work:w-12", "work:w-nope"] },
        { text: "all bogus", evidence: ["work:w-nope"] },
      ],
      nextSteps: [
        { action: "wire", evidence: ["path:src/auth/worker.ts:42", "evt:e-fake"], why: "x" },
      ],
    });
    const result = pruneSummaryCitations(summary, facts);
    expect(result.summary.decisions[0]?.evidence).toEqual(["work:w-12"]);
    expect(result.summary.decisions[1]?.evidence).toEqual([]);
    expect(result.summary.nextSteps[0]?.evidence).toEqual(["path:src/auth/worker.ts:42"]);
    expect(result.prunedCount).toBe(3);
  });

  it("preserves text fields untouched", () => {
    const facts = makeFacts();
    const summary = makeSummary({
      decisions: [{ text: "DO NOT TOUCH", evidence: ["work:w-nope"] }],
    });
    const result = pruneSummaryCitations(summary, facts);
    expect(result.summary.decisions[0]?.text).toBe("DO NOT TOUCH");
    expect(result.summary.tldr).toBe(summary.tldr);
    expect(result.summary.summary).toBe(summary.summary);
  });
});
