import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../../src/core/config.js";

const KNOB_ENV = [
  "MONSTHERA_SEARCH_BM25K1",
  "MONSTHERA_SEARCH_TITLE_BOOST",
  "MONSTHERA_SEARCH_FRESHNESS_FRESH_DAYS",
  "MONSTHERA_SEARCH_FRESHNESS_STALE_DAYS",
  "MONSTHERA_SEARCH_RERANK_ENABLED",
  "MONSTHERA_SEARCH_RANK_PROFILE",
] as const;

/** Run `fn` with the given env applied (and every knob var explicitly reset). */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev = new Map<string, string | undefined>();
  const toSet = { ...Object.fromEntries(KNOB_ENV.map((k) => [k, undefined])), ...vars };
  for (const [k, v] of Object.entries(toSet)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Hermetic repo root with no config file → defaults + env only.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monsthera-cfg-"));

describe("search ranking knobs — config + env (PR-10)", () => {
  it("applies schema defaults when no env override is set", () => {
    withEnv({}, () => {
      const result = loadConfig(tmpRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.search.bm25K1).toBe(1.2);
      expect(result.value.search.titleBoost).toBe(3.0);
      expect(result.value.search.freshnessFreshDays).toBe(14);
      expect(result.value.search.freshnessStaleDays).toBe(45);
      expect(result.value.search.rerankEnabled).toBe(false);
      expect(result.value.search.rankProfile).toBe("balanced");
    });
  });

  it("MONSTHERA_SEARCH_BM25K1 overrides the default (the eval acceptance knob)", () => {
    withEnv({ MONSTHERA_SEARCH_BM25K1: "2.5" }, () => {
      const result = loadConfig(tmpRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.search.bm25K1).toBe(2.5);
    });
  });

  it("maps the remaining numeric, boolean, and enum knobs", () => {
    withEnv(
      {
        MONSTHERA_SEARCH_TITLE_BOOST: "5",
        MONSTHERA_SEARCH_FRESHNESS_FRESH_DAYS: "7",
        MONSTHERA_SEARCH_FRESHNESS_STALE_DAYS: "30",
        MONSTHERA_SEARCH_RERANK_ENABLED: "true",
        MONSTHERA_SEARCH_RANK_PROFILE: "tokenmax",
      },
      () => {
        const result = loadConfig(tmpRoot);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.search.titleBoost).toBe(5);
        expect(result.value.search.freshnessFreshDays).toBe(7);
        expect(result.value.search.freshnessStaleDays).toBe(30);
        expect(result.value.search.rerankEnabled).toBe(true);
        expect(result.value.search.rankProfile).toBe("tokenmax");
      },
    );
  });

  it("ignores an unparseable numeric override and keeps the default", () => {
    withEnv({ MONSTHERA_SEARCH_BM25K1: "not-a-number" }, () => {
      const result = loadConfig(tmpRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.search.bm25K1).toBe(1.2);
    });
  });
});
