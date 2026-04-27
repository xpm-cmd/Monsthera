import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CodeIntelligenceService } from "../../../src/code-intelligence/service.js";
import { createLogger } from "../../../src/core/logger.js";
import { slug } from "../../../src/core/types.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { StructureService } from "../../../src/structure/service.js";
import {
  codeIntelligenceToolDefinitions,
  handleCodeIntelligenceTool,
} from "../../../src/tools/code-intelligence-tools.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop()!;
    await fs.rm(p, { recursive: true, force: true });
  }
});

async function makeService(): Promise<{
  service: CodeIntelligenceService;
  knowledgeRepo: InMemoryKnowledgeArticleRepository;
}> {
  const repoPath = path.join(tmpdir(), `monsthera-ci-tools-${randomUUID()}`);
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  cleanupPaths.push(repoPath);

  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const logger = createLogger({ level: "error", domain: "test" });
  const structureService = new StructureService({ knowledgeRepo, workRepo, repoPath, logger });
  const service = new CodeIntelligenceService({
    knowledgeRepo,
    workRepo,
    structureService,
    repoPath,
    logger,
  });

  return { service, knowledgeRepo };
}

function parsePayload(response: { content: { type: string; text: string }[] }): unknown {
  const block = response.content[0];
  if (!block || block.type !== "text") throw new Error("unexpected response shape");
  return JSON.parse(block.text);
}

describe("code intelligence MCP tools", () => {
  describe("tool definitions", () => {
    it("registers exactly four tools with the canonical code_* names", () => {
      const names = codeIntelligenceToolDefinitions().map((d) => d.name);
      expect(names).toEqual([
        "code_get_ref",
        "code_find_owners",
        "code_analyze_impact",
        "code_detect_changes",
      ]);
    });
  });

  describe("code_detect_changes", () => {
    it("rejects empty changed_paths array with VALIDATION_FAILED", async () => {
      const { service } = await makeService();
      const response = await handleCodeIntelligenceTool(
        "code_detect_changes",
        { changed_paths: [] },
        service,
      );
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string; message: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
      expect(payload.message).toMatch(/at least one path/i);
    });

    it("rejects non-array changed_paths with VALIDATION_FAILED", async () => {
      const { service } = await makeService();
      const response = await handleCodeIntelligenceTool(
        "code_detect_changes",
        { changed_paths: "not-an-array" },
        service,
      );
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
    });

    it("rejects array containing non-string entries with VALIDATION_FAILED", async () => {
      const { service } = await makeService();
      const response = await handleCodeIntelligenceTool(
        "code_detect_changes",
        { changed_paths: ["src/a.ts", 42] },
        service,
      );
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
    });
  });

  describe("code_find_owners", () => {
    it("returns a payload with owners and summary fields", async () => {
      const { service, knowledgeRepo } = await makeService();
      await knowledgeRepo.create({
        title: "Notes",
        slug: slug("notes"),
        category: "architecture",
        content: "x",
        codeRefs: ["src/foo.ts"],
      });

      const response = await handleCodeIntelligenceTool(
        "code_find_owners",
        { ref: "src/foo.ts" },
        service,
      );
      expect(response.isError).toBeFalsy();
      const payload = parsePayload(response) as {
        owners: unknown[];
        summary: { ownerCount: number };
      };
      expect(payload.summary.ownerCount).toBe(1);
      expect(payload.owners).toHaveLength(1);
    });

    it("rejects missing ref with VALIDATION_FAILED", async () => {
      const { service } = await makeService();
      const response = await handleCodeIntelligenceTool("code_find_owners", {}, service);
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
    });
  });

  describe("unknown tool", () => {
    it("returns NOT_FOUND for unrecognized tool names", async () => {
      const { service } = await makeService();
      const response = await handleCodeIntelligenceTool("not_a_tool", {}, service);
      expect(response.isError).toBe(true);
      const payload = parsePayload(response) as { error: string };
      expect(payload.error).toBe("NOT_FOUND");
    });
  });
});
