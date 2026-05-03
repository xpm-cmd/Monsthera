import { describe, it, expect } from "vitest";

import {
  codeQueryToolDefinitions,
  handleCodeQueryTool,
} from "../../../src/tools/code-query-tool.js";
import type { CodeInventoryService } from "../../../src/code-intelligence/inventory/service.js";
import type {
  CodeQueryHit,
  CodeQueryInput,
  CodeQueryResult,
} from "../../../src/code-intelligence/inventory/types.js";
import { ok, err } from "../../../src/core/result.js";
import type { Result } from "../../../src/core/result.js";
import { StorageError } from "../../../src/core/errors.js";

/**
 * Build a stub `CodeInventoryService` that records each `query()` call and
 * resolves to the configured outcome. We don't extend the real class —
 * structural typing is enough for the tool, and a minimal stub keeps these
 * tests focused on the boundary between Zod validation, the service, and
 * the MCP transport.
 */
function makeStubInventoryService(
  outcome: Result<CodeQueryResult, StorageError>,
): CodeInventoryService & { lastInput?: CodeQueryInput; callCount: number } {
  const stub = {
    callCount: 0,
    lastInput: undefined as CodeQueryInput | undefined,
    async query(input: CodeQueryInput) {
      stub.callCount += 1;
      stub.lastInput = input;
      return outcome;
    },
  } as CodeInventoryService & {
    lastInput?: CodeQueryInput;
    callCount: number;
  };
  return stub;
}

function parsePayload(response: { content: { type: string; text: string }[] }): unknown {
  const block = response.content[0];
  if (!block || block.type !== "text") throw new Error("unexpected response shape");
  return JSON.parse(block.text);
}

function makeHit(overrides: Partial<CodeQueryHit> = {}): CodeQueryHit {
  return {
    path: "src/example.ts",
    symbol: "example",
    kind: "function",
    language: "typescript",
    score: 1,
    ...overrides,
  };
}

