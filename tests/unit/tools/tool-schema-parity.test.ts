import { describe, it, expect } from "vitest";
import { knowledgeToolDefinitions, handleKnowledgeTool } from "../../../src/tools/knowledge-tools.js";
import { workToolDefinitions, handleWorkTool } from "../../../src/tools/work-tools.js";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { WorkService } from "../../../src/work/service.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import type { Logger } from "../../../src/core/logger.js";

/**
 * H4 — the MCP tool schemas must advertise exactly what the chain below
 * them honors, and the chain must never silently drop a declared field.
 * Each pin here covers one row of the H4 gap matrix: either a capability
 * that existed downstream but was unadvertised/unreachable, or an input
 * that used to vanish without an error.
 */

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

function knowledgeService(): KnowledgeService {
  return new KnowledgeService({
    knowledgeRepo: new InMemoryKnowledgeArticleRepository(),
    logger: noopLogger,
  });
}

function workService(): WorkService {
  return new WorkService({
    workRepo: new InMemoryWorkArticleRepository(),
    orchestrationRepo: new InMemoryOrchestrationEventRepository(),
    logger: noopLogger,
  });
}

function schemaOf(name: string): Record<string, unknown> {
  const defs = [...knowledgeToolDefinitions(), ...workToolDefinitions()];
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`tool not found: ${name}`);
  return def.inputSchema.properties;
}

function itemPropsOf(name: string, arrayProp: string): Record<string, unknown> {
  const props = schemaOf(name);
  const arr = props[arrayProp] as { items?: { properties?: Record<string, unknown> } };
  if (!arr.items?.properties) throw new Error(`no item properties on ${name}.${arrayProp}`);
  return arr.items.properties;
}

function parseBody(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

describe("tool schemas advertise the real capability surface", () => {
  it("create_article declares sourcePath", () => {
    expect(schemaOf("create_article")).toHaveProperty("sourcePath");
  });

  it("update_article declares sourcePath", () => {
    expect(schemaOf("update_article")).toHaveProperty("sourcePath");
  });

  it("batch_create_articles items declare extraFrontmatter and sourcePath", () => {
    const props = itemPropsOf("batch_create_articles", "articles");
    expect(props).toHaveProperty("extraFrontmatter");
    expect(props).toHaveProperty("sourcePath");
  });

  it("batch_update_articles items declare the full update_article field set", () => {
    const props = itemPropsOf("batch_update_articles", "updates");
    expect(props).toHaveProperty("extraFrontmatter");
    expect(props).toHaveProperty("sourcePath");
    expect(props).toHaveProperty("add_tags");
    expect(props).toHaveProperty("remove_tags");
  });

  it("create_work declares dependencies and blockedBy", () => {
    const props = schemaOf("create_work");
    expect(props).toHaveProperty("dependencies");
    expect(props).toHaveProperty("blockedBy");
  });
});

describe("the chain below the tools honors what the schemas declare", () => {
  it("update_article applies sourcePath end to end (the original H4 case)", async () => {
    const service = knowledgeService();
    const created = await service.createArticle({
      title: "Tool Sourced",
      category: "context",
      content: "Body.",
    });
    if (!created.ok) throw new Error("seed failed");

    const res = await handleKnowledgeTool(
      "update_article",
      { id: created.value.id, sourcePath: "docs/from-tool.md" },
      service,
    );

    expect(res.isError).toBeUndefined();
    expect(parseBody(res).sourcePath).toBe("docs/from-tool.md");
  });

  it("update_article rejects an unknown key instead of stripping it", async () => {
    const service = knowledgeService();
    const created = await service.createArticle({
      title: "Tool Strict",
      category: "context",
      content: "Body.",
    });
    if (!created.ok) throw new Error("seed failed");

    const res = await handleKnowledgeTool(
      "update_article",
      { id: created.value.id, sourcepath: "typo.md" },
      service,
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("VALIDATION_FAILED");
  });

  it("batch_update_articles applies add_tags per item (parity with update_article)", async () => {
    const service = knowledgeService();
    const created = await service.createArticle({
      title: "Batch Delta",
      category: "context",
      content: "Body.",
      tags: ["base"],
    });
    if (!created.ok) throw new Error("seed failed");

    const res = await handleKnowledgeTool(
      "batch_update_articles",
      { updates: [{ id: created.value.id, add_tags: ["extra"] }] },
      service,
    );

    expect(res.isError).toBeUndefined();
    const after = await service.getArticle(created.value.id);
    if (!after.ok) throw new Error("reread failed");
    expect(after.value.tags).toEqual(["base", "extra"]);
  });

  it("create_work seeds dependencies and blockedBy through the tool (regression pin)", async () => {
    const service = workService();
    const blocker = await handleWorkTool(
      "create_work",
      { title: "Blocker", template: "feature", priority: "medium", author: "agent-h4" },
      service,
    );
    expect(blocker.isError).toBeUndefined();
    const blockerId = parseBody(blocker).id as string;

    const res = await handleWorkTool(
      "create_work",
      {
        title: "Blocked",
        template: "feature",
        priority: "medium",
        author: "agent-h4",
        dependencies: [blockerId],
        blockedBy: [blockerId],
      },
      service,
    );

    expect(res.isError).toBeUndefined();
    const body = parseBody(res);
    expect(body.dependencies).toEqual([blockerId]);
    expect(body.blockedBy).toEqual([blockerId]);
  });

  it("update_work rejects a phase change instead of silently ignoring it", async () => {
    const service = workService();
    const created = await handleWorkTool(
      "create_work",
      { title: "Phase Guard", template: "feature", priority: "medium", author: "agent-h4" },
      service,
    );
    const id = parseBody(created).id as string;

    const res = await handleWorkTool("update_work", { id, phase: "done" }, service);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("VALIDATION_FAILED");
  });
});
