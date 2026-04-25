import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { FileSystemWorkArticleRepository } from "../../../src/work/file-repository.js";
import { computePlanningHash } from "../../../src/work/planning-hash.js";
import { Priority, WorkTemplate, WorkPhase, agentId } from "../../../src/core/types.js";

function createRepoRoot(): string {
  return `/tmp/monsthera-planning-hash-test-${randomUUID()}`;
}

const PLANNING_BODY = [
  "## Objective",
  "Ship the planning hash guard.",
  "",
  "## Planning",
  "Initial plan: write the field, hash on advance.",
  "",
  "## Acceptance Criteria",
  "- planningHash present after advance",
].join("\n");

describe("planningHash on advancePhase", () => {
  it("captures the hash on planning -> enrichment", async () => {
    const repo = new FileSystemWorkArticleRepository(createRepoRoot());
    const created = await repo.create({
      title: "Hash on advance",
      template: WorkTemplate.FEATURE,
      priority: Priority.MEDIUM,
      author: agentId("agent-1"),
      content: PLANNING_BODY,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.planningHash).toBeUndefined();

    const advanced = await repo.advancePhase(created.value.id, WorkPhase.ENRICHMENT);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.value.planningHash).toBe(computePlanningHash(PLANNING_BODY));
  });

  it("rejects rollback to planning at the state-machine layer (rollback path is documented-but-unreachable)", async () => {
    // The rollback-clears-hash branch in advancePhase is defensive: there
    // is no enrichment->planning edge in any current template, so the
    // structural transition check rejects the request before the hash
    // logic runs. Pinning that here documents the invariant — if a
    // future template adds rollback, the test should flip to assert the
    // hash clears, and the dead code in advancePhase becomes live.
    const repo = new FileSystemWorkArticleRepository(createRepoRoot());
    const created = await repo.create({
      title: "Rollback rejected",
      template: WorkTemplate.FEATURE,
      priority: Priority.MEDIUM,
      author: agentId("agent-1"),
      content: PLANNING_BODY,
    });
    if (!created.ok) throw new Error("create failed");

    const advanced = await repo.advancePhase(created.value.id, WorkPhase.ENRICHMENT);
    if (!advanced.ok) throw new Error("advance failed");

    const rolled = await repo.advancePhase(advanced.value.id, WorkPhase.PLANNING, {
      skipGuard: { reason: "test rollback" },
    });
    expect(rolled.ok).toBe(false);
  });

  it("preserves the hash across non-planning transitions", async () => {
    const repo = new FileSystemWorkArticleRepository(createRepoRoot());
    const created = await repo.create({
      title: "Hash preserved",
      template: WorkTemplate.FEATURE,
      priority: Priority.MEDIUM,
      author: agentId("agent-1"),
      content: [
        PLANNING_BODY,
        "",
        "## Implementation",
        "- Use real DB",
      ].join("\n"),
    });
    if (!created.ok) throw new Error("create failed");

    const enrichment = await repo.advancePhase(created.value.id, WorkPhase.ENRICHMENT);
    if (!enrichment.ok) throw new Error("advance failed");
    const expectedHash = enrichment.value.planningHash;
    expect(expectedHash).toBeDefined();

    // Force-advance to implementation by skipping the enrichment guard.
    const impl = await repo.advancePhase(enrichment.value.id, WorkPhase.IMPLEMENTATION, {
      skipGuard: { reason: "test" },
    });
    if (!impl.ok) throw new Error("advance to implementation failed");
    expect(impl.value.planningHash).toBe(expectedHash);
  });

  it("round-trips planningHash through filesystem persistence", async () => {
    const repoRoot = createRepoRoot();
    const repo = new FileSystemWorkArticleRepository(repoRoot);
    const created = await repo.create({
      title: "Round-trip",
      template: WorkTemplate.FEATURE,
      priority: Priority.MEDIUM,
      author: agentId("agent-1"),
      content: PLANNING_BODY,
    });
    if (!created.ok) throw new Error("create failed");

    const advanced = await repo.advancePhase(created.value.id, WorkPhase.ENRICHMENT);
    if (!advanced.ok) throw new Error("advance failed");
    const expectedHash = advanced.value.planningHash;

    // Re-read via a fresh repository instance to force a disk round-trip.
    const repo2 = new FileSystemWorkArticleRepository(repoRoot);
    const reread = await repo2.findById(advanced.value.id);
    if (!reread.ok) throw new Error("findById failed");
    expect(reread.value.planningHash).toBe(expectedHash);
  });
});
