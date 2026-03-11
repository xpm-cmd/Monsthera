import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../../src/search/interface.js";

const {
  ftsSearchMock,
  ftsInitMock,
  ftsRebuildMock,
  ftsInitKnowledgeMock,
  ftsKnowledgeCurrentMock,
  ftsRebuildKnowledgeMock,
  ftsInitTicketMock,
  ftsTicketCurrentMock,
  ftsRebuildTicketMock,
  ftsFileCurrentMock,
  getHeadMock,
  getIndexedCommitMock,
  knowledgeSearchMock,
  ticketSearchMock,
  zoektAvailableMock,
  zoektSearchMock,
  zoektIndexRepoMock,
  semanticInitializeMock,
  semanticAvailableMock,
  semanticVectorSearchMock,
  mergeResultsMock,
} = vi.hoisted(() => ({
  ftsSearchMock: vi.fn(),
  ftsInitMock: vi.fn(),
  ftsRebuildMock: vi.fn(),
  ftsInitKnowledgeMock: vi.fn(),
  ftsKnowledgeCurrentMock: vi.fn(),
  ftsRebuildKnowledgeMock: vi.fn(),
  ftsInitTicketMock: vi.fn(),
  ftsTicketCurrentMock: vi.fn(),
  ftsRebuildTicketMock: vi.fn(),
  ftsFileCurrentMock: vi.fn(),
  getHeadMock: vi.fn(),
  getIndexedCommitMock: vi.fn(),
  knowledgeSearchMock: vi.fn(),
  ticketSearchMock: vi.fn(),
  zoektAvailableMock: vi.fn(),
  zoektSearchMock: vi.fn(),
  zoektIndexRepoMock: vi.fn(),
  semanticInitializeMock: vi.fn(),
  semanticAvailableMock: vi.fn(),
  semanticVectorSearchMock: vi.fn(),
  mergeResultsMock: vi.fn(),
}));

vi.mock("../../../src/search/fts5.js", () => ({
  FTS5Backend: class {
    name = "fts5" as const;
    initFtsTable = ftsInitMock;
    rebuildIndex = ftsRebuildMock;
    initKnowledgeFts = ftsInitKnowledgeMock;
    isKnowledgeIndexCurrent = ftsKnowledgeCurrentMock;
    rebuildKnowledgeFts = ftsRebuildKnowledgeMock;
    initTicketFts = ftsInitTicketMock;
    isTicketIndexCurrent = ftsTicketCurrentMock;
    rebuildTicketFts = ftsRebuildTicketMock;
    isFileIndexCurrent = ftsFileCurrentMock;
    search = ftsSearchMock;
    searchKnowledge = knowledgeSearchMock;
    searchTickets = ticketSearchMock;
  },
}));

vi.mock("../../../src/search/zoekt.js", () => ({
  ZoektBackend: class {
    name = "zoekt" as const;
    isAvailable = zoektAvailableMock;
    search = zoektSearchMock;
    indexRepo = zoektIndexRepoMock;
  },
}));

vi.mock("../../../src/indexing/indexer.js", () => ({
  getIndexedCommit: getIndexedCommitMock,
}));

vi.mock("../../../src/git/operations.js", () => ({
  getHead: getHeadMock,
}));

vi.mock("../../../src/search/semantic.js", () => ({
  DEFAULT_SEMANTIC_BLEND_ALPHA: 0.5,
  mergeResults: mergeResultsMock,
  SemanticReranker: class {
    initialize = semanticInitializeMock;
    isAvailable = semanticAvailableMock;
    vectorSearch = semanticVectorSearchMock;
  },
}));

import { SearchRouter } from "../../../src/search/router.js";

function createRouter(overrides: Partial<ConstructorParameters<typeof SearchRouter>[0]> = {}) {
  return new SearchRouter({
    repoId: 1,
    sqlite: {} as never,
    db: {} as never,
    repoPath: "/repo",
    zoektEnabled: false,
    semanticEnabled: false,
    indexDir: "/repo/.agora/zoekt",
    ...overrides,
  });
}

