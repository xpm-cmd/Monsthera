import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CodeIntelligenceService } from "../../../src/code-intelligence/service.js";
import { createLogger } from "../../../src/core/logger.js";
import { agentId, slug } from "../../../src/core/types.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { StructureService } from "../../../src/structure/service.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";

interface Harness {
  readonly repoPath: string;
  readonly knowledgeRepo: InMemoryKnowledgeArticleRepository;
  readonly workRepo: InMemoryWorkArticleRepository;
  readonly service: CodeIntelligenceService;
  readonly eventRepo: InMemoryOrchestrationEventRepository;
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop()!;
    await fs.rm(p, { recursive: true, force: true });
  }
});

async function makeHarness(options: { withEventRepo?: boolean } = {}): Promise<Harness> {
  const repoPath = path.join(tmpdir(), `monsthera-code-intel-${randomUUID()}`);
  await fs.mkdir(path.join(repoPath, "src", "auth"), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, "src", "auth", "session.ts"),
    "export const session = true;\n",
    "utf-8",
  );
  cleanupPaths.push(repoPath);

  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const logger = createLogger({ level: "error", domain: "test" });
  const structureService = new StructureService({ knowledgeRepo, workRepo, repoPath, logger });
  const eventRepo = new InMemoryOrchestrationEventRepository();
  const service = new CodeIntelligenceService({
    knowledgeRepo,
    workRepo,
    structureService,
    repoPath,
    logger,
    ...(options.withEventRepo === false ? {} : { eventRepo }),
  });

  return { repoPath, knowledgeRepo, workRepo, service, eventRepo };
}

