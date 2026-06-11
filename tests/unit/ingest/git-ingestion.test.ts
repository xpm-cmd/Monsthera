import { describe, it, expect } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { IngestService } from "../../../src/ingest/service.js";
import type { CommandRunner } from "../../../src/ops/command-runner.js";
import { ok, err } from "../../../src/core/result.js";
import { StorageError } from "../../../src/core/errors.js";

function silentLogger() {
  return createLogger({ level: "error", output: () => {} });
}

// Stub git runner: dispatch canned stdout by matching the git args. Any
// unmatched call is a test bug, so it errors loudly.
function gitRunner(handlers: Array<{ match: (args: readonly string[]) => boolean; stdout: string }>): CommandRunner {
  return async (spec) => {
    const handler = handlers.find((h) => h.match(spec.args));
    if (!handler) return err(new StorageError(`unexpected git call: ${spec.args.join(" ")}`));
    return ok({ stdout: handler.stdout, stderr: "" });
  };
}

const COMMIT_LOG = [
  "aaa111|feat: add foo|2026-05-12T23:05:00+10:00",
  "bbb222|fix: bug in bar|2026-05-12T23:15:30+10:00",
  "",
].join("\n");

describe("IngestService.importGitHistory (PR-15)", () => {
  it("creates one ingested article per commit with origin=ingested and sourcePath git:<sha>", async () => {
    const repo = new InMemoryKnowledgeArticleRepository();
    const service = new IngestService({
      knowledgeRepo: repo,
      repoPath: "/tmp/repo",
      logger: silentLogger(),
      commandRunner: gitRunner([{ match: (a) => a[0] === "log", stdout: COMMIT_LOG }]),
    });

    const result = await service.importGitHistory({ range: "HEAD~2..HEAD" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.createdCount).toBe(2);
    expect(result.value.importedCount).toBe(2);

    const all = await repo.findMany();
    if (!all.ok) return;
    const ingested = all.value.filter((a) => a.extraFrontmatter?.["origin"] === "ingested");
    expect(ingested).toHaveLength(2);
    expect(ingested.map((a) => a.sourcePath).sort()).toEqual(["git:aaa111", "git:bbb222"]);
    // The commit subject becomes the article title.
    expect(ingested.some((a) => a.title.includes("add foo"))).toBe(true);
  });

  it("is idempotent — re-ingesting the same range updates instead of duplicating", async () => {
    const repo = new InMemoryKnowledgeArticleRepository();
    const runner = gitRunner([{ match: (a) => a[0] === "log", stdout: COMMIT_LOG }]);
    const service = new IngestService({ knowledgeRepo: repo, repoPath: "/tmp/repo", logger: silentLogger(), commandRunner: runner });

    await service.importGitHistory({ range: "HEAD~2..HEAD" });
    const second = await service.importGitHistory({ range: "HEAD~2..HEAD" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.createdCount).toBe(0);
    expect(second.value.updatedCount).toBe(2);

    const all = await repo.findMany();
    if (all.ok) expect(all.value).toHaveLength(2);
  });

  it("surfaces a git failure (bad range) as an error", async () => {
    const service = new IngestService({
      knowledgeRepo: new InMemoryKnowledgeArticleRepository(),
      repoPath: "/tmp/repo",
      logger: silentLogger(),
      commandRunner: async () => err(new StorageError("fatal: bad revision 'nope..nope'")),
    });
    const result = await service.importGitHistory({ range: "nope..nope" });
    expect(result.ok).toBe(false);
  });
});

describe("IngestService.importPr (PR-15)", () => {
  it("resolves the PR merge commit and ingests its commit range, tagged pr-<n>", async () => {
    const repo = new InMemoryKnowledgeArticleRepository();
    const runner = gitRunner([
      // grep for the GitHub merge commit
      { match: (a) => a.some((x) => x.includes("Merge pull request")), stdout: "merge999\n" },
      // log the PR's commit range <merge>^1..<merge>^2
      { match: (a) => a.includes("merge999^1..merge999^2"), stdout: "ccc333|feat: pr work|2026-05-12T23:05:00+10:00\n" },
    ]);
    const service = new IngestService({ knowledgeRepo: repo, repoPath: "/tmp/repo", logger: silentLogger(), commandRunner: runner });

    const result = await service.importPr({ prNumber: 42 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.createdCount).toBe(1);

    const all = await repo.findMany();
    if (!all.ok) return;
    const article = all.value.find((a) => a.sourcePath === "git:ccc333");
    expect(article?.extraFrontmatter?.["origin"]).toBe("ingested");
    expect(article?.tags).toContain("pr-42");
  });

  it("returns an error when the PR merge commit cannot be found", async () => {
    const service = new IngestService({
      knowledgeRepo: new InMemoryKnowledgeArticleRepository(),
      repoPath: "/tmp/repo",
      logger: silentLogger(),
      commandRunner: gitRunner([{ match: (a) => a.some((x) => x.includes("Merge pull request")), stdout: "\n" }]),
    });
    const result = await service.importPr({ prNumber: 999 });
    expect(result.ok).toBe(false);
  });
});

describe("per-commit codeRefs (F5, deferred from PR-15)", () => {
  it("each ingested article carries the commit's changed files as codeRefs", async () => {
    const repo = new InMemoryKnowledgeArticleRepository();
    const service = new IngestService({
      knowledgeRepo: repo,
      repoPath: "/tmp/repo",
      logger: silentLogger(),
      commandRunner: gitRunner([
        { match: (a) => a[0] === "log", stdout: COMMIT_LOG },
        { match: (a) => a[0] === "show" && a.includes("aaa111"), stdout: "src/foo.ts\nsrc/foo.test.ts\n" },
        { match: (a) => a[0] === "show" && a.includes("bbb222"), stdout: "docs/bar.md\n" },
      ]),
    });

    const result = await service.importGitHistory({ range: "HEAD~2..HEAD" });
    expect(result.ok).toBe(true);

    const all = await repo.findMany();
    if (!all.ok) return;
    const bySource = new Map(all.value.map((a) => [a.sourcePath, a]));
    expect(bySource.get("git:aaa111")?.codeRefs).toEqual(["src/foo.ts", "src/foo.test.ts"]);
    expect(bySource.get("git:bbb222")?.codeRefs).toEqual(["docs/bar.md"]);
  });

  it("caps codeRefs at 20 files for monster commits", async () => {
    const repo = new InMemoryKnowledgeArticleRepository();
    const manyFiles = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`).join("\n") + "\n";
    const service = new IngestService({
      knowledgeRepo: repo,
      repoPath: "/tmp/repo",
      logger: silentLogger(),
      commandRunner: gitRunner([
        { match: (a) => a[0] === "log", stdout: "ccc333|chore: huge sweep|2026-05-12T23:30:00+10:00\n" },
        { match: (a) => a[0] === "show", stdout: manyFiles },
      ]),
    });

    const result = await service.importGitHistory({ range: "HEAD~1..HEAD" });
    expect(result.ok).toBe(true);

    const all = await repo.findMany();
    if (!all.ok) return;
    expect(all.value[0]?.codeRefs).toHaveLength(20);
    expect(all.value[0]?.codeRefs[0]).toBe("src/file-0.ts");
  });

  it("fails open: a git show failure leaves codeRefs empty without failing the ingest", async () => {
    const repo = new InMemoryKnowledgeArticleRepository();
    const service = new IngestService({
      knowledgeRepo: repo,
      repoPath: "/tmp/repo",
      logger: silentLogger(),
      // No `show` handler: the stub runner errors on it, like a git failure would.
      commandRunner: gitRunner([{ match: (a) => a[0] === "log", stdout: COMMIT_LOG }]),
    });

    const result = await service.importGitHistory({ range: "HEAD~2..HEAD" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.createdCount).toBe(2);

    const all = await repo.findMany();
    if (!all.ok) return;
    expect(all.value.every((a) => a.codeRefs.length === 0)).toBe(true);
  });
});
