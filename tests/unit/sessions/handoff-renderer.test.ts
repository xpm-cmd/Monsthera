import { describe, it, expect } from "vitest";
import {
  renderHandoffArticle,
  buildHandoffTitle,
  buildHandoffSlug,
  buildHandoffTags,
} from "../../../src/sessions/handoff-renderer.js";
import type { Session } from "../../../src/sessions/repository.js";
import type { LLMSummary } from "../../../src/sessions/llm-summarizer.js";
import type { SessionFacts } from "../../../src/sessions/schemas.js";
import { agentId, sessionId, timestamp } from "../../../src/core/types.js";
import { SessionStatus } from "../../../src/sessions/schemas.js";

function makeSession(): Session {
  return {
    id: sessionId("ses-20260512-104300-claude-code"),
    agentId: agentId("claude-code"),
    repo: "/tmp/repo-a",
    branch: "main",
    openedAt: timestamp("2026-05-12T10:43:00Z"),
    closedAt: timestamp("2026-05-12T11:30:00Z"),
    status: SessionStatus.CLOSED,
    handoffArticleId: null,
    factsPath: "/tmp/repo-a/knowledge/sessions/ses-20260512-104300-claude-code.facts.json",
    parentSessionId: sessionId("ses-20260510-090000-claude-code"),
    abandonReason: null,
    quality: { score: 4, degraded: false, model: "qwen2.5-coder:7b" },
    intent: "Ship M3 phase 5",
  };
}

function makeFacts(): SessionFacts {
  return {
    sessionId: "ses-20260512-104300-claude-code",
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
    signals: { todosAdded: [], questions: [], testFailures: [] },
    agentNote: "Land M3 phase 5",
  };
}

function makeSummary(): LLMSummary {
  return {
    tldr: "Shipped M3 phase 5 with auth refresh.",
    summary: "We landed PR #101 with the auth refresh logic.\n\nReview surfaced no blockers.",
    decisions: [{ text: "Use refresh tokens", evidence: ["work:w-12"] }],
    blockers: [],
    surprises: [],
    deferred: ["Token rotation for service-to-service auth"],
    nextSteps: [
      {
        action: "Smoke test on a third consumer repo",
        evidence: ["work:w-12"],
        why: "Confirms cross-repo wiring before broad rollout",
      },
    ],
    openQuestions: [],
    suggestedAgent: "performance",
  };
}

describe("buildHandoffSlug / buildHandoffTitle / buildHandoffTags", () => {
  it("slug derives from session id", () => {
    const session = makeSession();
    expect(buildHandoffSlug(session)).toBe("handoff-ses-20260512-104300-claude-code");
  });

  it("title encodes date + agent + duration", () => {
    const session = makeSession();
    const title = buildHandoffTitle(session);
    expect(title).toContain("2026-05-12");
    expect(title).toContain("claude-code");
    expect(title).toContain("min"); // duration suffix
  });

  it("tags include canonical agent + session-handoff markers", () => {
    const session = makeSession();
    const tags = buildHandoffTags(session);
    expect(tags).toContain("session-handoff");
    expect(tags).toContain("agent:claude-code");
  });
});

describe("renderHandoffArticle", () => {
  it("includes a TL;DR heading with the LLM tldr text", () => {
    const out = renderHandoffArticle(makeSession(), makeFacts(), makeSummary());
    expect(out).toContain("## TL;DR");
    expect(out).toContain("Shipped M3 phase 5 with auth refresh.");
  });

  it("renders What happened with summary + decisions + deferred (skipping empty sections)", () => {
    const out = renderHandoffArticle(makeSession(), makeFacts(), makeSummary());
    expect(out).toContain("## What happened");
    expect(out).toContain("PR #101");
    expect(out).toContain("### Decisions");
    expect(out).toContain("Use refresh tokens");
    expect(out).toContain("evidence: [work:w-12]");
    expect(out).toContain("### Deferred");
    expect(out).toContain("Token rotation");
    expect(out).not.toContain("### Blockers"); // empty array → skipped
    expect(out).not.toContain("### Surprises"); // empty array → skipped
  });

  it("renders What's next with first-action callout, evidence, and suggested agent", () => {
    const out = renderHandoffArticle(makeSession(), makeFacts(), makeSummary());
    expect(out).toContain("## What's next");
    expect(out).toContain("### First action");
    expect(out).toContain("Smoke test on a third consumer repo");
    expect(out).toContain("evidence: [work:w-12]");
    expect(out).toContain("suggested agent: performance");
  });

  it("renders the Hypergraph section listing work/knowledge/code/events touched", () => {
    const out = renderHandoffArticle(makeSession(), makeFacts(), makeSummary());
    expect(out).toContain("## Hypergraph");
    expect(out).toContain("**Work touched**");
    expect(out).toContain("w-12");
    expect(out).toContain("**Knowledge created/updated**");
    expect(out).toContain("auth-design");
    expect(out).toContain("**Code touched**");
    expect(out).toContain("src/auth/service.ts");
    expect(out).toContain("Events in window: 2");
  });

  it("includes a session header block with id/agent/duration/quality + previous pointer", () => {
    const out = renderHandoffArticle(makeSession(), makeFacts(), makeSummary());
    expect(out).toContain("ses-20260512-104300-claude-code");
    expect(out).toContain("claude-code");
    expect(out).toContain("Quality 4/5");
    expect(out).toContain("qwen2.5-coder:7b");
    expect(out).toContain("ses-20260510-090000-claude-code"); // parent reference
  });

  it("emits a Facts reference pointing at the JSON sidecar", () => {
    const out = renderHandoffArticle(makeSession(), makeFacts(), makeSummary());
    expect(out).toContain("## Facts");
    expect(out).toContain("ses-20260512-104300-claude-code.facts.json");
  });
});
