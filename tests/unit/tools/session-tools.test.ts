import { describe, it, expect, beforeEach } from "vitest";
import {
  sessionToolDefinitions,
  handleSessionTool,
} from "../../../src/tools/session-tools.js";
import type { SessionToolDeps } from "../../../src/tools/session-tools.js";
import { SessionService } from "../../../src/sessions/service.js";
import { InMemorySessionRepository } from "../../../src/sessions/in-memory-repository.js";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { agentId, sessionId, timestamp } from "../../../src/core/types.js";
import type { FactsExtractor } from "../../../src/sessions/facts-extractor.js";
import type { SessionFacts } from "../../../src/sessions/schemas.js";
import { ok } from "../../../src/core/result.js";

function stubExtractor(): FactsExtractor {
  return {
    async extract(session, agentNote) {
      const facts: SessionFacts = {
        sessionId: session.id,
        agent: session.agentId,
        repo: session.repo,
        branch: session.branch,
        window: {
          openedAt: session.openedAt,
          closedAt: session.closedAt ?? new Date().toISOString(),
        },
        events: [],
        workTouched: [],
        knowledgeTouched: [],
        codeTouched: [],
        commits: [],
        signals: { todosAdded: [], questions: [], testFailures: [] },
        agentNote: agentNote ?? null,
      };
      return ok(facts);
    },
  };
}

async function makeDeps(): Promise<SessionToolDeps> {
  const logger = createLogger({ level: "warn", domain: "test" });
  const sessionRepo = new InMemorySessionRepository();
  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const knowledgeService = new KnowledgeService({ knowledgeRepo, logger });
  const sessionService = new SessionService(sessionRepo, stubExtractor(), {
    knowledgeService,
    // No worker; we'll force sync close on each test that needs it.
    resolveWorkerScript: () => null,
  });
  return { sessionService };
}

describe("sessionToolDefinitions", () => {
  it("returns exactly 5 tools", () => {
    expect(sessionToolDefinitions()).toHaveLength(5);
  });

  it("tool names match the expected set", () => {
    const names = sessionToolDefinitions().map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "session_open",
        "session_close",
        "session_get",
        "session_list",
        "session_brief",
      ]),
    );
  });

  it("each tool has name, description, and inputSchema", () => {
    for (const def of sessionToolDefinitions()) {
      expect(typeof def.name).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema.type).toBe("object");
    }
  });
});

describe("handleSessionTool", () => {
  let deps: SessionToolDeps;

  beforeEach(async () => {
    deps = await makeDeps();
  });

  describe("session_open", () => {
    it("creates a new open session for the given agent + repo", async () => {
      const response = await handleSessionTool(
        "session_open",
        { agentId: "claude-code", repo: "/tmp/repo-a" },
        deps,
      );
      expect(response.isError).toBeFalsy();
      const payload = JSON.parse(response.content[0]!.text);
      expect(payload.session.status).toBe("open");
      expect(payload.session.agentId).toBe("claude-code");
    });

    it("errors when agentId is missing", async () => {
      const response = await handleSessionTool(
        "session_open",
        { repo: "/tmp/repo-a" },
        deps,
      );
      expect(response.isError).toBe(true);
    });
  });

  describe("session_close", () => {
    it("closes an open session by sessionId, returning the lifecycle outcome", async () => {
      const opened = await deps.sessionService.open({
        agentId: agentId("claude-code"),
        repo: "/tmp/repo-a",
      });
      if (!opened.ok) throw new Error("setup open failed");

      const response = await handleSessionTool(
        "session_close",
        { sessionId: opened.value.session.id as string, noLlm: true, sync: true },
        deps,
      );
      expect(response.isError).toBeFalsy();
      const payload = JSON.parse(response.content[0]!.text);
      expect(payload.session.status).toBe("closed");
      // With --no-llm, the article is still persisted by the sync path
      expect(payload.degraded).toBe(true);
    });
  });

  describe("session_get", () => {
    it("returns the session by id", async () => {
      const opened = await deps.sessionService.open({
        agentId: agentId("claude-code"),
        repo: "/tmp/repo-a",
      });
      if (!opened.ok) throw new Error("setup open failed");
      const response = await handleSessionTool(
        "session_get",
        { sessionId: opened.value.session.id as string },
        deps,
      );
      expect(response.isError).toBeFalsy();
      const payload = JSON.parse(response.content[0]!.text);
      expect(payload.id).toBe(opened.value.session.id);
    });

    it("returns an error response for an unknown session id", async () => {
      const response = await handleSessionTool(
        "session_get",
        { sessionId: "ses-does-not-exist" },
        deps,
      );
      expect(response.isError).toBe(true);
    });
  });

  describe("session_list", () => {
    it("returns sessions filtered by status", async () => {
      await deps.sessionService.open({ agentId: agentId("claude-code"), repo: "/tmp/repo-a" });
      const response = await handleSessionTool(
        "session_list",
        { status: "open" },
        deps,
      );
      expect(response.isError).toBeFalsy();
      const payload = JSON.parse(response.content[0]!.text);
      expect(Array.isArray(payload.sessions)).toBe(true);
      expect(payload.sessions.length).toBe(1);
      expect(payload.sessions[0].status).toBe("open");
    });
  });

  describe("session_brief", () => {
    it("returns the brief body for a session, defaulting to standard depth", async () => {
      // Seed a closed session with a handoff article attached.
      const created = await (deps.sessionService as unknown as {
        repo: InMemorySessionRepository;
      }).repo;
      // Use the repo directly through the service: open + close (no LLM) attaches the article.
      const opened = await deps.sessionService.open({
        agentId: agentId("claude-code"),
        repo: "/tmp/repo-a",
      });
      if (!opened.ok) throw new Error("setup open failed");
      const closed = await deps.sessionService.close({
        sessionId: opened.value.session.id,
        noLlm: true,
        sync: true,
      });
      if (!closed.ok) throw new Error("setup close failed");

      const response = await handleSessionTool(
        "session_brief",
        { sessionId: opened.value.session.id as string },
        deps,
      );
      expect(response.isError).toBeFalsy();
      const payload = JSON.parse(response.content[0]!.text);
      expect(typeof payload.body).toBe("string");
      expect(payload.body.length).toBeGreaterThan(0);
      expect(payload.session.id).toBe(opened.value.session.id);
    });

    it("errors when neither sessionId nor (agentId + repo) is given", async () => {
      const response = await handleSessionTool(
        "session_brief",
        {},
        deps,
      );
      expect(response.isError).toBe(true);
    });

    it("supports depth=teaser", async () => {
      const opened = await deps.sessionService.open({
        agentId: agentId("claude-code"),
        repo: "/tmp/repo-a",
      });
      if (!opened.ok) throw new Error("setup open failed");
      await deps.sessionService.close({
        sessionId: opened.value.session.id,
        noLlm: true,
        sync: true,
      });

      const response = await handleSessionTool(
        "session_brief",
        { sessionId: opened.value.session.id as string, depth: "teaser" },
        deps,
      );
      expect(response.isError).toBeFalsy();
      const payload = JSON.parse(response.content[0]!.text);
      // Teaser must not include the full "What happened" narrative.
      expect(payload.body).not.toContain("## What happened");
    });
  });

  it("returns an error for an unknown tool name", async () => {
    const response = await handleSessionTool("session_unknown", {}, deps);
    expect(response.isError).toBe(true);
  });
});
