import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { slug } from "../../../src/core/types.js";
import { StructureService } from "../../../src/structure/service.js";
import { refsToolDefinitions, handleRefsTool } from "../../../src/tools/refs-tools.js";

async function makeService() {
  const repoPath = path.join("/tmp", `monsthera-refs-stale-${randomUUID()}`);
  await fs.mkdir(repoPath, { recursive: true });
  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const service = new StructureService({
    knowledgeRepo,
    workRepo,
    repoPath,
    logger: createLogger({ level: "error", domain: "test" }),
  });
  return { service, knowledgeRepo };
}

// Freeze the clock exactly at midnight UTC — the boundary where day-granular
// staleness math used to race real time between fixture creation and the
// service's own Date.now() read.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-10T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

describe("refs_stale MCP tool", () => {
  it("is registered in the refs tool definitions with an empty input schema", () => {
    const def = refsToolDefinitions().find((d) => d.name === "refs_stale");
    expect(def).toBeDefined();
    expect(def?.inputSchema.properties).toEqual({});
  });

  it("returns the consolidated staleness report", async () => {
    const { service, knowledgeRepo } = await makeService();
    await knowledgeRepo.create({
      title: "Ancient",
      slug: slug("ancient"),
      category: "context",
      content: "old body",
      updatedAt: daysAgo(120),
      createdAt: daysAgo(120),
    });

    const response = await handleRefsTool("refs_stale", {}, service);
    expect(response.isError).toBeUndefined();

    const payload = JSON.parse(response.content[0]?.text ?? "{}") as {
      summary: { knowledgeScanned: number };
      staleArticles: { title: string }[];
    };
    expect(payload.summary.knowledgeScanned).toBe(1);
    expect(payload.staleArticles.map((a) => a.title)).toContain("Ancient");
  });

  it("returns an error response for an unknown tool name", async () => {
    const { service } = await makeService();
    const response = await handleRefsTool("refs_unknown", {}, service);
    expect(response.isError).toBe(true);
  });
});