describe("code_query MCP tool", () => {
  describe("definition", () => {
    it("registers exactly one tool named code_query", () => {
      const defs = codeQueryToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0]!.name).toBe("code_query");
      expect(defs[0]!.inputSchema.required).toEqual(["query"]);
    });

    it("documents the full kind enum including 'file'", () => {
      const defs = codeQueryToolDefinitions();
      const kinds = (
        defs[0]!.inputSchema.properties.kinds as { items: { enum: readonly string[] } }
      ).items.enum;
      expect(kinds).toEqual([
        "function",
        "class",
        "interface",
        "type",
        "enum",
        "namespace",
        "module",
        "record",
        "file",
      ]);
    });
  });

  describe("validation", () => {
    it("rejects unknown tool names with NOT_FOUND", async () => {
      const stub = makeStubInventoryService(
        ok({
          query: "x",
          hits: [],
          summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
          recommendedNextActions: [],
        }),
      );
      const response = await handleCodeQueryTool("not_a_tool", { query: "abc" }, stub);
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("NOT_FOUND");
      expect(stub.callCount).toBe(0);
    });

    it("rejects missing query", async () => {
      const stub = makeStubInventoryService(
        ok({
          query: "",
          hits: [],
          summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
          recommendedNextActions: [],
        }),
      );
      const response = await handleCodeQueryTool("code_query", {}, stub);
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string; message: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
      expect(payload.message).toContain("query");
      expect(stub.callCount).toBe(0);
    });

    it("rejects query under 2 characters", async () => {
      const stub = makeStubInventoryService(
        ok({
          query: "x",
          hits: [],
          summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
          recommendedNextActions: [],
        }),
      );
      const response = await handleCodeQueryTool("code_query", { query: "x" }, stub);
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
      expect(stub.callCount).toBe(0);
    });

    it("rejects query over 200 characters", async () => {
      const stub = makeStubInventoryService(
        ok({
          query: "x",
          hits: [],
          summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
          recommendedNextActions: [],
        }),
      );
      const response = await handleCodeQueryTool(
        "code_query",
        { query: "x".repeat(201) },
        stub,
      );
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
      expect(stub.callCount).toBe(0);
    });

    it("rejects an unknown kind value", async () => {
      const stub = makeStubInventoryService(
        ok({
          query: "abc",
          hits: [],
          summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
          recommendedNextActions: [],
        }),
      );
      const response = await handleCodeQueryTool(
        "code_query",
        { query: "abc", kinds: ["function", "macro"] },
        stub,
      );
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
      expect(stub.callCount).toBe(0);
    });

    it("rejects paths array longer than 100 entries", async () => {
      const stub = makeStubInventoryService(
        ok({
          query: "abc",
          hits: [],
          summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
          recommendedNextActions: [],
        }),
      );
      const response = await handleCodeQueryTool(
        "code_query",
        { query: "abc", paths: Array(101).fill("src/a") },
        stub,
      );
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
      expect(stub.callCount).toBe(0);
    });

    it("rejects limit below 1", async () => {
      const stub = makeStubInventoryService(
        ok({
          query: "abc",
          hits: [],
          summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
          recommendedNextActions: [],
        }),
      );
      const response = await handleCodeQueryTool(
        "code_query",
        { query: "abc", limit: 0 },
        stub,
      );
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
      expect(stub.callCount).toBe(0);
    });

    it("rejects limit above 500", async () => {
      const stub = makeStubInventoryService(
        ok({
          query: "abc",
          hits: [],
          summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
          recommendedNextActions: [],
        }),
      );
      const response = await handleCodeQueryTool(
        "code_query",
        { query: "abc", limit: 501 },
        stub,
      );
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
      expect(stub.callCount).toBe(0);
    });

    it("rejects non-integer limit", async () => {
      const stub = makeStubInventoryService(
        ok({
          query: "abc",
          hits: [],
          summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
          recommendedNextActions: [],
        }),
      );
      const response = await handleCodeQueryTool(
        "code_query",
        { query: "abc", limit: 5.5 },
        stub,
      );
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
      expect(stub.callCount).toBe(0);
    });
  });

  describe("happy path", () => {
    it("forwards the validated input to the service and returns its payload", async () => {
      const stubResult: CodeQueryResult = {
        query: "SearchService",
        hits: [
          makeHit({ symbol: "SearchService", kind: "class", score: 12 }),
          makeHit({ symbol: "searchService", path: "src/search/index.ts", score: 8 }),
        ],
        summary: { hitCount: 2, languageCount: 1, fileCount: 2 },
        recommendedNextActions: [
          "Run build_context_pack on the top hit to retrieve linked Monsthera context.",
        ],
      };
      const stub = makeStubInventoryService(ok(stubResult));

      const response = await handleCodeQueryTool(
        "code_query",
        {
          query: "SearchService",
          kinds: ["class", "function"],
          paths: ["src/search"],
          languages: ["typescript"],
          limit: 5,
        },
        stub,
      );

      expect(response.isError).toBeFalsy();
      expect(stub.callCount).toBe(1);
      expect(stub.lastInput).toEqual({
        query: "SearchService",
        kinds: ["class", "function"],
        paths: ["src/search"],
        languages: ["typescript"],
        limit: 5,
      });
      const payload = parsePayload(response) as CodeQueryResult;
      expect(payload).toEqual(stubResult);
    });

    it("preserves service-side ranking — does not re-sort the response", async () => {
      const ordered: CodeQueryResult = {
        query: "parser",
        hits: [
          makeHit({ symbol: "Parser", score: 12 }),
          makeHit({ symbol: "parseLine", score: 8, path: "src/a.ts" }),
          makeHit({ symbol: "parsePath", score: 4, path: "src/b.ts" }),
        ],
        summary: { hitCount: 3, languageCount: 1, fileCount: 3 },
        recommendedNextActions: [],
      };
      const stub = makeStubInventoryService(ok(ordered));
      const response = await handleCodeQueryTool("code_query", { query: "parser" }, stub);
      const payload = parsePayload(response) as CodeQueryResult;
      expect(payload.hits.map((h) => h.symbol)).toEqual(["Parser", "parseLine", "parsePath"]);
    });

    it("respects limit by passing it through to the service", async () => {
      const stub = makeStubInventoryService(
        ok({
          query: "abc",
          hits: [makeHit()],
          summary: { hitCount: 1, languageCount: 1, fileCount: 1 },
          recommendedNextActions: [],
        }),
      );
      await handleCodeQueryTool("code_query", { query: "abc", limit: 1 }, stub);
      expect(stub.lastInput?.limit).toBe(1);
    });
  });

  describe("inventory not built", () => {
    it("surfaces the empty-result hint produced by the service", async () => {
      const stub = makeStubInventoryService(
        ok({
          query: "anything",
          hits: [],
          summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
          recommendedNextActions: [
            "Inventory has not been built yet. Run monsthera code reindex to build it.",
          ],
        }),
      );

      const response = await handleCodeQueryTool(
        "code_query",
        { query: "anything" },
        stub,
      );

      expect(response.isError).toBeFalsy();
      const payload = parsePayload(response) as CodeQueryResult;
      expect(payload.summary.hitCount).toBe(0);
      expect(payload.hits).toEqual([]);
      expect(payload.recommendedNextActions).toContain(
        "Inventory has not been built yet. Run monsthera code reindex to build it.",
      );
    });
  });

  describe("service errors", () => {
    it("converts StorageError into an MCP error response", async () => {
      const stub = makeStubInventoryService(
        err(new StorageError("disk on fire", { path: ".monsthera/cache/code-index.json" })),
      );

      const response = await handleCodeQueryTool(
        "code_query",
        { query: "anything" },
        stub,
      );

      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string; message: string };
      expect(payload.error).toBe("STORAGE_ERROR");
      expect(payload.message).toContain("disk on fire");
    });
  });
});
