import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

const repoRoot = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const binPath = path.join(repoRoot, "dist", "bin.js");

async function ensureBuilt(): Promise<void> {
  try {
    await fs.access(binPath);
    return;
  } catch {
    // Fall through.
  }
  const res = spawnSync("pnpm", ["build"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (res.status !== 0 || res.error) {
    throw new Error(
      `Auto-build failed. stdout: ${res.stdout ?? ""}\nstderr: ${res.stderr ?? ""}\nerror: ${res.error?.message ?? "(none)"}`,
    );
  }
}

function articleMarkdown(opts: {
  id: string;
  slug: string;
  title: string;
  references?: string[];
  body?: string;
}): string {
  const refs = opts.references?.length
    ? `[${opts.references.join(", ")}]`
    : "[]";
  return [
    "---",
    `id: ${opts.id}`,
    `title: "${opts.title}"`,
    `slug: ${opts.slug}`,
    "category: context",
    "tags: []",
    "codeRefs: []",
    `references: ${refs}`,
    "createdAt: 2026-04-24T00:00:00.000Z",
    "updatedAt: 2026-04-24T00:00:00.000Z",
    "---",
    "",
    opts.body ?? "",
    "",
  ].join("\n");
}

async function seedRefsCorpus(repoPath: string): Promise<void> {
  const notesDir = path.join(repoPath, "knowledge", "notes");
  await fs.mkdir(notesDir, { recursive: true });

  await fs.writeFile(
    path.join(notesDir, "target.md"),
    articleMarkdown({
      id: "k-target",
      slug: "target",
      title: "Target",
      body: "I am the target article.",
    }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(notesDir, "citer.md"),
    articleMarkdown({
      id: "k-citer",
      slug: "citer",
      title: "Citer",
      references: ["k-target"],
      body: "I cite the target via frontmatter.",
    }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(notesDir, "orphan-source.md"),
    articleMarkdown({
      id: "k-orphan-source",
      slug: "orphan-source",
      title: "Orphan Source",
      body: "I cite k-does-not-exist in prose.",
    }),
    "utf-8",
  );
}

describe("Integration: monsthera knowledge refs", () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 60_000);

  it("--to <id> --format json lists incoming citations", async () => {
    const repoPath = path.join("/tmp", `monsthera-refs-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedRefsCorpus(repoPath);

    const res = spawnSync(
      "node",
      [binPath, "knowledge", "refs", "--to", "k-target", "--format", "json", "--repo", repoPath],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );

    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((e: { id: string }) => e.id)).toEqual(["k-citer"]);
    expect(parsed[0].kind).toBe("knowledge");

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);

  it("--from <slug> --format json lists outgoing citations", async () => {
    const repoPath = path.join("/tmp", `monsthera-refs-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedRefsCorpus(repoPath);

    const res = spawnSync(
      "node",
      [binPath, "knowledge", "refs", "--from", "citer", "--format", "json", "--repo", repoPath],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );

    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.map((e: { id: string }) => e.id)).toEqual(["k-target"]);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);

  it("--orphans --format json surfaces unresolved inline citations", async () => {
    const repoPath = path.join("/tmp", `monsthera-refs-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await seedRefsCorpus(repoPath);

    const res = spawnSync(
      "node",
      [binPath, "knowledge", "refs", "--orphans", "--format", "json", "--repo", repoPath],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );

    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(
      parsed.some(
        (o: { sourceArticleId: string; missingRefId: string }) =>
          o.sourceArticleId === "k-orphan-source" && o.missingRefId === "k-does-not-exist",
      ),
    ).toBe(true);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);

  it("rejects when --to, --from, and --orphans are all missing", async () => {
    const repoPath = path.join("/tmp", `monsthera-refs-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });

    const res = spawnSync(
      "node",
      [binPath, "knowledge", "refs", "--repo", repoPath],
      { encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );

    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/exactly one of --to/);

    await fs.rm(repoPath, { recursive: true, force: true });
  }, 120_000);
});
