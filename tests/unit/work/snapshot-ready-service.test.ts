import { describe, it, expect } from "vitest";
import { WorkService } from "../../../src/work/service.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemorySnapshotRepository } from "../../../src/context/snapshot-in-memory-repository.js";
import { SnapshotService } from "../../../src/context/snapshot-service.js";
import { createLogger } from "../../../src/core/logger.js";
import { WorkPhase, WorkTemplate, Priority } from "../../../src/core/types.js";
import { ErrorCode } from "../../../src/core/errors.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

interface Harness {
  service: WorkService;
  snapshotService: SnapshotService;
  repoPath: string;
  cleanup(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-guard-"));
  const logger = createLogger({ level: "warn", domain: "test" });
  const snapshotRepo = new InMemorySnapshotRepository();
  const snapshotService = new SnapshotService({
    repo: snapshotRepo,
    logger,
    maxAgeMinutes: 30,
  });
  const workRepo = new InMemoryWorkArticleRepository();
  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const service = new WorkService({
    workRepo,
    logger,
    snapshotService,
    repoPath,
  });
  service.setKnowledgeRepo(knowledgeRepo);
  return {
    service,
    snapshotService,
    repoPath,
    cleanup: async () => {
      await fs.rm(repoPath, { recursive: true, force: true });
    },
  };
}

async function seedLockfile(repoPath: string, name: string, body: string): Promise<string> {
  await fs.writeFile(path.join(repoPath, name), body);
  return createHash("sha256").update(body).digest("hex");
}

async function advanceToEnrichment(
  h: Harness,
  template: WorkTemplate,
): Promise<string> {
  const create = await h.service.createWork({
    title: `Snapshot gate on ${template}`,
    template,
    priority: Priority.MEDIUM,
    author: "agent-1",
    content:
      "## Objective\n\nShip.\n\n## Acceptance Criteria\n\n- [ ] X\n\n## Steps to Reproduce\n\nN/A.\n\n## Motivation\n\nBecause.\n\n## Research Questions\n\nNone.\n",
  });
  if (!create.ok) throw new Error(`create failed: ${create.error.message}`);
  const adv = await h.service.advancePhase(create.value.id, WorkPhase.ENRICHMENT);
  if (!adv.ok) throw new Error(`advance to enrichment failed: ${adv.error.message}`);
  // Contribute to the template's only required enrichment role.
  const role = create.value.enrichmentRoles[0]?.role;
  if (role) {
    const contrib = await h.service.contributeEnrichment(create.value.id, role, "contributed");
    if (!contrib.ok) throw new Error(`contribute failed: ${contrib.error.message}`);
  }
  return create.value.id;
}

describe("snapshot_ready — end-to-end through WorkService.advancePhase", () => {
  it("blocks a feature advance when no snapshot exists", async () => {
    const h = await makeHarness();
    try {
      const id = await advanceToEnrichment(h, WorkTemplate.FEATURE);
      const result = await h.service.advancePhase(id, WorkPhase.IMPLEMENTATION);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.GUARD_FAILED);
        expect(result.error.message).toContain("snapshot_ready");
      }
    } finally {
      await h.cleanup();
    }
  });

  it("blocks a feature advance when HEAD lockfile hash drifts from the snapshot", async () => {
    const h = await makeHarness();
    try {
      const id = await advanceToEnrichment(h, WorkTemplate.FEATURE);
      await seedLockfile(h.repoPath, "pnpm-lock.yaml", "current-contents");
      const recorded = await h.snapshotService.record({
        agentId: "agent-1",
        workId: id,
        cwd: h.repoPath,
        files: [],
        runtimes: {},
        packageManagers: [],
        lockfiles: [{ path: "pnpm-lock.yaml", sha256: "stale-hash" }],
      });
      if (!recorded.ok) throw new Error("record failed");
      const result = await h.service.advancePhase(id, WorkPhase.IMPLEMENTATION);
      expect(result.ok).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("passes a feature advance when snapshot is fresh and HEAD hashes match", async () => {
    const h = await makeHarness();
    try {
      const id = await advanceToEnrichment(h, WorkTemplate.FEATURE);
      const sha = await seedLockfile(h.repoPath, "pnpm-lock.yaml", "locked-in-stone");
      const recorded = await h.snapshotService.record({
        agentId: "agent-1",
        workId: id,
        cwd: h.repoPath,
        files: [],
        runtimes: {},
        packageManagers: [],
        lockfiles: [{ path: "pnpm-lock.yaml", sha256: sha }],
      });
      if (!recorded.ok) throw new Error("record failed");
      const result = await h.service.advancePhase(id, WorkPhase.IMPLEMENTATION);
      expect(result.ok).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it("skipGuard bypasses a failing guard and records it on the phase history", async () => {
    const h = await makeHarness();
    try {
      const id = await advanceToEnrichment(h, WorkTemplate.FEATURE);
      const result = await h.service.advancePhase(id, WorkPhase.IMPLEMENTATION, {
        skipGuard: { reason: "running without a captured sandbox" },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const lastEntry = result.value.phaseHistory.at(-1);
        expect(lastEntry?.skippedGuards).toEqual(["snapshot_ready"]);
        expect(lastEntry?.reason).toBe("running without a captured sandbox");
      }
    } finally {
      await h.cleanup();
    }
  });

  it("does not gate bugfix articles (backwards compat)", async () => {
    const h = await makeHarness();
    try {
      const id = await advanceToEnrichment(h, WorkTemplate.BUGFIX);
      const result = await h.service.advancePhase(id, WorkPhase.IMPLEMENTATION);
      expect(result.ok).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it("does not gate refactor articles (backwards compat)", async () => {
    const h = await makeHarness();
    try {
      const id = await advanceToEnrichment(h, WorkTemplate.REFACTOR);
      const result = await h.service.advancePhase(id, WorkPhase.IMPLEMENTATION);
      expect(result.ok).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});
