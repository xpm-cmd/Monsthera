import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { IngestService } from "../../../src/ingest/service.js";
import {
  ingestToolDefinitions,
  handleIngestTool,
} from "../../../src/tools/ingest-tools.js";

const repoPaths = new Set<string>();

afterEach(async () => {
  for (const repoPath of repoPaths) {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
  repoPaths.clear();
});

async function createService(): Promise<IngestService> {
  const repoPath = path.join("/tmp", `monsthera-ingest-tools-${randomUUID()}`);
  repoPaths.add(repoPath);
  await fs.mkdir(path.join(repoPath, "docs"), { recursive: true });
  await fs.mkdir(path.join(repoPath, "src", "dashboard"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "src", "dashboard", "index.ts"), "export {};\n", "utf-8");
  await fs.writeFile(
    path.join(repoPath, "docs", "tool-import.md"),
    [
      "# Tool Import",
      "",
      "This document explains how the dashboard coordinates knowledge and work surfaces.",
      "",
      "- Review the API contract",
      "- Keep search index in sync",
      "",
      "See src/dashboard/index.ts for runtime wiring.",
    ].join("\n"),
    "utf-8",
  );

  return new IngestService({
    knowledgeRepo: new InMemoryKnowledgeArticleRepository(),
    repoPath,
    logger: createLogger({ level: "error", output: () => {} }),
  });
}

describe("ingestToolDefinitions", () => {
  it("returns the ingest_local_sources tool definition", () => {
    const defs = ingestToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("ingest_local_sources");
  });
});

describe("handleIngestTool", () => {
  it("imports a local source in summary mode", async () => {
    const service = await createService();
    const response = await handleIngestTool(
      "ingest_local_sources",
      {
        sourcePath: "docs/tool-import.md",
        mode: "summary",
        category: "docs",
      },
      service,
    );

    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as {
      mode: string;
      createdCount: number;
      items: Array<{ sourcePath: string; category: string }>;
    };
    expect(body.mode).toBe("summary");
    expect(body.createdCount).toBe(1);
    expect(body.items[0]?.sourcePath).toBe("docs/tool-import.md");
    expect(body.items[0]?.category).toBe("docs");
  });

  it("rejects an invalid mode", async () => {
    const service = await createService();
    const response = await handleIngestTool(
      "ingest_local_sources",
      {
        sourcePath: "docs/tool-import.md",
        mode: "invalid",
      },
      service,
    );

    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("returns NOT_FOUND for an unknown tool", async () => {
    const service = await createService();
    const response = await handleIngestTool("does_not_exist", {}, service);

    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toContain("does_not_exist");
  });
});
