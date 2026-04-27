/* eslint-disable no-console */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MonstheraContainer } from "../core/container.js";
import { resolveCodeRef } from "../core/code-refs.js";
import {
  isLegacyKnowledgeArticle,
  isLegacyWorkArticle,
} from "../core/article-trust.js";
import { WikiBookkeeper } from "../knowledge/wiki-bookkeeper.js";
import { parseMarkdown, serializeMarkdown } from "../knowledge/markdown.js";
import { formatError } from "./formatters.js";
import { parseFlag, withContainer } from "./arg-helpers.js";
import { MonstheraError, StorageError } from "../core/errors.js";

/**
 * Fail-fast for CLI doctor flows: previously these helpers re-threw a
 * fresh `Error(messageOnly)`, which discarded the structured error code
 * (STORAGE_ERROR, NOT_FOUND, etc.) and produced an unstructured stack
 * trace. Now we keep the original `MonstheraError`, render it via
 * `formatError`, and exit cleanly. The `never` return lets callers
 * narrow the post-call types without an extra `if`.
 */
function panicWithError(error: unknown, fallbackMessage: string): never {
  if (error instanceof MonstheraError) {
    console.error(formatError(error));
  } else {
    console.error(formatError(new StorageError(fallbackMessage, { cause: String(error) })));
  }
  process.exit(1);
}

type DoctorScope = "knowledge" | "work" | "all";
type RepairableArticleKind = "knowledge" | "work";
type LegacyArticleKind = "knowledge" | "work";

interface CurrentDocSeed {
  readonly sourcePath: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly recursive?: boolean;
}

interface RepairableArticle {
  readonly id: string;
  readonly title: string;
  readonly kind: RepairableArticleKind;
  readonly filePath: string;
  readonly staleRefs: readonly string[];
  readonly validRefs: readonly string[];
}

interface LegacyArticle {
  readonly id: string;
  readonly title: string;
  readonly kind: LegacyArticleKind;
  readonly filePath: string;
  readonly relativePath: string;
  readonly tags: readonly string[];
}

const CURRENT_DOC_SEEDS: readonly CurrentDocSeed[] = [
  {
    sourcePath: "MonstheraV3/README.md",
    category: "guide",
    tags: ["current-docs", "monsthera-v3"],
  },
  {
    sourcePath: "MonstheraV3/monsthera-architecture-v6-final.md",
    category: "architecture",
    tags: ["current-docs", "monsthera-v3"],
  },
  {
    sourcePath: "MonstheraV3/monsthera-v3-implementation-plan-final.md",
    category: "plan",
    tags: ["current-docs", "monsthera-v3"],
  },
  {
    sourcePath: "MonstheraV3/monsthera-ticket-as-article-design.md",
    category: "design",
    tags: ["current-docs", "monsthera-v3"],
  },
  {
    sourcePath: "docs/adrs",
    category: "architecture",
    tags: ["current-docs", "adr"],
    recursive: true,
  },
];

