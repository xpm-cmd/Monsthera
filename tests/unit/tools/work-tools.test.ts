import { describe, it, expect, beforeEach } from "vitest";
import {
  workToolDefinitions,
  handleWorkTool,
} from "../../../src/tools/work-tools.js";
import { WorkService } from "../../../src/work/service.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { WorkTemplate, Priority, WorkPhase } from "../../../src/core/types.js";
import type { WorkArticle } from "../../../src/work/repository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createService(): WorkService {
  return new WorkService({
    workRepo: new InMemoryWorkArticleRepository(),
    logger: createLogger({ level: "warn", domain: "test" }),
  });
}

const validInput = {
  title: "Test Work Article",
  template: WorkTemplate.FEATURE,
  priority: Priority.MEDIUM,
  author: "agent-123",
};

async function seedWork(
  service: WorkService,
  overrides?: Record<string, unknown>,
): Promise<WorkArticle> {
  const result = await service.createWork({ ...validInput, ...overrides });
  if (!result.ok) throw new Error(`seed failed: ${result.error.message}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// workToolDefinitions
// ---------------------------------------------------------------------------

describe("workToolDefinitions", () => {
  it("returns exactly 11 tools", () => {
    const defs = workToolDefinitions();
    expect(defs).toHaveLength(11);
  });

  it("each tool has name, description, and inputSchema", () => {
    const defs = workToolDefinitions();
    for (const def of defs) {
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe("object");
      expect(typeof def.inputSchema.properties).toBe("object");
    }
  });

  it("tool names match the expected set", () => {
    const names = workToolDefinitions().map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "create_work",
        "get_work",
        "update_work",
        "delete_work",
        "list_work",
        "advance_phase",
        "contribute_enrichment",
        "assign_reviewer",
        "submit_review",
        "add_dependency",
        "remove_dependency",
      ]),
    );
  });

  it("descriptions reflect automatic search sync", () => {
    const defs = workToolDefinitions();
    expect(defs.find((def) => def.name === "create_work")?.description).toContain("Search sync happens automatically");
    expect(defs.find((def) => def.name === "create_work")?.description).toContain("handoff contract");
    expect(defs.find((def) => def.name === "advance_phase")?.description).toContain("guards pass");
    expect(defs.find((def) => def.name === "update_work")?.description).toContain("manual reindex is not needed");
    expect(defs.find((def) => def.name === "delete_work")?.description).toContain("manual remove_from_index");
  });
});

// ---------------------------------------------------------------------------
// create_work
// ---------------------------------------------------------------------------

describe("create_work", () => {
  let service: WorkService;

  beforeEach(() => {
    service = createService();
  });

  it("returns JSON work article on success", async () => {
    const response = await handleWorkTool("create_work", validInput, service);
    expect(response.isError).toBeUndefined();
    expect(response.content).toHaveLength(1);
    expect(response.content[0]!.type).toBe("text");
    const article = JSON.parse(response.content[0]!.text) as WorkArticle;
    expect(article.title).toBe(validInput.title);
    expect(article.template).toBe(validInput.template);
    expect(article.id).toBeTruthy();
    expect(article.phase).toBe(WorkPhase.PLANNING);
  });

  it("returns isError: true on validation failure (missing required fields)", async () => {
    const { title: _t, ...withoutTitle } = validInput;
    const response = await handleWorkTool("create_work", withoutTitle, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("VALIDATION_FAILED");
    expect(typeof body.message).toBe("string");
  });

  it("returns isError: true for invalid template value", async () => {
    const response = await handleWorkTool("create_work", { ...validInput, template: "bad-template" }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("accepts and persists assignee, references, and codeRefs at creation time", async () => {
    const response = await handleWorkTool(
      "create_work",
      {
        ...validInput,
        assignee: "agent-builder",
        references: ["architecture-overview", "k-abc123"],
        codeRefs: ["src/dashboard/index.ts", "src/tools/work-tools.ts"],
      },
      service,
    );
    expect(response.isError).toBeUndefined();
    const article = JSON.parse(response.content[0]!.text) as WorkArticle;
    expect(article.assignee).toBe("agent-builder");
    expect(article.references).toEqual(["architecture-overview", "k-abc123"]);
    expect(article.codeRefs).toEqual(["src/dashboard/index.ts", "src/tools/work-tools.ts"]);
  });

  it("exposes assignee, references, and codeRefs in the create_work input schema", () => {
    const defs = workToolDefinitions();
    const createWork = defs.find((d) => d.name === "create_work");
    expect(createWork).toBeDefined();
    const props = createWork!.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("assignee");
    expect(props).toHaveProperty("references");
    expect(props).toHaveProperty("codeRefs");
  });
});

// ---------------------------------------------------------------------------
// get_work
// ---------------------------------------------------------------------------

describe("get_work", () => {
  let service: WorkService;

  beforeEach(() => {
    service = createService();
  });

  it("returns article by id", async () => {
    const article = await seedWork(service);
    const response = await handleWorkTool("get_work", { id: article.id }, service);
    expect(response.isError).toBeUndefined();
    const fetched = JSON.parse(response.content[0]!.text) as WorkArticle;
    expect(fetched.id).toBe(article.id);
    expect(fetched.title).toBe(article.title);
  });

  it("returns NOT_FOUND error for unknown id", async () => {
    const response = await handleWorkTool("get_work", { id: "ghost-id" }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("returns VALIDATION_FAILED when id is missing", async () => {
    const response = await handleWorkTool("get_work", {}, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// update_work
// ---------------------------------------------------------------------------

describe("update_work", () => {
  let service: WorkService;

  beforeEach(() => {
    service = createService();
  });

  it("returns updated article on success", async () => {
    const article = await seedWork(service);
    const response = await handleWorkTool(
      "update_work",
      { id: article.id, title: "Updated Title" },
      service,
    );
    expect(response.isError).toBeUndefined();
    const updated = JSON.parse(response.content[0]!.text) as WorkArticle;
    expect(updated.title).toBe("Updated Title");
    expect(updated.priority).toBe(article.priority);
  });

  it("returns NOT_FOUND error for unknown id", async () => {
    const response = await handleWorkTool(
      "update_work",
      { id: "nonexistent", title: "New Title" },
      service,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("returns VALIDATION_FAILED when id is missing", async () => {
    const response = await handleWorkTool("update_work", { title: "New" }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// delete_work
// ---------------------------------------------------------------------------

describe("delete_work", () => {
  let service: WorkService;

  beforeEach(() => {
    service = createService();
  });

  it("returns { deleted: true } on success", async () => {
    const article = await seedWork(service);
    const response = await handleWorkTool("delete_work", { id: article.id }, service);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it("returns NOT_FOUND error for unknown id", async () => {
    const response = await handleWorkTool("delete_work", { id: "ghost-id" }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// list_work
// ---------------------------------------------------------------------------

describe("list_work", () => {
  let service: WorkService;

  beforeEach(async () => {
    service = createService();
    await seedWork(service, { title: "A" });
    await seedWork(service, { title: "B" });
    await seedWork(service, { title: "C" });
  });

  it("returns all work articles when no phase provided", async () => {
    const response = await handleWorkTool("list_work", {}, service);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { total: number; items: { id: string; title: string; phase: string }[] };
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
  });

  it("filters by phase when provided", async () => {
    // All seeded articles are in PLANNING phase
    const response = await handleWorkTool("list_work", { phase: WorkPhase.PLANNING }, service);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { total: number; items: { id: string; title: string; phase: string }[] };
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items.every((a) => a.phase === WorkPhase.PLANNING)).toBe(true);
  });

  it("returns empty list for a phase with no articles", async () => {
    const response = await handleWorkTool("list_work", { phase: WorkPhase.DONE }, service);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { total: number; items: unknown[] };
    expect(body.total).toBe(0);
    expect(body.items).toEqual([]);
  });

  it("respects limit and offset", async () => {
    const response = await handleWorkTool("list_work", { limit: 2, offset: 1 }, service);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { total: number; limit: number; offset: number; items: unknown[] };
    expect(body.total).toBe(3);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.items).toHaveLength(2);
  });

  it("returns VALIDATION_FAILED for invalid phase string", async () => {
    const response = await handleWorkTool("list_work", { phase: "not-a-phase" }, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// advance_phase
// ---------------------------------------------------------------------------

describe("advance_phase", () => {
  let service: WorkService;

  beforeEach(() => {
    service = createService();
  });

  it("succeeds for a valid transition with guards met", async () => {
    const contentWithGuards = "## Objective\nDo the thing.\n\n## Acceptance Criteria\n- [ ] Works.";
    const article = await seedWork(service, { content: contentWithGuards });

    const response = await handleWorkTool(
      "advance_phase",
      { id: article.id, targetPhase: WorkPhase.ENRICHMENT },
      service,
    );
    expect(response.isError).toBeUndefined();
    const updated = JSON.parse(response.content[0]!.text) as WorkArticle;
    expect(updated.phase).toBe(WorkPhase.ENRICHMENT);
  });

  it("returns VALIDATION_FAILED for an invalid phase string", async () => {
    const article = await seedWork(service);
    const response = await handleWorkTool(
      "advance_phase",
      { id: article.id, targetPhase: "not-a-phase" },
      service,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("returns error when guard fails (missing required content sections)", async () => {
    // Article without ## Objective or ## Acceptance Criteria
    const article = await seedWork(service, { content: "Just a plain description." });
    const response = await handleWorkTool(
      "advance_phase",
      { id: article.id, targetPhase: WorkPhase.ENRICHMENT },
      service,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(["GUARD_FAILED", "STATE_TRANSITION_INVALID"]).toContain(body.error);
  });

  it("returns VALIDATION_FAILED when id is missing", async () => {
    const response = await handleWorkTool(
      "advance_phase",
      { targetPhase: WorkPhase.ENRICHMENT },
      service,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  // ─── Tier 2.1 ───

  it("cancellation without reason returns VALIDATION_FAILED (Tier 2.1)", async () => {
    const article = await seedWork(service);
    const response = await handleWorkTool(
      "advance_phase",
      { id: article.id, targetPhase: WorkPhase.CANCELLED },
      service,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("VALIDATION_FAILED");
    expect(body.message.toLowerCase()).toContain("reason");
  });

  it("cancellation with reason succeeds and records it in phase history (Tier 2.1)", async () => {
    const article = await seedWork(service);
    const response = await handleWorkTool(
      "advance_phase",
      { id: article.id, targetPhase: WorkPhase.CANCELLED, reason: "superseded by w-other" },
      service,
    );
    expect(response.isError).toBeUndefined();
    const updated = JSON.parse(response.content[0]!.text) as WorkArticle;
    expect(updated.phase).toBe(WorkPhase.CANCELLED);
    const latest = updated.phaseHistory.at(-1);
    expect(latest?.reason).toBe("superseded by w-other");
  });

  it("skip_guard threads to service, bypasses failing guard, records entry (Tier 2.1)", async () => {
    // Build a feature article stuck in implementation without '## Implementation'
    const article = await seedWork(service, {
      content: "## Objective\nDo thing.\n\n## Acceptance Criteria\n- Works.",
    });
    await handleWorkTool("advance_phase", { id: article.id, targetPhase: WorkPhase.ENRICHMENT }, service);
    await handleWorkTool("contribute_enrichment", { id: article.id, role: "architecture", status: "contributed" }, service);
    await handleWorkTool("advance_phase", { id: article.id, targetPhase: WorkPhase.IMPLEMENTATION }, service);

    const response = await handleWorkTool(
      "advance_phase",
      {
        id: article.id,
        targetPhase: WorkPhase.REVIEW,
        skip_guard: { reason: "docs-only feature, no implementation section" },
      },
      service,
    );
    expect(response.isError).toBeUndefined();
    const updated = JSON.parse(response.content[0]!.text) as WorkArticle;
    expect(updated.phase).toBe(WorkPhase.REVIEW);
    const latest = updated.phaseHistory.at(-1);
    expect(latest?.skippedGuards).toEqual(["implementation_linked"]);
    expect(latest?.reason).toBe("docs-only feature, no implementation section");
  });

  it("skip_guard rejects unknown keys (strict) (Tier 2.1)", async () => {
    const article = await seedWork(service);
    const response = await handleWorkTool(
      "advance_phase",
      {
        id: article.id,
        targetPhase: WorkPhase.ENRICHMENT,
        skip_guard: { reason: "hm", extraneous: "field" },
      },
      service,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("skip_guard requires a non-empty reason (Tier 2.1)", async () => {
    const article = await seedWork(service);
    const response = await handleWorkTool(
      "advance_phase",
      { id: article.id, targetPhase: WorkPhase.ENRICHMENT, skip_guard: { reason: "" } },
      service,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// contribute_enrichment
// ---------------------------------------------------------------------------

describe("contribute_enrichment", () => {
  it("records enrichment contribution", async () => {
    const service = createService();
    const create = await handleWorkTool("create_work", {
      title: "Test", template: "feature", priority: "medium", author: "agent-1",
      content: "## Objective\n\nDo it\n\n## Acceptance Criteria\n\n- Done",
    }, service);
    const article = JSON.parse(create.content[0]!.text) as WorkArticle;
    // Advance to enrichment phase before contributing
    await handleWorkTool("advance_phase", { id: article.id, targetPhase: WorkPhase.ENRICHMENT }, service);
    const result = await handleWorkTool("contribute_enrichment", {
      id: article.id, role: "architecture", status: "contributed",
    }, service);
    expect(result.isError).toBeUndefined();
  });

  it("rejects invalid enrichment status", async () => {
    const service = createService();
    const create = await handleWorkTool("create_work", {
      title: "Test", template: "feature", priority: "medium", author: "agent-1",
      content: "## Objective\n\nDo it\n\n## Acceptance Criteria\n\n- Done",
    }, service);
    const article = JSON.parse(create.content[0]!.text) as WorkArticle;
    // Advance to enrichment phase before contributing
    await handleWorkTool("advance_phase", { id: article.id, targetPhase: WorkPhase.ENRICHMENT }, service);
    const result = await handleWorkTool("contribute_enrichment", {
      id: article.id, role: "architecture", status: "invalid",
    }, service);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assign_reviewer
// ---------------------------------------------------------------------------

describe("assign_reviewer", () => {
  it("assigns a reviewer", async () => {
    const service = createService();
    const create = await handleWorkTool("create_work", {
      title: "Test", template: "feature", priority: "medium", author: "agent-1",
    }, service);
    const article = JSON.parse(create.content[0]!.text) as WorkArticle;
    const result = await handleWorkTool("assign_reviewer", {
      id: article.id, agentId: "reviewer-1",
    }, service);
    expect(result.isError).toBeUndefined();
    const updated = JSON.parse(result.content[0]!.text) as WorkArticle;
    expect(updated.reviewers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// submit_review
// ---------------------------------------------------------------------------

describe("submit_review", () => {
  async function advanceToReview(service: WorkService, id: string): Promise<void> {
    // Tier 2.1: spike skips implementation + review. Use feature flow with a
    // contributed enrichment role to drive the article to review phase.
    await handleWorkTool("advance_phase", { id, targetPhase: WorkPhase.ENRICHMENT }, service);
    await handleWorkTool("contribute_enrichment", { id, role: "architecture", status: "contributed" }, service);
    await handleWorkTool("advance_phase", { id, targetPhase: WorkPhase.IMPLEMENTATION }, service);
    await handleWorkTool("update_work", {
      id,
      content: "## Objective\n\nShip it\n\n## Acceptance Criteria\n\n- Works\n\n## Implementation\n\nPR #1",
    }, service);
    await handleWorkTool("advance_phase", { id, targetPhase: WorkPhase.REVIEW }, service);
    await handleWorkTool("assign_reviewer", { id, agentId: "reviewer-1" }, service);
  }

  it("records review outcome", async () => {
    const service = createService();
    const create = await handleWorkTool("create_work", {
      title: "Test", template: WorkTemplate.FEATURE, priority: "medium", author: "agent-1",
      content: "## Objective\n\nShip it\n\n## Acceptance Criteria\n\n- Works",
    }, service);
    const article = JSON.parse(create.content[0]!.text) as WorkArticle;
    const id = article.id;
    await advanceToReview(service, id);
    const result = await handleWorkTool("submit_review", {
      id, agentId: "reviewer-1", status: "approved",
    }, service);
    expect(result.isError).toBeUndefined();
  });

  it("rejects invalid review status", async () => {
    const service = createService();
    const create = await handleWorkTool("create_work", {
      title: "Test", template: WorkTemplate.FEATURE, priority: "medium", author: "agent-1",
      content: "## Objective\n\nShip it\n\n## Acceptance Criteria\n\n- Works",
    }, service);
    const article = JSON.parse(create.content[0]!.text) as WorkArticle;
    const id = article.id;
    await advanceToReview(service, id);
    const result = await handleWorkTool("submit_review", {
      id, agentId: "reviewer-1", status: "invalid",
    }, service);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// add_dependency
// ---------------------------------------------------------------------------

describe("add_dependency", () => {
  it("adds a dependency", async () => {
    const service = createService();
    const a = await handleWorkTool("create_work", {
      title: "A", template: "feature", priority: "medium", author: "agent-1",
    }, service);
    const b = await handleWorkTool("create_work", {
      title: "B", template: "feature", priority: "medium", author: "agent-1",
    }, service);
    const articleA = JSON.parse(a.content[0]!.text) as WorkArticle;
    const articleB = JSON.parse(b.content[0]!.text) as WorkArticle;
    const result = await handleWorkTool("add_dependency", {
      id: articleA.id, blockedById: articleB.id,
    }, service);
    expect(result.isError).toBeUndefined();
    const updated = JSON.parse(result.content[0]!.text) as WorkArticle;
    expect(updated.blockedBy).toContain(articleB.id);
  });
});

// ---------------------------------------------------------------------------
// remove_dependency
// ---------------------------------------------------------------------------

describe("remove_dependency", () => {
  it("removes a dependency", async () => {
    const service = createService();
    const a = await handleWorkTool("create_work", {
      title: "A", template: "feature", priority: "medium", author: "agent-1",
    }, service);
    const b = await handleWorkTool("create_work", {
      title: "B", template: "feature", priority: "medium", author: "agent-1",
    }, service);
    const articleA = JSON.parse(a.content[0]!.text) as WorkArticle;
    const articleB = JSON.parse(b.content[0]!.text) as WorkArticle;
    await handleWorkTool("add_dependency", { id: articleA.id, blockedById: articleB.id }, service);
    const result = await handleWorkTool("remove_dependency", {
      id: articleA.id, blockedById: articleB.id,
    }, service);
    expect(result.isError).toBeUndefined();
    const updated = JSON.parse(result.content[0]!.text) as WorkArticle;
    expect(updated.blockedBy).not.toContain(articleB.id);
  });
});

// ---------------------------------------------------------------------------
// unknown tool
// ---------------------------------------------------------------------------

describe("unknown tool", () => {
  it("returns NOT_FOUND error for an unrecognized tool name", async () => {
    const service = createService();
    const response = await handleWorkTool("does_not_exist", {}, service);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toContain("does_not_exist");
  });
});

// ---------------------------------------------------------------------------
// Response format contracts
// ---------------------------------------------------------------------------

describe("response format", () => {
  let service: WorkService;

  beforeEach(() => {
    service = createService();
  });

  it("success response has content array with type: text", async () => {
    const response = await handleWorkTool("create_work", validInput, service);
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content[0]!.type).toBe("text");
    expect(typeof response.content[0]!.text).toBe("string");
    expect(response.isError).toBeUndefined();
  });

  it("error response has isError: true and JSON body with error + message", async () => {
    const response = await handleWorkTool("get_work", { id: "missing" }, service);
    expect(response.isError).toBe(true);
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content[0]!.type).toBe("text");
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
  });
});
