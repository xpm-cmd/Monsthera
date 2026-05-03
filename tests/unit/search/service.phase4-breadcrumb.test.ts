/**
 * M3 phase 4 — `build_context_pack(mode="code")` inventory breadcrumb
 * (ADR-017 §D4).
 *
 * Separate test file so the existing buildContextPack regression tests
 * in `service.test.ts` keep passing untouched. The breadcrumb is the
 * only new behavior.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SearchService } from "../../../src/search/service.js";
import { InMemorySearchIndexRepository } from "../../../src/search/in-memory-repository.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { StubEmbeddingProvider } from "../../../src/search/embedding.js";
import { createLogger } from "../../../src/core/logger.js";
import { ok, err, type Result } from "../../../src/core/result.js";
import { StorageError } from "../../../src/core/errors.js";
import type { CodeInventoryService } from "../../../src/code-intelligence/inventory/service.js";
import type {
  CodeQueryInput,
  CodeQueryResult,
} from "../../../src/code-intelligence/inventory/types.js";

interface InventoryStub {
  readonly inventory: Pick<CodeInventoryService, "query">;
  readonly calls: CodeQueryInput[];
}

function makeInventoryStub(
  responses: Result<CodeQueryResult, StorageError>[] | (() => Result<CodeQueryResult, StorageError>),
): InventoryStub {
  const calls: CodeQueryInput[] = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  const inventory = {
    async query(input: CodeQueryInput): Promise<Result<CodeQueryResult, StorageError>> {
      calls.push(input);
      if (queue) return queue.shift() ?? ok(emptyResult(input.query));
      return (responses as () => Result<CodeQueryResult, StorageError>)();
    },
  };
  return { inventory, calls };
}

function emptyResult(query: string): CodeQueryResult {
  return {
    query,
    hits: [],
    summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
    recommendedNextActions: [],
  };
}

function inventoryResult(
  query: string,
  hits: { path: string; symbol: string; kind?: "function" | "class" | "file"; score?: number }[],
): CodeQueryResult {
  return {
    query,
    hits: hits.map((h) => ({
      path: h.path,
      symbol: h.symbol,
      kind: h.kind ?? "function",
      score: h.score ?? 1,
    })),
    summary: {
      hitCount: hits.length,
      languageCount: 1,
      fileCount: new Set(hits.map((h) => h.path)).size,
    },
    recommendedNextActions: [],
  };
}

let knowledgeRepo: InMemoryKnowledgeArticleRepository;
let workRepo: InMemoryWorkArticleRepository;

function buildService(inventory?: Pick<CodeInventoryService, "query">) {
  const searchRepo = new InMemorySearchIndexRepository();
  knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  workRepo = new InMemoryWorkArticleRepository();
  const embeddingProvider = new StubEmbeddingProvider();
  const logger = createLogger({ level: "warn", domain: "test" });
  const config = {
    semanticEnabled: false,
    embeddingModel: "stub",
    embeddingProvider: "ollama" as const,
    alpha: 0.5,
    ollamaUrl: "http://localhost:11434",
  };
  return new SearchService({
    searchRepo,
    knowledgeRepo,
    workRepo,
    embeddingProvider,
    config,
    logger,
    ...(inventory && { inventoryService: inventory as unknown as CodeInventoryService }),
  });
}

async function seedKnowledge(overrides?: Record<string, unknown>) {
  const result = await knowledgeRepo.create({
    title: "Auth Architecture",
    category: "architecture",
    content: "Auth flow and guards.",
    codeRefs: ["src/auth/service.ts"],
    ...overrides,
  } as Parameters<InMemoryKnowledgeArticleRepository["create"]>[0]);
  if (!result.ok) throw new Error("Failed to seed knowledge article");
  return result.value;
}

describe("SearchService.buildContextPack — phase 4 inventory breadcrumb", () => {
  beforeEach(() => {
    // services are constructed per-test via buildService() so each can
    // wire (or omit) its own inventory stub.
  });

  it("appends the breadcrumb when inventory has hits NOT in pack-surfaced paths", async () => {
    const stub = makeInventoryStub([
      ok(
        inventoryResult("search", [
          { path: "src/search/service.ts", symbol: "buildContextPack" },
          { path: "src/search/repository.ts", symbol: "InMemorySearchIndexRepository" },
        ]),
      ),
    ]);
    const service = buildService(stub.inventory);
    const knowledge = await seedKnowledge({
      title: "Search overview",
      content: "Notes about searching.",
      codeRefs: ["src/search/api.ts"], // does not cover the inventory hits
    });
    await service.indexKnowledgeArticle(knowledge.id);

    const result = await service.buildContextPack({ query: "search", mode: "code", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const breadcrumb = result.value.guidance.find((g) => g.includes("call code_query"));
    expect(breadcrumb).toBeDefined();
    expect(breadcrumb).toContain("2 additional symbol matches");
    // exactly one breadcrumb, never repeated
    const matchingCount = result.value.guidance.filter((g) => g.includes("call code_query")).length;
    expect(matchingCount).toBe(1);
  });

  it("counts only hits at paths NOT already surfaced via item codeRefs", async () => {
    const stub = makeInventoryStub([
      ok(
        inventoryResult("auth", [
          { path: "src/auth/service.ts", symbol: "AuthService" }, // covered by knowledge below
          { path: "src/auth/router.ts", symbol: "register" }, // covered too
          { path: "src/auth/util.ts", symbol: "hashPassword" }, // not covered → counts
        ]),
      ),
    ]);
    const service = buildService(stub.inventory);
    const knowledge = await seedKnowledge({
      title: "Auth Architecture",
      content: "Auth flow and guards.",
      codeRefs: ["src/auth/service.ts", "src/auth/router.ts"],
    });
    await service.indexKnowledgeArticle(knowledge.id);

    const result = await service.buildContextPack({ query: "auth", mode: "code", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const breadcrumb = result.value.guidance.find((g) => g.includes("call code_query"));
    expect(breadcrumb).toBeDefined();
    expect(breadcrumb).toContain("1 additional symbol matches");
  });

  it("does NOT append the breadcrumb when every inventory hit is already surfaced", async () => {
    const stub = makeInventoryStub([
      ok(
        inventoryResult("auth", [
          { path: "src/auth/service.ts", symbol: "AuthService" },
        ]),
      ),
    ]);
    const service = buildService(stub.inventory);
    const knowledge = await seedKnowledge({
      title: "Auth Architecture",
      content: "Auth flow and guards.",
      codeRefs: ["src/auth/service.ts"],
    });
    await service.indexKnowledgeArticle(knowledge.id);

    const result = await service.buildContextPack({ query: "auth", mode: "code", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const breadcrumb = result.value.guidance.find((g) => g.includes("call code_query"));
    expect(breadcrumb).toBeUndefined();
  });

  it("does NOT append the breadcrumb when inventory has zero hits", async () => {
    const stub = makeInventoryStub([ok(emptyResult("auth"))]);
    const service = buildService(stub.inventory);
    const knowledge = await seedKnowledge();
    await service.indexKnowledgeArticle(knowledge.id);

    const result = await service.buildContextPack({ query: "auth", mode: "code", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const breadcrumb = result.value.guidance.find((g) => g.includes("call code_query"));
    expect(breadcrumb).toBeUndefined();
  });

  it("does NOT append the breadcrumb when mode is not 'code'", async () => {
    const stub = makeInventoryStub([
      ok(
        inventoryResult("auth", [
          { path: "src/auth/util.ts", symbol: "hashPassword" },
        ]),
      ),
    ]);
    const service = buildService(stub.inventory);
    const knowledge = await seedKnowledge();
    await service.indexKnowledgeArticle(knowledge.id);

    const generalResult = await service.buildContextPack({ query: "auth", mode: "general", limit: 5 });
    expect(generalResult.ok).toBe(true);
    if (!generalResult.ok) return;
    expect(
      generalResult.value.guidance.find((g) => g.includes("call code_query")),
    ).toBeUndefined();

    const researchResult = await service.buildContextPack({ query: "auth", mode: "research", limit: 5 });
    expect(researchResult.ok).toBe(true);
    if (!researchResult.ok) return;
    expect(
      researchResult.value.guidance.find((g) => g.includes("call code_query")),
    ).toBeUndefined();

    // Inventory must not even be queried for non-code modes.
    expect(stub.calls).toHaveLength(0);
  });

  it("does NOT append the breadcrumb when no inventoryService is wired (M2 path)", async () => {
    const service = buildService(); // no inventory
    const knowledge = await seedKnowledge();
    await service.indexKnowledgeArticle(knowledge.id);

    const result = await service.buildContextPack({ query: "auth", mode: "code", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.guidance.find((g) => g.includes("call code_query"))).toBeUndefined();
  });

  it("inventory query failures are swallowed; pack still returns Result.ok", async () => {
    const inventory: Pick<CodeInventoryService, "query"> = {
      async query() {
        return err(new StorageError("inventory crashed"));
      },
    };
    const service = buildService(inventory);
    const knowledge = await seedKnowledge();
    await service.indexKnowledgeArticle(knowledge.id);

    const result = await service.buildContextPack({ query: "auth", mode: "code", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.guidance.find((g) => g.includes("call code_query"))).toBeUndefined();
  });
});
