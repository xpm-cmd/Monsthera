import { describe, it, expect, beforeEach } from "vitest";
import { handleSearchTool } from "../../../src/tools/search-tools.js";
import { SearchService } from "../../../src/search/service.js";
import { InMemorySearchIndexRepository } from "../../../src/search/in-memory-repository.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { StubEmbeddingProvider } from "../../../src/search/embedding.js";
import { createLogger } from "../../../src/core/logger.js";
import { SnapshotService } from "../../../src/context/snapshot-service.js";
import { InMemorySnapshotRepository } from "../../../src/context/snapshot-in-memory-repository.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface Harness {
  readonly service: SearchService;
  readonly knowledgeRepo: InMemoryKnowledgeArticleRepository;
  readonly workRepo: InMemoryWorkArticleRepository;
  readonly snapshotRepo: InMemorySnapshotRepository;
  readonly snapshotService: SnapshotService;
}

function createHarness(opts?: { maxAgeMinutes?: number; now?: () => number }): Harness {
  const searchRepo = new InMemorySearchIndexRepository();
  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const embeddingProvider = new StubEmbeddingProvider();
  const logger = createLogger({ level: "warn", domain: "test" });
  const config = {
    semanticEnabled: false,
    embeddingModel: "stub",
    embeddingProvider: "ollama" as const,
    alpha: 0.5,
    ollamaUrl: "http://localhost:11434",
  };
  const service = new SearchService({
    searchRepo,
    knowledgeRepo,
    workRepo,
    embeddingProvider,
    config,
    logger,
  });
  const snapshotRepo = new InMemorySnapshotRepository();
  const snapshotService = new SnapshotService({
    repo: snapshotRepo,
    logger,
    maxAgeMinutes: opts?.maxAgeMinutes ?? 30,
    now: opts?.now,
  });
  return { service, knowledgeRepo, workRepo, snapshotRepo, snapshotService };
}

async function seedKnowledge(harness: Harness): Promise<void> {
  const created = await harness.knowledgeRepo.create({
    title: "Auth Guide",
    category: "guide",
    content: "How to authenticate.",
  });
  if (!created.ok) throw new Error("seed failed");
  await harness.service.indexKnowledgeArticle(created.value.id);
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("build_context_pack snapshot integration", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("omits the snapshot field when no agent_id or work_id is provided", async () => {
    await seedKnowledge(harness);
    await harness.snapshotService.record({ agentId: "agent-1", cwd: "/tmp" });
    const response = await handleSearchTool(
      "build_context_pack",
      { query: "authenticate" },
      harness.service,
      {
        knowledgeRepo: harness.knowledgeRepo,
        workRepo: harness.workRepo,
        snapshotService: harness.snapshotService,
      },
    );
    expect(response.isError).toBeFalsy();
    const body = parse(response.content[0]!.text);
    expect(body.snapshot).toBeUndefined();
  });

  it("returns null-safe pack when agent_id has no snapshot yet", async () => {
    await seedKnowledge(harness);
    const response = await handleSearchTool(
      "build_context_pack",
      { query: "authenticate", agent_id: "agent-1" },
      harness.service,
      {
        knowledgeRepo: harness.knowledgeRepo,
        workRepo: harness.workRepo,
        snapshotService: harness.snapshotService,
      },
    );
    expect(response.isError).toBeFalsy();
    const body = parse(response.content[0]!.text);
    expect(body.snapshot).toBeUndefined();
  });

  it("includes the snapshot summary when agent_id has a recent snapshot", async () => {
    await seedKnowledge(harness);
    await harness.snapshotService.record({
      agentId: "agent-1",
      cwd: "/home/user/project",
      runtimes: { node: "20.11.0" },
      packageManagers: ["pnpm"],
    });
    const response = await handleSearchTool(
      "build_context_pack",
      { query: "authenticate", agent_id: "agent-1" },
      harness.service,
      {
        knowledgeRepo: harness.knowledgeRepo,
        workRepo: harness.workRepo,
        snapshotService: harness.snapshotService,
      },
    );
    expect(response.isError).toBeFalsy();
    const body = parse(response.content[0]!.text) as {
      snapshot?: { cwd: string; stale: boolean };
      guidance: readonly string[];
    };
    expect(body.snapshot).toBeDefined();
    expect(body.snapshot!.cwd).toBe("/home/user/project");
    expect(body.snapshot!.stale).toBe(false);
    expect(body.guidance.some((g) => g.startsWith("stale_snapshot"))).toBe(false);
  });

  it("emits a stale_snapshot guidance line when the snapshot is older than maxAgeMinutes", async () => {
    const fixedNow = Date.UTC(2026, 3, 19, 12, 0, 0);
    harness = createHarness({ maxAgeMinutes: 30, now: () => fixedNow });
    await seedKnowledge(harness);
    const recorded = await harness.snapshotRepo.record({
      agentId: "agent-1",
      cwd: "/tmp",
      files: [],
      runtimes: {},
      packageManagers: [],
      lockfiles: [],
    });
    if (!recorded.ok) throw new Error("seed failed");
    // Age the snapshot past the 30-minute threshold.
    (recorded.value as { capturedAt: string }).capturedAt = new Date(
      fixedNow - 2 * 60 * 60 * 1000,
    ).toISOString();

    const response = await handleSearchTool(
      "build_context_pack",
      { query: "authenticate", agent_id: "agent-1" },
      harness.service,
      {
        knowledgeRepo: harness.knowledgeRepo,
        workRepo: harness.workRepo,
        snapshotService: harness.snapshotService,
      },
    );
    expect(response.isError).toBeFalsy();
    const body = parse(response.content[0]!.text) as {
      snapshot?: { stale: boolean };
      guidance: readonly string[];
    };
    expect(body.snapshot).toBeDefined();
    expect(body.snapshot!.stale).toBe(true);
    expect(body.guidance.some((g) => g.startsWith("stale_snapshot"))).toBe(true);
  });

  it("rejects non-string agent_id values at the tool boundary", async () => {
    const response = await handleSearchTool(
      "build_context_pack",
      { query: "authenticate", agent_id: 123 },
      harness.service,
      {
        knowledgeRepo: harness.knowledgeRepo,
        workRepo: harness.workRepo,
        snapshotService: harness.snapshotService,
      },
    );
    expect(response.isError).toBe(true);
  });
});