async function collectLegacyArticles(
  container: MonstheraContainer,
  scope: DoctorScope,
): Promise<LegacyArticle[]> {
  const markdownRoot = path.resolve(container.config.repoPath, container.config.storage.markdownRoot);
  const articles: LegacyArticle[] = [];

  if (scope === "knowledge" || scope === "all") {
    const knowledgeResult = await container.knowledgeRepo.findMany();
    if (!knowledgeResult.ok) panicWithError(knowledgeResult.error, "knowledge query failed");

    for (const article of knowledgeResult.value) {
      if (!isLegacyKnowledgeArticle(article)) continue;
      const relativePath = path.join("notes", `${article.slug}.md`);
      articles.push({
        id: article.id,
        title: article.title,
        kind: "knowledge",
        filePath: path.join(markdownRoot, relativePath),
        relativePath,
        tags: article.tags,
      });
    }
  }

  if (scope === "work" || scope === "all") {
    const workResult = await container.workRepo.findMany();
    if (!workResult.ok) panicWithError(workResult.error, "work query failed");

    for (const article of workResult.value) {
      if (!isLegacyWorkArticle(article)) continue;
      const relativePath = path.join("work-articles", `${article.id}.md`);
      articles.push({
        id: article.id,
        title: article.title,
        kind: "work",
        filePath: path.join(markdownRoot, relativePath),
        relativePath,
        tags: article.tags,
      });
    }
  }

  return articles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function codeRefExists(repoPath: string, codeRef: string): Promise<boolean> {
  try {
    await fs.access(resolveCodeRef(repoPath, codeRef));
    return true;
  } catch {
    return false;
  }
}

async function collectRepairableArticles(
  container: MonstheraContainer,
  scope: DoctorScope,
): Promise<RepairableArticle[]> {
  const markdownRoot = path.resolve(container.config.repoPath, container.config.storage.markdownRoot);
  const articles: RepairableArticle[] = [];

  if (scope === "knowledge" || scope === "all") {
    const knowledgeResult = await container.knowledgeRepo.findMany();
    if (!knowledgeResult.ok) panicWithError(knowledgeResult.error, "knowledge query failed");

    for (const article of knowledgeResult.value) {
      const staleRefs: string[] = [];
      const validRefs: string[] = [];
      for (const ref of article.codeRefs) {
        if (await codeRefExists(container.config.repoPath, ref)) {
          validRefs.push(ref);
        } else {
          staleRefs.push(ref);
        }
      }
      if (staleRefs.length === 0) continue;
      articles.push({
        id: article.id,
        title: article.title,
        kind: "knowledge",
        filePath: path.join(markdownRoot, "notes", `${article.slug}.md`),
        staleRefs,
        validRefs: [...new Set(validRefs)],
      });
    }
  }

  if (scope === "work" || scope === "all") {
    const workResult = await container.workRepo.findMany();
    if (!workResult.ok) panicWithError(workResult.error, "work query failed");

    for (const article of workResult.value) {
      const staleRefs: string[] = [];
      const validRefs: string[] = [];
      for (const ref of article.codeRefs) {
        if (await codeRefExists(container.config.repoPath, ref)) {
          validRefs.push(ref);
        } else {
          staleRefs.push(ref);
        }
      }
      if (staleRefs.length === 0) continue;
      articles.push({
        id: article.id,
        title: article.title,
        kind: "work",
        filePath: path.join(markdownRoot, "work-articles", `${article.id}.md`),
        staleRefs,
        validRefs: [...new Set(validRefs)],
      });
    }
  }

  return articles;
}

async function rewriteCodeRefs(article: RepairableArticle): Promise<void> {
  const raw = await fs.readFile(article.filePath, "utf-8");
  const parsed = parseMarkdown(raw);
  if (!parsed.ok) {
    panicWithError(parsed.error, `Failed to parse ${article.filePath}`);
  }

  const nextFrontmatter = {
    ...parsed.value.frontmatter,
    codeRefs: article.validRefs,
  };

  await fs.writeFile(article.filePath, serializeMarkdown(nextFrontmatter, parsed.value.body), "utf-8");
}

function printSample(articles: readonly RepairableArticle[]): void {
  const sample = articles.slice(0, 8);
  if (sample.length === 0) return;
  process.stdout.write("Sample stale refs:\n");
  for (const article of sample) {
    process.stdout.write(`  - [${article.kind}] ${article.id} — ${article.title}\n`);
    process.stdout.write(`    stale: ${article.staleRefs.join(", ")}\n`);
  }
  process.stdout.write("\n");
}

function printLegacySample(articles: readonly LegacyArticle[]): void {
  const sample = articles.slice(0, 8);
  if (sample.length === 0) return;
  process.stdout.write("Sample legacy articles:\n");
  for (const article of sample) {
    process.stdout.write(`  - [${article.kind}] ${article.id} — ${article.title}\n`);
    process.stdout.write(`    path: ${article.relativePath}\n`);
  }
  process.stdout.write("\n");
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "EXDEV") throw error;
    await fs.copyFile(sourcePath, destinationPath);
    await fs.rm(sourcePath, { force: true });
  }
}

