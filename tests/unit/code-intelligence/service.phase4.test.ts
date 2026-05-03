/**
 * M3 phase 4 — risk reasons integration (ADR-017 §D10).
 *
 * These tests live in their own file so the existing M1/M2 service tests
 * (`tests/unit/code-intelligence/service.test.ts`) remain literally
 * untouched. That is the regression-test evidence the prompt asks for:
 * the M2 surface stays backwards-compatible; only the `reasons` array
 * gains entries when an inventory service is wired.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { CodeIntelligenceService } from "../../../src/code-intelligence/service.js";
import type { CodeInventoryService } from "../../../src/code-intelligence/inventory/service.js";
import { createLogger } from "../../../src/core/logger.js";
import { ok, err, type Result } from "../../../src/core/result.js";
import { StorageError } from "../../../src/core/errors.js";
import { agentId, slug } from "../../../src/core/types.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { StructureService } from "../../../src/structure/service.js";
import type { CodeArtifact } from "../../../src/code-intelligence/inventory/types.js";

interface InventoryStub {
  readonly inventory: Pick<CodeInventoryService, "getSymbolsForFile">;
  readonly calls: string[];
}

/**
 * Minimal `CodeInventoryService` substitute used only for risk-reasons
 * tests. Maps normalized paths to a (possibly empty) symbol list. Paths
 * not in the map resolve to the empty list, matching the real
 * service's behaviour for files outside the inventory.
 */
function makeInventoryStub(symbolsByPath: Record<string, readonly CodeArtifact[]> = {}): InventoryStub {
  const calls: string[] = [];
  const inventory = {
    async getSymbolsForFile(p: string): Promise<Result<readonly CodeArtifact[], StorageError>> {
      calls.push(p);
      return ok(symbolsByPath[p] ?? []);
    },
  };
  return { inventory, calls };
}

interface Harness {
  readonly repoPath: string;
  readonly knowledgeRepo: InMemoryKnowledgeArticleRepository;
  readonly workRepo: InMemoryWorkArticleRepository;
  readonly service: CodeIntelligenceService;
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop()!;
    await fs.rm(p, { recursive: true, force: true });
  }
});

interface HarnessOptions {
  readonly inventory?: InventoryStub["inventory"];
  /** Extra files (beyond `src/auth/session.ts`) to materialise on disk. */
  readonly extraFiles?: readonly { readonly relPath: string; readonly content?: string }[];
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const repoPath = path.join(tmpdir(), `monsthera-code-intel-phase4-${randomUUID()}`);
  await fs.mkdir(path.join(repoPath, "src", "auth"), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, "src", "auth", "session.ts"),
    "export const session = true;\n",
    "utf-8",
  );
  for (const extra of options.extraFiles ?? []) {
    const fullPath = path.join(repoPath, extra.relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, extra.content ?? "", "utf-8");
  }
  cleanupPaths.push(repoPath);

  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const logger = createLogger({ level: "error", domain: "test" });
  const structureService = new StructureService({ knowledgeRepo, workRepo, repoPath, logger });
  const service = new CodeIntelligenceService({
    knowledgeRepo,
    workRepo,
    structureService,
    repoPath,
    logger,
    ...(options.inventory && {
      inventoryService: options.inventory as unknown as CodeInventoryService,
    }),
  });
  return { repoPath, knowledgeRepo, workRepo, service };
}

