import { describe, it, expect, vi } from "vitest";
import { WorkService } from "../../../src/work/service.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import { ErrorCode } from "../../../src/core/errors.js";
import { createLogger } from "../../../src/core/logger.js";
import { WorkTemplate, Priority } from "../../../src/core/types.js";
import type { WikiBookkeeper } from "../../../src/knowledge/wiki-bookkeeper.js";

/**
 * H4 — input hygiene at the work service boundary.
 *
 * The write-path Zod schemas stripped unknown keys silently. The in-file
 * comment in CreateWorkArticleInputSchema records that this already bit
 * once (dependencies/blockedBy vanished until they were added to the
 * schema). The same trap stayed open for everything else: `phase`,
 * `createdAt`, or any typo silently no-op'd. Policy (H4): unknown keys are
 * rejected with an explicit ValidationError — never silence. Lifecycle
 * fields stay system-owned: phase moves only through advancePhase.
 */

function createService() {
  const workRepo = new InMemoryWorkArticleRepository();
  const orchestrationRepo = new InMemoryOrchestrationEventRepository();
  const logger = createLogger({ level: "warn", domain: "test" });
  const bookkeeper = {
    appendLog: vi.fn().mockResolvedValue(undefined),
    rebuildIndex: vi.fn().mockResolvedValue(undefined),
  } as unknown as WikiBookkeeper;
  const service = new WorkService({ workRepo, logger, orchestrationRepo, bookkeeper });
  return { service };
}

const validCreateInput = {
  title: "Hygiene Work",
  template: WorkTemplate.FEATURE,
  priority: Priority.MEDIUM,
  author: "agent-h4",
};

describe("work write-path rejects unknown keys (was: silently stripped)", () => {
  it("createWork rejects a caller-supplied phase with VALIDATION_FAILED", async () => {
    const { service } = createService();

    const result = await service.createWork({ ...validCreateInput, phase: "done" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("createWork rejects system-owned timestamps (createdAt) loudly", async () => {
    const { service } = createService();

    const result = await service.createWork({ ...validCreateInput, createdAt: "2020-01-01T00:00:00.000Z" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("updateWork rejects a caller-supplied phase with VALIDATION_FAILED", async () => {
    const { service } = createService();
    const created = await service.createWork(validCreateInput);
    if (!created.ok) throw new Error("seed failed");

    const result = await service.updateWork(created.value.id, { phase: "done" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("updateWork rejects an unknown key (typo) with VALIDATION_FAILED", async () => {
    const { service } = createService();
    const created = await service.createWork(validCreateInput);
    if (!created.ok) throw new Error("seed failed");

    const result = await service.updateWork(created.value.id, { asignee: "agent-typo" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});