describe("SearchRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ftsSearchMock.mockResolvedValue([]);
    zoektAvailableMock.mockResolvedValue(false);
    zoektSearchMock.mockResolvedValue([]);
    semanticInitializeMock.mockResolvedValue(false);
    semanticAvailableMock.mockReturnValue(false);
    semanticVectorSearchMock.mockResolvedValue([]);
    mergeResultsMock.mockImplementation((fts5Results: SearchResult[]) => fts5Results);
    getIndexedCommitMock.mockReturnValue(null);
    getHeadMock.mockResolvedValue("head-1");
    ftsFileCurrentMock.mockReturnValue(false);
    ftsKnowledgeCurrentMock.mockReturnValue(false);
    ftsTicketCurrentMock.mockReturnValue(false);
  });

  it("falls back to FTS5 during initialize when Zoekt is unavailable", async () => {
    const onFallback = vi.fn();
    const router = createRouter({ zoektEnabled: true, onFallback });

    await router.initialize();

    expect(ftsInitMock).toHaveBeenCalledOnce();
    expect(ftsRebuildMock).toHaveBeenCalledWith(1);
    expect(ftsInitKnowledgeMock).toHaveBeenCalledOnce();
    expect(ftsRebuildKnowledgeMock).toHaveBeenCalledOnce();
    expect(ftsInitTicketMock).toHaveBeenCalledOnce();
    expect(ftsRebuildTicketMock).toHaveBeenCalledWith(1);
    expect(onFallback).toHaveBeenCalledWith("Zoekt unavailable, using FTS5 fallback");
    expect(router.getLexicalBackendName()).toBe("fts5");
  });

  it("falls back to FTS5 lexical search when the active backend errors", async () => {
    const lexicalResults = [{ path: "src/fallback.ts", score: 0.75 }];
    const onFallback = vi.fn();
    const router = createRouter({ zoektEnabled: true, onFallback });

    zoektAvailableMock.mockResolvedValue(true);
    zoektSearchMock.mockRejectedValueOnce(new Error("zoekt boom"));
    ftsSearchMock.mockResolvedValueOnce(lexicalResults);

    await router.initialize();
    const results = await router.searchLexical("router fallback", 1, 5, "src/");

    expect(zoektSearchMock).toHaveBeenCalledWith("router fallback", 1, 5, "src/");
    expect(ftsSearchMock).toHaveBeenCalledWith("router fallback", 1, 5, "src/");
    expect(onFallback).toHaveBeenCalledWith("zoekt search failed, falling back to FTS5");
    expect(results).toEqual(lexicalResults);
  });

  it("runs hybrid search and merges lexical and semantic results when semantic is available", async () => {
    const lexicalResults = [{ path: "src/router.ts", score: 0.8 }];
    const vectorResults = [{ path: "src/router.ts", score: 0.9 }];
    const mergedResults = [{ path: "src/router.ts", score: 0.88 }];
    const router = createRouter({ semanticEnabled: true });

    semanticInitializeMock.mockResolvedValue(true);
    semanticAvailableMock.mockReturnValue(true);
    ftsSearchMock.mockResolvedValueOnce(lexicalResults);
    semanticVectorSearchMock.mockResolvedValueOnce(vectorResults);
    mergeResultsMock.mockReturnValueOnce(mergedResults);

    await router.initialize();
    const results = await router.search("hybrid routing", 1, 10, "src/");

    expect(ftsSearchMock).toHaveBeenCalledWith("hybrid routing", 1, 10, "src/");
    expect(semanticVectorSearchMock).toHaveBeenCalledWith("hybrid routing", 1, 10, "src/");
    expect(mergeResultsMock).toHaveBeenCalledWith(lexicalResults, vectorResults, 10, 0.5, true);
    expect(results).toEqual(mergedResults);
    expect(router.getActiveBackendName()).toBe("fts5+semantic");
  });

  it("uses configured semantic alpha when merging hybrid results", async () => {
    const router = createRouter({
      semanticEnabled: true,
      searchConfig: {
        semanticBlendAlpha: 0.65,
        bm25: {
          file: { path: 1.5, summary: 1.0, symbols: 2.0 },
          ticket: { ticketId: 2.5, title: 3.0, description: 1.0, tags: 2.0 },
          knowledge: { title: 3.0, content: 1.0 },
        },
        penalties: { testFiles: 0.4, configFiles: 0.5 },
        thresholds: { relevance: 0.35, scopedRelevance: 0.2, andQueryTermCount: 3 },
      },
    });

    semanticInitializeMock.mockResolvedValue(true);
    semanticAvailableMock.mockReturnValue(true);
    ftsSearchMock.mockResolvedValueOnce([{ path: "src/router.ts", score: 0.8 }]);
    semanticVectorSearchMock.mockResolvedValueOnce([{ path: "src/router.ts", score: 0.9 }]);
    mergeResultsMock.mockReturnValueOnce([{ path: "src/router.ts", score: 0.865 }]);

    await router.initialize();
    await router.search("hybrid routing", 1, 10, "src/");

    expect(mergeResultsMock).toHaveBeenCalledWith(
      [{ path: "src/router.ts", score: 0.8 }],
      [{ path: "src/router.ts", score: 0.9 }],
      10,
      0.65,
      true,
    );
  });

  it("skips redundant FTS rebuilds when indexed commit and table counts are current", async () => {
    const router = createRouter();

    getIndexedCommitMock.mockReturnValue("head-1");
    getHeadMock.mockResolvedValue("head-1");
    ftsFileCurrentMock.mockReturnValue(true);
    ftsKnowledgeCurrentMock.mockReturnValue(true);
    ftsTicketCurrentMock.mockReturnValue(true);

    await router.initialize();

    expect(ftsRebuildMock).not.toHaveBeenCalled();
    expect(ftsRebuildKnowledgeMock).not.toHaveBeenCalled();
    expect(ftsRebuildTicketMock).not.toHaveBeenCalled();
  });
});
