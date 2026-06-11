import { inspectKnowledgeArticle, inspectWorkArticle } from "../context/insights.js";
import type { KnowledgeArticle } from "../knowledge/repository.js";
import type { WorkArticle } from "../work/repository.js";
import { codeRefExists } from "./code-ref-indexer.js";
import type {
  SourceNewerEntry,
  StaleArticleEntry,
  StaleCodeRefEntry,
  StalenessReport,
} from "./service.js";

// ─── Staleness report assembly ─────────────────────────────────────────────
// Whole-corpus staleness scan: stale articles, dangling codeRefs, and
// source-newer re-import candidates. `StructureService.buildStalenessReport`
// fetches the repositories and delegates here. Bodies are moved verbatim
// from the original src/structure/service.ts.

/**
 * Scan both article sets for the three staleness signals. Reuses
 * `inspectKnowledgeArticle` / `inspectWorkArticle` (the same freshness
 * logic `buildContextPack` applies per item) and `codeRefExists`, so the
 * report can never drift from those surfaces.
 */
export async function buildStalenessReportFromArticles(
  knowledgeArticles: readonly KnowledgeArticle[],
  workArticles: readonly WorkArticle[],
  repoPath: string,
): Promise<StalenessReport> {
  const staleArticles: StaleArticleEntry[] = [];
  const staleCodeRefs: StaleCodeRefEntry[] = [];
  const sourceNewer: SourceNewerEntry[] = [];

  for (const article of knowledgeArticles) {
    const diagnostics = await inspectKnowledgeArticle(article, { repoPath });
    if (diagnostics.freshness.state === "stale") {
      staleArticles.push({
        id: article.id,
        type: "knowledge",
        title: article.title,
        slug: article.slug,
        ageDays: diagnostics.freshness.ageDays,
        detail: diagnostics.freshness.detail,
        sourcePath: article.sourcePath,
      });
    }
    if (diagnostics.freshness.sourceSyncState === "source-newer" && article.sourcePath) {
      sourceNewer.push({
        id: article.id,
        title: article.title,
        slug: article.slug,
        sourcePath: article.sourcePath,
        sourceUpdatedAt: diagnostics.freshness.sourceUpdatedAt,
        articleUpdatedAt: article.updatedAt,
      });
    }
    for (const codeRef of article.codeRefs) {
      if (!(await codeRefExists(repoPath, codeRef))) {
        staleCodeRefs.push({ articleId: article.id, type: "knowledge", title: article.title, codeRef });
      }
    }
  }

  for (const article of workArticles) {
    const diagnostics = inspectWorkArticle(article);
    if (diagnostics.freshness.state === "stale") {
      staleArticles.push({
        id: article.id,
        type: "work",
        title: article.title,
        ageDays: diagnostics.freshness.ageDays,
        detail: diagnostics.freshness.detail,
      });
    }
    for (const codeRef of article.codeRefs) {
      if (!(await codeRefExists(repoPath, codeRef))) {
        staleCodeRefs.push({ articleId: article.id, type: "work", title: article.title, codeRef });
      }
    }
  }

  staleArticles.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

  return {
    staleArticles,
    staleCodeRefs,
    sourceNewer,
    summary: {
      knowledgeScanned: knowledgeArticles.length,
      workScanned: workArticles.length,
      staleArticleCount: staleArticles.length,
      staleCodeRefCount: staleCodeRefs.length,
      sourceNewerCount: sourceNewer.length,
    },
  };
}
