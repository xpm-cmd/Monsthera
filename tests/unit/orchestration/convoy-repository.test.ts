import { describe, expect, it } from "vitest";
import { workId } from "../../../src/core/types.js";
import { AlreadyExistsError } from "../../../src/core/errors.js";
import { InMemoryConvoyRepository } from "../../../src/orchestration/in-memory-convoy-repository.js";

describe("InMemoryConvoyRepository", () => {
  function repo() {
    return new InMemoryConvoyRepository();
  }

  describe("create", () => {
    it("creates a convoy with default targetPhase=implementation and active status", async () => {
      const r = repo();
      const result = await r.create({
        leadWorkId: workId("w-lead"),
        memberWorkIds: [workId("w-a"), workId("w-b")],
        goal: "Ship the convoy feature",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("active");
      expect(result.value.targetPhase).toBe("implementation");
      expect(result.value.memberWorkIds).toEqual([workId("w-a"), workId("w-b")]);
      expect(result.value.id.startsWith("cv-")).toBe(true);
    });

    it("rejects empty goal", async () => {
      const r = repo();
      const result = await r.create({
        leadWorkId: workId("w-lead"),
        memberWorkIds: [workId("w-a")],
        goal: "   ",
      });
      expect(result.ok).toBe(false);
    });

    it("rejects empty member list", async () => {
      const r = repo();
      const result = await r.create({
        leadWorkId: workId("w-lead"),
        memberWorkIds: [],
        goal: "x",
      });
      expect(result.ok).toBe(false);
    });

    it("rejects lead appearing in members", async () => {
      const r = repo();
      const result = await r.create({
        leadWorkId: workId("w-lead"),
        memberWorkIds: [workId("w-lead"), workId("w-a")],
        goal: "x",
      });
      expect(result.ok).toBe(false);
    });

    it("dedupes member ids", async () => {
      const r = repo();
      const result = await r.create({
        leadWorkId: workId("w-lead"),
        memberWorkIds: [workId("w-a"), workId("w-a"), workId("w-b")],
        goal: "x",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.memberWorkIds).toEqual([workId("w-a"), workId("w-b")]);
    });

    it("rejects creation when a member is already in another active convoy", async () => {
      const r = repo();
      const first = await r.create({
        leadWorkId: workId("w-lead-1"),
        memberWorkIds: [workId("w-shared"), workId("w-only-a")],
        goal: "first",
      });
      expect(first.ok).toBe(true);

      const second = await r.create({
        leadWorkId: workId("w-lead-2"),
        memberWorkIds: [workId("w-shared")],
        goal: "second",
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error).toBeInstanceOf(AlreadyExistsError);
      expect(second.error.code).toBe("ALREADY_EXISTS");
      // entity is "ConvoyMembership", id is the offending member work id
      expect(second.error.details).toMatchObject({
        entity: "ConvoyMembership",
        id: workId("w-shared"),
      });
    });

    it("rejects creation when the proposed lead is already a lead in another active convoy", async () => {
      const r = repo();
      const first = await r.create({
        leadWorkId: workId("w-shared-lead"),
        memberWorkIds: [workId("w-a")],
        goal: "first",
      });
      expect(first.ok).toBe(true);

      const second = await r.create({
        leadWorkId: workId("w-shared-lead"),
        memberWorkIds: [workId("w-b")],
        goal: "second",
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error).toBeInstanceOf(AlreadyExistsError);
    });

    it("allows reusing a member after the conflicting convoy completes", async () => {
      const r = repo();
      const first = await r.create({
        leadWorkId: workId("w-lead-1"),
        memberWorkIds: [workId("w-shared")],
        goal: "first",
      });
      if (!first.ok) throw new Error("setup failed");
      const completed = await r.complete(first.value.id);
      expect(completed.ok).toBe(true);

      const second = await r.create({
        leadWorkId: workId("w-lead-2"),
        memberWorkIds: [workId("w-shared")],
        goal: "second",
      });
      expect(second.ok).toBe(true);
    });

    it("allows reusing a member after the conflicting convoy is cancelled", async () => {
      const r = repo();
      const first = await r.create({
        leadWorkId: workId("w-lead-1"),
        memberWorkIds: [workId("w-shared")],
        goal: "first",
      });
      if (!first.ok) throw new Error("setup failed");
      const cancelled = await r.cancel(first.value.id);
      expect(cancelled.ok).toBe(true);

      const second = await r.create({
        leadWorkId: workId("w-lead-2"),
        memberWorkIds: [workId("w-shared")],
        goal: "second",
      });
      expect(second.ok).toBe(true);
    });
  });

  describe("findByMember", () => {
    it("returns convoys where the work id is the lead OR a member", async () => {
      const r = repo();
      await r.create({
        leadWorkId: workId("w-lead-1"),
        memberWorkIds: [workId("w-x")],
        goal: "first",
      });
      await r.create({
        leadWorkId: workId("w-lead-2"),
        memberWorkIds: [workId("w-y")],
        goal: "second",
      });

      const asLead = await r.findByMember(workId("w-lead-1"));
      expect(asLead.ok).toBe(true);
      if (!asLead.ok) return;
      expect(asLead.value).toHaveLength(1);

      const asMember = await r.findByMember(workId("w-x"));
      expect(asMember.ok).toBe(true);
      if (!asMember.ok) return;
      expect(asMember.value).toHaveLength(1);

      const missing = await r.findByMember(workId("w-nope"));
      expect(missing.ok).toBe(true);
      if (!missing.ok) return;
      expect(missing.value).toHaveLength(0);
    });
  });

  describe("findActive", () => {
    it("excludes completed and cancelled convoys", async () => {
      const r = repo();
      const a = await r.create({
        leadWorkId: workId("w-lead-a"),
        memberWorkIds: [workId("w-a")],
        goal: "a",
      });
      const b = await r.create({
        leadWorkId: workId("w-lead-b"),
        memberWorkIds: [workId("w-b")],
        goal: "b",
      });
      const c = await r.create({
        leadWorkId: workId("w-lead-c"),
        memberWorkIds: [workId("w-c")],
        goal: "c",
      });
      if (!a.ok || !b.ok || !c.ok) throw new Error("setup failed");
      await r.complete(b.value.id);
      await r.cancel(c.value.id);

      const active = await r.findActive();
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(active.value.map((cv) => cv.id)).toEqual([a.value.id]);
    });
  });

  describe("complete / cancel lifecycle", () => {
    it("rejects re-completion of a terminal convoy", async () => {
      const r = repo();
      const created = await r.create({
        leadWorkId: workId("w-lead"),
        memberWorkIds: [workId("w-a")],
        goal: "g",
      });
      if (!created.ok) throw new Error("setup failed");
      const first = await r.complete(created.value.id);
      expect(first.ok).toBe(true);
      const second = await r.complete(created.value.id);
      expect(second.ok).toBe(false);
    });

    it("rejects cancellation of a completed convoy", async () => {
      const r = repo();
      const created = await r.create({
        leadWorkId: workId("w-lead"),
        memberWorkIds: [workId("w-a")],
        goal: "g",
      });
      if (!created.ok) throw new Error("setup failed");
      await r.complete(created.value.id);
      const cancelled = await r.cancel(created.value.id);
      expect(cancelled.ok).toBe(false);
    });
  });
});