async function archiveLegacyArticles(
  container: MonstheraContainer,
  legacyArticles: readonly LegacyArticle[],
): Promise<{ archiveRoot: string; knowledgeCount: number; workCount: number }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveRoot = path.resolve(
    container.config.repoPath,
    ".monsthera",
    "archive",
    `legacy-corpus-${stamp}`,
  );

  let knowledgeCount = 0;
  let workCount = 0;

  for (const article of legacyArticles) {
    const destinationPath = path.join(archiveRoot, article.relativePath);
    await moveFile(article.filePath, destinationPath);
    if (article.kind === "knowledge") knowledgeCount += 1;
    else workCount += 1;
  }

  const manifest = {
    archivedAt: new Date().toISOString(),
    repoPath: container.config.repoPath,
    archiveRoot,
    knowledgeCount,
    workCount,
    totalCount: legacyArticles.length,
    articles: legacyArticles.map((article) => ({
      id: article.id,
      title: article.title,
      kind: article.kind,
      relativePath: article.relativePath.split(path.sep).join("/"),
      tags: [...article.tags],
    })),
  };

  await fs.mkdir(archiveRoot, { recursive: true });
  await fs.writeFile(
    path.join(archiveRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );

  const clearResult = await container.searchRepo.clear();
  if (!clearResult.ok) {
    panicWithError(clearResult.error, "Failed to clear search index before reindex");
  }

  const reindexResult = await container.searchService.fullReindex();
  if (!reindexResult.ok) {
    panicWithError(reindexResult.error, "Failed to rebuild search index after archiving");
  }

  const knowledgeResult = await container.knowledgeRepo.findMany();
  if (!knowledgeResult.ok) panicWithError(knowledgeResult.error, "knowledge query failed");
  const workResult = await container.workRepo.findMany();
  if (!workResult.ok) panicWithError(workResult.error, "work query failed");

  const markdownRoot = path.resolve(container.config.repoPath, container.config.storage.markdownRoot);
  const bookkeeper = new WikiBookkeeper(markdownRoot, container.logger);
  await bookkeeper.rebuildIndex(knowledgeResult.value, workResult.value);
  await bookkeeper.appendLog("archive", "knowledge", `Archived ${knowledgeCount} legacy knowledge article(s)`);
  await bookkeeper.appendLog("archive", "work", `Archived ${workCount} legacy work article(s)`);

  return { archiveRoot, knowledgeCount, workCount };
}

async function seedCurrentDocs(container: MonstheraContainer): Promise<{
  importedCount: number;
  createdCount: number;
  updatedCount: number;
}> {
  let importedCount = 0;
  let createdCount = 0;
  let updatedCount = 0;

  for (const seed of CURRENT_DOC_SEEDS) {
    const result = await container.ingestService.importLocal({
      sourcePath: seed.sourcePath,
      category: seed.category,
      tags: [...seed.tags],
      mode: "summary",
      recursive: seed.recursive ?? false,
      replaceExisting: true,
    });
    if (!result.ok) {
      panicWithError(result.error, `Failed to seed ${seed.sourcePath}`);
    }
    importedCount += result.value.importedCount;
    createdCount += result.value.createdCount;
    updatedCount += result.value.updatedCount;
  }

  return { importedCount, createdCount, updatedCount };
}

