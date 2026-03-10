import { describe, it, expect } from "vitest";
import { checkToolAccess, canReadNoteType, canWriteNoteType, getMaxCodeSpanLines } from "../../../src/trust/tiers.js";

describe("checkToolAccess", () => {
  it("allows developer to propose patches", () => {
    const result = checkToolAccess("propose_patch", "developer", "A");
    expect(result.allowed).toBe(true);
  });

  it("denies observer from proposing patches", () => {
    const result = checkToolAccess("propose_patch", "observer", "B");
    expect(result.allowed).toBe(false);
  });

  it("denies reviewer from proposing patches", () => {
    const result = checkToolAccess("propose_patch", "reviewer", "A");
    expect(result.allowed).toBe(false);
  });

  it("allows admin access to everything", () => {
    const result = checkToolAccess("propose_patch", "admin", "A");
    expect(result.allowed).toBe(true);
  });

  it("denies observer from broadcasting", () => {
    const result = checkToolAccess("broadcast", "observer", "B");
    expect(result.allowed).toBe(false);
  });

  it("allows developer to broadcast", () => {
    const result = checkToolAccess("broadcast", "developer", "A");
    expect(result.allowed).toBe(true);
  });

  it("allows observer to use read-only tools", () => {
    expect(checkToolAccess("get_code_pack", "observer", "B").allowed).toBe(true);
    expect(checkToolAccess("status", "observer", "B").allowed).toBe(true);
    expect(checkToolAccess("capabilities", "observer", "B").allowed).toBe(true);
  });

  // --- Ticket permissions ---
  it("allows developer to create tickets", () => {
    expect(checkToolAccess("create_ticket", "developer", "A").allowed).toBe(true);
  });

  it("allows reviewer to create tickets", () => {
    expect(checkToolAccess("create_ticket", "reviewer", "A").allowed).toBe(true);
  });

  it("denies observer from creating tickets", () => {
    expect(checkToolAccess("create_ticket", "observer", "B").allowed).toBe(false);
  });

  it("allows developer to transition tickets", () => {
    expect(checkToolAccess("update_ticket_status", "developer", "A").allowed).toBe(true);
    expect(checkToolAccess("assign_ticket", "developer", "A").allowed).toBe(true);
  });

  it("denies observer from transitioning tickets", () => {
    expect(checkToolAccess("update_ticket_status", "observer", "B").allowed).toBe(false);
    expect(checkToolAccess("assign_ticket", "observer", "B").allowed).toBe(false);
  });

  it("allows observer to list and get tickets", () => {
    expect(checkToolAccess("list_tickets", "observer", "B").allowed).toBe(true);
    expect(checkToolAccess("search_tickets", "observer", "B").allowed).toBe(true);
    expect(checkToolAccess("get_ticket", "observer", "B").allowed).toBe(true);
  });
});

describe("canReadNoteType", () => {
  it("allows developer to read all note types", () => {
    expect(canReadNoteType("developer", "issue")).toBe(true);
    expect(canReadNoteType("developer", "gotcha")).toBe(true);
    expect(canReadNoteType("developer", "runbook")).toBe(true);
  });

  it("restricts observer to subset of note types", () => {
    expect(canReadNoteType("observer", "issue")).toBe(true);
    expect(canReadNoteType("observer", "decision")).toBe(true);
    expect(canReadNoteType("observer", "change_note")).toBe(true);
    expect(canReadNoteType("observer", "gotcha")).toBe(false);
    expect(canReadNoteType("observer", "runbook")).toBe(false);
  });
});

describe("canWriteNoteType", () => {
  it("allows developer to write all note types", () => {
    expect(canWriteNoteType("developer", "issue")).toBe(true);
    expect(canWriteNoteType("developer", "runbook")).toBe(true);
  });

  it("denies observer from writing any notes", () => {
    expect(canWriteNoteType("observer", "issue")).toBe(false);
  });

  it("allows reviewer to write limited note types", () => {
    expect(canWriteNoteType("reviewer", "issue")).toBe(true);
    expect(canWriteNoteType("reviewer", "decision")).toBe(true);
    expect(canWriteNoteType("reviewer", "runbook")).toBe(false);
  });
});

describe("getMaxCodeSpanLines", () => {
  it("returns 200 for Tier A", () => {
    expect(getMaxCodeSpanLines("A")).toBe(200);
  });

  it("returns 0 for Tier B", () => {
    expect(getMaxCodeSpanLines("B")).toBe(0);
  });
});