describe("CodeIntelligenceService", () => {
  it("reports code ref owners, active work, policies, and risk", async () => {
    const { knowledgeRepo, workRepo, service } = await makeHarness();

    await knowledgeRepo.create({
      title: "Auth Architecture",
      slug: slug("auth-architecture"),
      category: "architecture",
      content: "Session handling notes.",
      codeRefs: ["src/auth/session.ts#L1"],
    });
    await knowledgeRepo.create({
      title: "Policy: auth requires security",
      slug: slug("policy-auth-requires-security"),
      category: "policy",
      content: "Applies to src/auth/session.ts and related session work.",
      codeRefs: ["src/auth"],
      tags: ["policy"],
    });
    await workRepo.create({
      title: "Improve session expiry",
      template: "feature",
      phase: "implementation",
      priority: "high",
      author: agentId("agent-1"),
      content: "## Objective\nImprove sessions\n\n## Acceptance Criteria\n- [ ] expiry\n\n## Context\nAuth\n\n## Scope\nSession\n\n## Implementation\nsrc/auth/session.ts",
      codeRefs: ["src/auth/session.ts"],
    });

    const result = await service.analyzeCodeRefImpact({ ref: "src/auth/session.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.ref.exists).toBe(true);
    expect(result.value.ref.summary.knowledgeCount).toBe(2);
    expect(result.value.ref.summary.workCount).toBe(1);
    expect(result.value.ref.summary.activeWorkCount).toBe(1);
    expect(result.value.ref.summary.policyCount).toBe(1);
    expect(result.value.risk).toBe("high");
    expect(result.value.reasons).toContain("active_work_linked");
    expect(result.value.reasons).toContain("policy_linked");
  });

  it("summarizes changed paths against existing code refs", async () => {
    const { knowledgeRepo, workRepo, service } = await makeHarness();

    await knowledgeRepo.create({
      title: "Auth Architecture",
      slug: slug("auth-architecture"),
      category: "architecture",
      content: "Session handling notes.",
      codeRefs: ["src/auth/session.ts"],
    });
    await workRepo.create({
      title: "Done auth cleanup",
      template: "refactor",
      phase: "done",
      priority: "low",
      author: agentId("agent-1"),
      content: "## Objective\nCleanup\n\n## Motivation\nSmall\n\n## Acceptance Criteria\n- [x] done",
      codeRefs: ["src/auth"],
    });

    const result = await service.detectChangedCodeRefs({
      changedPaths: ["src/auth/session.ts", "src/unknown.ts"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.changedPathCount).toBe(2);
    expect(result.value.summary.impactedOwnerCount).toBe(2);
    expect(result.value.summary.impactedActiveWorkCount).toBe(0);
    expect(result.value.summary.highestRisk).toBe("high");
    const normalizedPaths = result.value.impacts.map((impact) => impact.ref.normalizedPath);
    expect(normalizedPaths).toContain("src/auth/session.ts");
    expect(normalizedPaths).toContain("src/unknown.ts");
  });

  it("flags out-of-repo refs with .. traversal", async () => {
    const { service } = await makeHarness();

    const result = await service.getCodeRef({ ref: "../../etc/passwd" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outOfRepo).toBe(true);
    expect(result.value.exists).toBe(false);
  });

  it("flags absolute paths outside the repo as out-of-repo", async () => {
    const { service } = await makeHarness();

    const result = await service.getCodeRef({ ref: "/etc/passwd" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outOfRepo).toBe(true);
    expect(result.value.exists).toBe(false);
  });

  it("deduplicates changed paths after normalization", async () => {
    const { knowledgeRepo, service } = await makeHarness();
    await knowledgeRepo.create({
      title: "Auth notes",
      slug: slug("auth-notes"),
      category: "architecture",
      content: "Session handling notes.",
      codeRefs: ["src/auth/session.ts"],
    });

    const result = await service.detectChangedCodeRefs({
      changedPaths: [
        "src/auth/session.ts",
        "./src/auth/session.ts/",
        "src/auth/session.ts#L1",
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.changedPathCount).toBe(1);
    expect(result.value.impacts).toHaveLength(1);
  });

  it("preserves line anchor in CodeRefDetail.lineAnchor", async () => {
    const { service } = await makeHarness();

    const result = await service.getCodeRef({ ref: "src/auth/session.ts#L42" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.lineAnchor).toBe("#L42");
    expect(result.value.normalizedPath).toBe("src/auth/session.ts");
  });

  it("does not match src/auth as prefix of src/authentication", async () => {
    const { workRepo, service } = await makeHarness();

    await workRepo.create({
      title: "Auth refactor",
      template: "feature",
      phase: "planning",
      priority: "low",
      author: agentId("agent-1"),
      content: "## Objective\n\n## Acceptance Criteria\n- [ ] x",
      codeRefs: ["src/auth"],
    });

    const result = await service.findCodeOwners({ ref: "src/authentication" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.ownerCount).toBe(0);
  });

  it("does not match short targets in policy content", async () => {
    const { knowledgeRepo, service } = await makeHarness();

    await knowledgeRepo.create({
      title: "Policy: layout",
      slug: slug("policy-layout"),
      category: "policy",
      content: "Mentions src patterns frequently in src layout discussion.",
      codeRefs: [],
      tags: ["policy"],
    });

    const result = await service.findCodeOwners({ ref: "src" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.ownerCount).toBe(0);
  });

  it("filters done and cancelled work from activeWork", async () => {
    const { workRepo, service } = await makeHarness();

    await workRepo.create({
      title: "Closed work",
      template: "feature",
      phase: "done",
      priority: "low",
      author: agentId("agent-1"),
      content: "## Objective\n\n## Acceptance Criteria\n- [x] done",
      codeRefs: ["src/auth/session.ts"],
    });
    await workRepo.create({
      title: "Cancelled work",
      template: "feature",
      phase: "cancelled",
      priority: "low",
      author: agentId("agent-1"),
      content: "## Objective\n\n## Acceptance Criteria\n- [ ] never",
      codeRefs: ["src/auth/session.ts"],
    });

    const result = await service.getCodeRef({ ref: "src/auth/session.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.workCount).toBe(2);
    expect(result.value.summary.activeWorkCount).toBe(0);
    expect(result.value.activeWork).toHaveLength(0);
  });

  it("returns risk: none for existing files without code refs", async () => {
    const { service } = await makeHarness();

    const result = await service.analyzeCodeRefImpact({ ref: "src/auth/session.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.ref.exists).toBe(true);
    expect(result.value.ref.summary.ownerCount).toBe(0);
    expect(result.value.risk).toBe("none");
    expect(result.value.reasons).toContain("no_monsthera_context");
  });

  it("findCodeOwners returns owners-only payload without risk or stat", async () => {
    const { knowledgeRepo, service } = await makeHarness();

    await knowledgeRepo.create({
      title: "Auth notes",
      slug: slug("auth-notes"),
      category: "architecture",
      content: "Session handling notes.",
      codeRefs: ["src/auth/session.ts"],
    });

    const result = await service.findCodeOwners({ ref: "src/auth/session.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.ownerCount).toBe(1);
    expect(result.value.summary.knowledgeCount).toBe(1);
    expect(result.value.summary.workCount).toBe(0);
    expect(result.value.normalizedPath).toBe("src/auth/session.ts");
    // CodeRefOwners must not carry stat or risk fields.
    expect(result.value).not.toHaveProperty("exists");
    expect(result.value).not.toHaveProperty("risk");
    expect(result.value).not.toHaveProperty("recommendedNextActions");
  });

  it("findCodeOwners returns an empty list when no article links to the ref", async () => {
    const { service } = await makeHarness();

    const result = await service.findCodeOwners({ ref: "src/never/touched.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.ownerCount).toBe(0);
    expect(result.value.owners).toEqual([]);
  });

  // ─── code_high_risk_detected event emission (ADR-015 M2 → M5 hook) ────────

  describe("code_high_risk_detected event emission", () => {
    it("emits one event per active work article when analyzeCodeRefImpact is high-risk", async () => {
      const { knowledgeRepo, workRepo, service, eventRepo } = await makeHarness();
      // policy + work-in-implementation → riskFor returns "high" via both paths
      await knowledgeRepo.create({
        title: "Policy: auth requires security",
        slug: slug("policy-auth-requires-security"),
        category: "policy",
        content: "Applies to src/auth and related session work.",
        codeRefs: ["src/auth"],
        tags: ["policy"],
      });
      const workCreate = await workRepo.create({
        title: "Improve session expiry",
        template: "feature",
        phase: "implementation",
        priority: "high",
        author: agentId("agent-1"),
        content: "## Objective\nx\n\n## Acceptance Criteria\n- [ ] x\n\n## Implementation\nsrc/auth/session.ts",
        codeRefs: ["src/auth/session.ts"],
      });
      expect(workCreate.ok).toBe(true);
      if (!workCreate.ok) return;

      const result = await service.analyzeCodeRefImpact({ ref: "src/auth/session.ts" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.risk).toBe("high");

      const events = await eventRepo.findByType("code_high_risk_detected");
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      expect(events.value).toHaveLength(1);
      expect(events.value[0]!.workId).toBe(workCreate.value.id);
      const details = events.value[0]!.details as Record<string, unknown>;
      expect(details.normalizedPath).toBe("src/auth/session.ts");
      expect(details.source).toBe("analyze_impact");
      expect(details.reasons).toEqual(expect.arrayContaining(["active_work_linked", "policy_linked"]));
    });

    it("does not emit when risk is below high (low/medium)", async () => {
      const { workRepo, service, eventRepo } = await makeHarness();
      // Active work in `planning` → risk=medium per riskFor (active_work_linked
      // without implementation/review escalation, no policy, file exists).
      await workRepo.create({
        title: "Plan session expiry",
        template: "feature",
        phase: "planning",
        priority: "low",
        author: agentId("agent-1"),
        content: "## Objective\nx\n\n## Acceptance Criteria\n- [ ] x",
        codeRefs: ["src/auth/session.ts"],
      });

      const result = await service.analyzeCodeRefImpact({ ref: "src/auth/session.ts" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.risk).toBe("medium");

      const events = await eventRepo.findByType("code_high_risk_detected");
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      expect(events.value).toHaveLength(0);
    });

    it("does not emit when risk is high but no active work is linked", async () => {
      const { knowledgeRepo, service, eventRepo } = await makeHarness();
      // policy linked → risk=high, but no work article → activeWork is empty.
      // The high-risk signal still surfaces in the response payload for
      // human/agent consumption; we just have no workId to address an
      // orchestration event to.
      await knowledgeRepo.create({
        title: "Policy: auth requires security",
        slug: slug("policy-auth-requires-security"),
        category: "policy",
        content: "Applies to src/auth/session.ts.",
        codeRefs: ["src/auth/session.ts"],
        tags: ["policy"],
      });

      const result = await service.analyzeCodeRefImpact({ ref: "src/auth/session.ts" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.risk).toBe("high");
      expect(result.value.ref.activeWork).toHaveLength(0);

      const events = await eventRepo.findByType("code_high_risk_detected");
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      expect(events.value).toHaveLength(0);
    });

    it("deduplicates by (workId, normalizedPath) within one detectChangedCodeRefs call", async () => {
      const { workRepo, service, eventRepo } = await makeHarness();
      // Single work article in `implementation` linked to a directory.
      // detectChangedCodeRefs gets two paths under that directory; without
      // dedup we'd emit (W, src/auth) twice (once per matched path). With
      // dedup keyed by (workId, normalizedPath) we emit one event per path
      // (because the paths normalize differently) — but only ONE per path,
      // not multiplied by the number of owners-per-path.
      const work = await workRepo.create({
        title: "Auth refactor",
        template: "feature",
        phase: "implementation",
        priority: "high",
        author: agentId("agent-1"),
        content: "## Objective\nx\n\n## Acceptance Criteria\n- [ ] x\n\n## Implementation\nsrc/auth",
        codeRefs: ["src/auth"],
      });
      expect(work.ok).toBe(true);
      if (!work.ok) return;

      const result = await service.detectChangedCodeRefs({
        // Same logical change repeated twice via different normalisations —
        // first dedups inside detectChangedCodeRefs (uniquePaths), then the
        // event-level dedup makes sure even if it slipped through, no
        // duplicate event lands.
        changedPaths: ["src/auth/session.ts", "./src/auth/session.ts/", "src/auth/middleware.ts"],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const events = await eventRepo.findByType("code_high_risk_detected");
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      // Two distinct normalized paths → two events for the same workId.
      expect(events.value).toHaveLength(2);
      const paths = events.value.map((e) => (e.details as Record<string, unknown>).normalizedPath).sort();
      expect(paths).toEqual(["src/auth/middleware.ts", "src/auth/session.ts"]);
      expect(events.value.every((e) => e.workId === work.value.id)).toBe(true);
      expect(events.value.every((e) => (e.details as Record<string, unknown>).source === "detect_changes")).toBe(true);
    });

    it("skips emission entirely when no eventRepo is wired (graceful degradation)", async () => {
      const { knowledgeRepo, workRepo, service } = await makeHarness({ withEventRepo: false });
      // High-risk setup, but service was built without eventRepo. The
      // analyze should still succeed; we just have no observable side-effect
      // to assert on, so we only assert the response payload.
      await knowledgeRepo.create({
        title: "Policy: auth",
        slug: slug("policy-auth-deg"),
        category: "policy",
        content: "Applies to src/auth/session.ts.",
        codeRefs: ["src/auth/session.ts"],
        tags: ["policy"],
      });
      await workRepo.create({
        title: "Auth work",
        template: "feature",
        phase: "implementation",
        priority: "high",
        author: agentId("agent-1"),
        content: "## Objective\nx\n\n## Acceptance Criteria\n- [ ] x\n\n## Implementation\nsrc/auth/session.ts",
        codeRefs: ["src/auth/session.ts"],
      });

      const result = await service.analyzeCodeRefImpact({ ref: "src/auth/session.ts" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.risk).toBe("high");
      // No throw, no failure — graceful degradation contract holds.
    });
  });
});