describe("CodeIntelligenceService — phase 4 inventory reasons", () => {
  // ─── M2 backwards-compatibility ────────────────────────────────────────────

  it("preserves M2 behavior when no inventoryService is wired (no new reasons)", async () => {
    const { service } = await makeHarness({
      extraFiles: [
        { relPath: "package.json", content: "{}\n" },
        { relPath: "src/empty.ts", content: "// just a comment\n" },
      ],
    });

    const manifestImpact = await service.analyzeCodeRefImpact({ ref: "package.json" });
    expect(manifestImpact.ok).toBe(true);
    if (!manifestImpact.ok) return;
    expect(manifestImpact.value.reasons).not.toContain("file_is_manifest");
    expect(manifestImpact.value.reasons).not.toContain("file_has_no_exports");
    // package.json has no Monsthera owners — risk should be "none" per M2,
    // not forced to "high" (manifest detection only kicks in when the
    // inventoryService is wired).
    expect(manifestImpact.value.risk).toBe("none");

    const emptyImpact = await service.analyzeCodeRefImpact({ ref: "src/empty.ts" });
    expect(emptyImpact.ok).toBe(true);
    if (!emptyImpact.ok) return;
    expect(emptyImpact.value.reasons).not.toContain("file_has_no_exports");
  });

  // ─── file_is_manifest ──────────────────────────────────────────────────────

  it("emits file_is_manifest and forces risk=high for package.json", async () => {
    const stub = makeInventoryStub();
    const { service } = await makeHarness({
      inventory: stub.inventory,
      extraFiles: [{ relPath: "package.json", content: "{}\n" }],
    });

    const result = await service.analyzeCodeRefImpact({ ref: "package.json" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reasons).toContain("file_is_manifest");
    expect(result.value.risk).toBe("high");
  });

  it("file_is_manifest fires for nested manifests (workspace packages)", async () => {
    const stub = makeInventoryStub();
    const { service } = await makeHarness({
      inventory: stub.inventory,
      extraFiles: [{ relPath: "packages/core/Cargo.toml", content: "[package]\n" }],
    });

    const result = await service.analyzeCodeRefImpact({ ref: "packages/core/Cargo.toml" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reasons).toContain("file_is_manifest");
    expect(result.value.risk).toBe("high");
  });

  it("file_is_manifest also fires for suffix-matched manifests (.gemspec, .csproj)", async () => {
    const stub = makeInventoryStub();
    const { service } = await makeHarness({
      inventory: stub.inventory,
      extraFiles: [
        { relPath: "monsthera.gemspec", content: "" },
        { relPath: "src/Web.csproj", content: "<Project />" },
      ],
    });

    const gem = await service.analyzeCodeRefImpact({ ref: "monsthera.gemspec" });
    expect(gem.ok).toBe(true);
    if (!gem.ok) return;
    expect(gem.value.reasons).toContain("file_is_manifest");

    const csproj = await service.analyzeCodeRefImpact({ ref: "src/Web.csproj" });
    expect(csproj.ok).toBe(true);
    if (!csproj.ok) return;
    expect(csproj.value.reasons).toContain("file_is_manifest");
  });

  it("file_is_manifest still forces risk=high even when active work links to it", async () => {
    const stub = makeInventoryStub();
    const { service, workRepo } = await makeHarness({
      inventory: stub.inventory,
      extraFiles: [{ relPath: "go.mod", content: "module example\n" }],
    });
    // Active work in `planning` would normally yield risk=medium per M2;
    // manifest detection promotes it to "high" regardless.
    await workRepo.create({
      title: "Bump go module",
      template: "feature",
      phase: "planning",
      priority: "low",
      author: agentId("agent-1"),
      content: "## Objective\n\n## Acceptance Criteria\n- [ ] up",
      codeRefs: ["go.mod"],
    });

    const result = await service.analyzeCodeRefImpact({ ref: "go.mod" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reasons).toContain("file_is_manifest");
    expect(result.value.reasons).toContain("active_work_linked");
    expect(result.value.risk).toBe("high");
  });

  it("file_is_manifest is not emitted for non-manifest files", async () => {
    const stub = makeInventoryStub();
    const { service } = await makeHarness({ inventory: stub.inventory });

    const result = await service.analyzeCodeRefImpact({ ref: "src/auth/session.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reasons).not.toContain("file_is_manifest");
  });

  // ─── file_has_no_exports ───────────────────────────────────────────────────

  it("emits file_has_no_exports for empty TS files in a code language", async () => {
    const stub = makeInventoryStub({
      // no entry for src/auth/session.ts → defaults to []
    });
    const { service } = await makeHarness({ inventory: stub.inventory });

    const result = await service.analyzeCodeRefImpact({ ref: "src/auth/session.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reasons).toContain("file_has_no_exports");
    // Reason is informational only — risk remains M2's verdict (here: "none").
    expect(result.value.risk).toBe("none");
  });

  it("file_has_no_exports does NOT fire when the inventory has symbols", async () => {
    const stub = makeInventoryStub({
      "src/auth/session.ts": [
        {
          id: "sym-1",
          kind: "function",
          name: "createSession",
          path: "src/auth/session.ts",
          language: "typescript",
        },
      ],
    });
    const { service } = await makeHarness({ inventory: stub.inventory });

    const result = await service.analyzeCodeRefImpact({ ref: "src/auth/session.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reasons).not.toContain("file_has_no_exports");
  });

  it("file_has_no_exports does NOT fire on non-code languages (markdown, yaml, json)", async () => {
    const stub = makeInventoryStub();
    const { service } = await makeHarness({
      inventory: stub.inventory,
      extraFiles: [
        { relPath: "docs/notes.md", content: "# Notes\n" },
        { relPath: "config/app.yaml", content: "" },
        { relPath: "data/sample.json", content: "{}" },
      ],
    });

    for (const ref of ["docs/notes.md", "config/app.yaml", "data/sample.json"]) {
      const result = await service.analyzeCodeRefImpact({ ref });
      expect(result.ok, `analyze ${ref}`).toBe(true);
      if (!result.ok) continue;
      expect(result.value.reasons, `${ref} reasons`).not.toContain("file_has_no_exports");
    }
  });

  it("file_has_no_exports is skipped for directories", async () => {
    const stub = makeInventoryStub();
    const { service } = await makeHarness({ inventory: stub.inventory });

    // src/auth is a directory; the analyzer should not query the inventory
    // for symbols nor emit the reason.
    const result = await service.analyzeCodeRefImpact({ ref: "src/auth" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reasons).not.toContain("file_has_no_exports");
    expect(stub.calls).not.toContain("src/auth");
  });

  it("inventory storage errors are swallowed; risk analysis still returns a Result.ok", async () => {
    const inventory: Pick<CodeInventoryService, "getSymbolsForFile"> = {
      async getSymbolsForFile() {
        return err(new StorageError("disk on fire"));
      },
    };
    const { service } = await makeHarness({
      inventory: inventory as InventoryStub["inventory"],
    });

    const result = await service.analyzeCodeRefImpact({ ref: "src/auth/session.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reasons).not.toContain("file_has_no_exports");
  });

  // ─── detectChangedCodeRefs threading ───────────────────────────────────────

  it("detectChangedCodeRefs surfaces the new reasons via analyzeWithIndex", async () => {
    const stub = makeInventoryStub();
    const { service, knowledgeRepo } = await makeHarness({
      inventory: stub.inventory,
      extraFiles: [{ relPath: "package.json", content: "{}" }],
    });
    // Need at least one knowledge owner so the impact survives the
    // `summary.ownerCount > 0` filter inside detectChangedCodeRefs.
    await knowledgeRepo.create({
      title: "Build notes",
      slug: slug("build-notes"),
      category: "architecture",
      content: "Notes about package.json",
      codeRefs: ["package.json"],
    });

    const result = await service.detectChangedCodeRefs({ changedPaths: ["package.json"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const impact = result.value.impacts.find((i) => i.ref.normalizedPath === "package.json");
    expect(impact).toBeDefined();
    expect(impact!.reasons).toContain("file_is_manifest");
    expect(impact!.risk).toBe("high");
  });
});
