import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { prepareKnowledgeSearchTarget } from "../../../src/knowledge/search.js";

describe("prepareKnowledgeSearchTarget", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
  });

  afterEach(() => {
    sqlite.close();
  });

  it("rebuilds the knowledge index when the target is stale", () => {
    const initKnowledgeFts = vi.fn();
    const isKnowledgeIndexCurrent = vi.fn(() => false);
    const rebuildKnowledgeFts = vi.fn();

    prepareKnowledgeSearchTarget({
      initKnowledgeFts,
      isKnowledgeIndexCurrent,
      rebuildKnowledgeFts,
    }, sqlite);

    expect(initKnowledgeFts).toHaveBeenCalledWith(sqlite);
    expect(isKnowledgeIndexCurrent).toHaveBeenCalledWith(sqlite);
    expect(rebuildKnowledgeFts).toHaveBeenCalledWith(sqlite);
  });

  it("skips rebuild when the target index is already current", () => {
    const initKnowledgeFts = vi.fn();
    const isKnowledgeIndexCurrent = vi.fn(() => true);
    const rebuildKnowledgeFts = vi.fn();

    prepareKnowledgeSearchTarget({
      initKnowledgeFts,
      isKnowledgeIndexCurrent,
      rebuildKnowledgeFts,
    }, sqlite);

    expect(initKnowledgeFts).toHaveBeenCalledWith(sqlite);
    expect(isKnowledgeIndexCurrent).toHaveBeenCalledWith(sqlite);
    expect(rebuildKnowledgeFts).not.toHaveBeenCalled();
  });
});