export async function handleDoctor(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    process.stdout.write("Monsthera Doctor\n");
    process.stdout.write("================\n\n");

    const status = container.status.getStatus();

    process.stdout.write(`Version: ${status.version}\n`);
    process.stdout.write(`Uptime: ${Math.round(status.uptime / 1000)}s\n\n`);

    process.stdout.write("Subsystems:\n");
    let allHealthy = true;
    for (const sub of status.subsystems) {
      const icon = sub.healthy ? "[OK]" : "[FAIL]";
      if (!sub.healthy) allHealthy = false;
      process.stdout.write(`  ${icon} ${sub.name}${sub.detail ? ` — ${sub.detail}` : ""}\n`);
    }
    process.stdout.write("\n");

    const knowledgeResult = await container.knowledgeService.listArticles();
    const workResult = await container.workService.listWork();
    if (knowledgeResult.ok) {
      process.stdout.write(`Knowledge articles: ${knowledgeResult.value.length}\n`);
    }
    if (workResult.ok) {
      process.stdout.write(`Work articles: ${workResult.value.length}\n`);
    }
    process.stdout.write("\n");

    const scopeFlag = parseFlag(args, "--scope");
    const scope = (scopeFlag === "knowledge" || scopeFlag === "work" || scopeFlag === "all")
      ? scopeFlag
      : "all";
    const shouldFixStaleCodeRefs = args.includes("--fix-stale-code-refs");
    const shouldSeedCurrentDocs = args.includes("--seed-current-docs");
    const shouldArchiveLegacy = args.includes("--archive-legacy");

    const repairable = await collectRepairableArticles(container, scope);
    const staleRefCount = repairable.reduce((count, article) => count + article.staleRefs.length, 0);
    const knowledgeCount = repairable.filter((article) => article.kind === "knowledge").length;
    const workCount = repairable.filter((article) => article.kind === "work").length;

    const legacyKnowledge = knowledgeResult.ok
      ? knowledgeResult.value.filter((article) => isLegacyKnowledgeArticle(article)).length
      : 0;
    const legacyWork = workResult.ok
      ? workResult.value.filter((article) => isLegacyWorkArticle(article)).length
      : 0;
    const sourceLinkedKnowledge = knowledgeResult.ok
      ? knowledgeResult.value.filter((article) => Boolean(article.sourcePath)).length
      : 0;

    process.stdout.write("Stale code references:\n");
    process.stdout.write(`  Scope: ${scope}\n`);
    process.stdout.write(`  Articles with stale refs: ${repairable.length}\n`);
    process.stdout.write(`  Knowledge articles: ${knowledgeCount}\n`);
    process.stdout.write(`  Work articles: ${workCount}\n`);
    process.stdout.write(`  Total stale refs: ${staleRefCount}\n\n`);
    printSample(repairable);

    process.stdout.write("Knowledge trust signals:\n");
    process.stdout.write(`  Legacy-tagged knowledge: ${legacyKnowledge}\n`);
    process.stdout.write(`  Legacy-tagged work: ${legacyWork}\n`);
    process.stdout.write(`  Source-linked knowledge: ${sourceLinkedKnowledge}\n\n`);

    const legacyArticles = await collectLegacyArticles(container, scope);
    process.stdout.write("Legacy migration corpus:\n");
    process.stdout.write(`  Scope: ${scope}\n`);
    process.stdout.write(`  Legacy articles in active corpus: ${legacyArticles.length}\n`);
    process.stdout.write(`  Legacy knowledge articles: ${legacyArticles.filter((article) => article.kind === "knowledge").length}\n`);
    process.stdout.write(`  Legacy work articles: ${legacyArticles.filter((article) => article.kind === "work").length}\n\n`);
    printLegacySample(legacyArticles);

    if (shouldSeedCurrentDocs) {
      process.stdout.write("Seeding current docs into knowledge...\n");
      const seeded = await seedCurrentDocs(container);
      process.stdout.write(
        `Seeded current docs: imported ${seeded.importedCount}, created ${seeded.createdCount}, updated ${seeded.updatedCount}.\n\n`,
      );
    }

    if (shouldFixStaleCodeRefs && repairable.length > 0) {
      process.stdout.write("Pruning stale code refs...\n");
      for (const article of repairable) {
        await rewriteCodeRefs(article);
      }

      const reindexResult = await container.searchService.fullReindex();
      if (!reindexResult.ok) {
        console.error(formatError(reindexResult.error));
        process.exit(1);
      }

      process.stdout.write(
        `Pruned stale refs from ${repairable.length} article(s) and rebuilt the search index.\n\n`,
      );
    }

    if (shouldArchiveLegacy && legacyArticles.length > 0) {
      process.stdout.write("Archiving legacy migration corpus...\n");
      const archived = await archiveLegacyArticles(container, legacyArticles);
      process.stdout.write(
        `Archived ${archived.knowledgeCount} knowledge and ${archived.workCount} work article(s) to ${archived.archiveRoot}.\n\n`,
      );
    }

    if (allHealthy) {
      process.stdout.write("All systems healthy.\n");
    } else {
      process.stdout.write("Some subsystems are unhealthy. Check configuration.\n");
      process.exit(1);
    }
  });
}
