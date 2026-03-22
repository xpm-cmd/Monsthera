import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonstheraConfig } from "../../../src/core/config.js";
import { createMonstheraContextLoader } from "../../../src/core/context-loader.js";

const { searchRouterInitialize, upsertRepo, lifecycleSweep, fakeTimer } = vi.hoisted(() => ({
  searchRouterInitialize: vi.fn(),
  upsertRepo: vi.fn((_db: unknown, _repoRoot: string, _repoName: string) => ({ id: 7 })),
  lifecycleSweep: vi.fn(),
  fakeTimer: { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>,
}));

vi.mock("../../../src/git/operations.js", () => ({
  isGitRepo: vi.fn(async () => true),
  getRepoRoot: vi.fn(async () => "/repo"),
  getMainRepoRoot: vi.fn(async () => "/repo"),
}));

vi.mock("../../../src/db/init.js", () => ({
  initDatabase: vi.fn(() => ({ db: { tag: "db" }, sqlite: { tag: "sqlite" } })),
  initGlobalDatabase: vi.fn(() => ({ globalDb: null, globalSqlite: null })),
}));

vi.mock("../../../src/db/queries.js", () => ({
  upsertRepo,
}));

vi.mock("../../../src/search/router.js", () => ({
  SearchRouter: vi.fn().mockImplementation(function MockSearchRouter() {
    return {
      initialize: searchRouterInitialize,
      getActiveBackendName: () => "fts5",
      rebuildTicketFts: vi.fn(),
      rebuildKnowledgeFts: vi.fn(),
      upsertKnowledgeFts: vi.fn(),
    };
  }),
}));

vi.mock("../../../src/coordination/bus.js", () => ({
  CoordinationBus: vi.fn().mockImplementation(function MockCoordinationBus() {
    return { send: vi.fn(), getTopology: () => "hub-spoke" };
  }),
}));

vi.mock("../../../src/tickets/lifecycle.js", () => ({
  TicketLifecycleReactor: vi.fn().mockImplementation(function MockLifecycleReactor() {
    return { sweep: lifecycleSweep };
  }),
}));

describe("createMonstheraContextLoader", () => {
  const insight = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const config = {
    repoPath: "/repo",
    monstheraDir: ".monsthera",
    dbName: "monsthera.db",
    zoektEnabled: false,
    semanticEnabled: false,
    search: {},
    coordinationTopology: "hub-spoke",
    lifecycle: {
      enabled: true,
      autoTriageOnCreate: true,
      autoTriageSeverityThreshold: "medium",
      autoTriagePriorityThreshold: 5,
      autoCloseResolvedAfterMs: 0,
      autoReviewOnPatch: false,
      autoCascadeBlocked: true,
      sweepIntervalMs: 60_000,
    },
  } as unknown as MonstheraConfig;

  beforeEach(() => {
    searchRouterInitialize.mockReset();
    searchRouterInitialize.mockResolvedValue(undefined);
    upsertRepo.mockClear();
    lifecycleSweep.mockClear();
    fakeTimer.unref = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips the background sweep in one-shot runtimes", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const getContext = createMonstheraContextLoader(config, insight as any, { startLifecycleSweep: false });

    const context = await getContext();
    context.dispose?.();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(context.lifecycle).toBeTruthy();
  });

  it("starts, unrefs, and clears the background sweep for long-lived runtimes", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(fakeTimer);
    const clearIntervalSpy = vi.spyOn(global, "clearInterval").mockImplementation(() => undefined);
    const getContext = createMonstheraContextLoader(config, insight as any);

    const context = await getContext();
    context.dispose?.();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(fakeTimer.unref).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimer);
  });
});
