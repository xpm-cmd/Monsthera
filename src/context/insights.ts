import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { KnowledgeArticle } from "../knowledge/repository.js";
import type { WorkArticle } from "../work/repository.js";
import { getTemplateConfig } from "../work/templates.js";

export type ContextFreshnessState = "fresh" | "attention" | "stale" | "unknown";
export type SourceSyncState = "not-imported" | "synced" | "source-newer" | "missing-source";
export type ContextPackMode = "general" | "code" | "research";

export interface ContextFreshness {
  readonly state: ContextFreshnessState;
  readonly label: string;
  readonly detail: string;
  readonly ageDays?: number;
  readonly sourceSyncState?: SourceSyncState;
  readonly sourceUpdatedAt?: string;
}

export interface ContextQuality {
  readonly score: number;
  readonly label: string;
  readonly summary: string;
}

export interface KnowledgeContextDiagnostics {
  readonly freshness: ContextFreshness;
  readonly quality: ContextQuality;
  readonly signals: {
    readonly tagCount: number;
    readonly codeRefCount: number;
    readonly contentLength: number;
    readonly hasSourcePath: boolean;
    readonly sourceSyncState: SourceSyncState;
  };
  readonly recommendedFor: readonly ContextPackMode[];
}

export interface WorkContextDiagnostics {
  readonly freshness: ContextFreshness;
  readonly quality: ContextQuality;
  readonly signals: {
    readonly requiredSectionsCovered: number;
    readonly requiredSectionsTotal: number;
    readonly referenceCount: number;
    readonly codeRefCount: number;
    readonly hasOwner: boolean;
    readonly hasAssignee: boolean;
    readonly hasReviewers: boolean;
  };
  readonly recommendedFor: readonly ContextPackMode[];
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function qualityLabel(score: number): string {
  if (score >= 85) return "excellent";
  if (score >= 70) return "strong";
  if (score >= 55) return "good";
  if (score >= 35) return "fair";
  return "weak";
}

function ageDaysFrom(updatedAt?: string): number | undefined {
  if (!updatedAt) return undefined;
  const time = new Date(updatedAt).getTime();
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function freshnessFromAge(ageDays: number | undefined): ContextFreshness {
  if (ageDays === undefined) {
    return { state: "unknown", label: "unknown", detail: "Updated time is unavailable." };
  }
  if (ageDays <= 14) {
    return { state: "fresh", label: "fresh", detail: `Updated ${ageDays} day(s) ago.`, ageDays };
  }
  if (ageDays <= 45) {
    return { state: "attention", label: "attention", detail: `Updated ${ageDays} day(s) ago.`, ageDays };
  }
  return { state: "stale", label: "stale", detail: `Updated ${ageDays} day(s) ago.`, ageDays };
}

async function inspectSourceSync(
  repoPath: string | undefined,
  sourcePath: string | undefined,
  updatedAt: string,
): Promise<{ state: SourceSyncState; sourceUpdatedAt?: string }> {
  if (!sourcePath) return { state: "not-imported" };
  if (!repoPath) return { state: "not-imported" };

  const resolvedPath = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.resolve(repoPath, sourcePath);

  try {
    const stats = await fs.stat(resolvedPath);
    const sourceUpdatedAt = stats.mtime.toISOString();
    const articleUpdated = new Date(updatedAt).getTime();
    const sourceUpdated = stats.mtime.getTime();
    if (Number.isFinite(articleUpdated) && sourceUpdated > articleUpdated + 60_000) {
      return { state: "source-newer", sourceUpdatedAt };
    }
    return { state: "synced", sourceUpdatedAt };
  } catch {
    return { state: "missing-source" };
  }
}

export async function inspectKnowledgeArticle(
  article: KnowledgeArticle,
  opts?: { repoPath?: string },
): Promise<KnowledgeContextDiagnostics> {
  const ageDays = ageDaysFrom(article.updatedAt);
  const sourceSync = await inspectSourceSync(opts?.repoPath, article.sourcePath, article.updatedAt);

  let freshness = freshnessFromAge(ageDays);
  if (sourceSync.state === "source-newer") {
    freshness = {
      state: "stale",
      label: "source newer",
      detail: "The linked source file has changed since this article was last updated.",
      ageDays,
      sourceSyncState: sourceSync.state,
      sourceUpdatedAt: sourceSync.sourceUpdatedAt,
    };
  } else if (sourceSync.state === "synced") {
    freshness = {
      ...freshness,
      detail: freshness.state === "fresh"
        ? "Imported source is in sync and recently updated."
        : freshness.detail,
      sourceSyncState: sourceSync.state,
      sourceUpdatedAt: sourceSync.sourceUpdatedAt,
    };
  } else {
    freshness = {
      ...freshness,
      sourceSyncState: sourceSync.state,
      sourceUpdatedAt: sourceSync.sourceUpdatedAt,
    };
  }

  const contentLength = article.content.trim().length;
  const score = clamp(
    Math.min(35, Math.round(contentLength / 18))
    + Math.min(20, article.codeRefs.length * 8)
    + Math.min(10, article.tags.length * 3)
    + (article.sourcePath ? 15 : 0)
    + (freshness.state === "fresh" ? 20 : freshness.state === "attention" ? 10 : freshness.state === "unknown" ? 5 : 0),
  );
  const label = qualityLabel(score);

  const recommendedFor = new Set<ContextPackMode>(["general"]);
  if (
    article.codeRefs.length > 0
    || ["architecture", "engineering", "solution", "runbook"].includes(article.category.toLowerCase())
  ) {
    recommendedFor.add("code");
  }
  if (
    article.sourcePath
    || contentLength >= 600
    || ["context", "guide", "runbook", "solution", "research"].includes(article.category.toLowerCase())
  ) {
    recommendedFor.add("research");
  }

  return {
    freshness,
    quality: {
      score,
      label,
      summary:
        score >= 70
          ? "Rich context with enough structure to reuse quickly."
          : score >= 45
            ? "Useful context, but it would benefit from more code refs, tags, or fresher updates."
            : "Thin context. Add references, richer content, or refresh the source.",
    },
    signals: {
      tagCount: article.tags.length,
      codeRefCount: article.codeRefs.length,
      contentLength,
      hasSourcePath: Boolean(article.sourcePath),
      sourceSyncState: sourceSync.state,
    },
    recommendedFor: [...recommendedFor],
  };
}

export function inspectWorkArticle(article: WorkArticle): WorkContextDiagnostics {
  const ageDays = ageDaysFrom(article.updatedAt);
  const freshness = freshnessFromAge(ageDays);
  const template = getTemplateConfig(article.template);
  const requiredSectionsCovered = template.requiredSections.filter((section) => article.content.includes(`## ${section}`)).length;
  const hasOwner = Boolean(article.lead || article.assignee);
  const hasAssignee = Boolean(article.assignee);
  const hasReviewers = article.reviewers.length > 0;

  const score = clamp(
    Math.round((requiredSectionsCovered / Math.max(template.requiredSections.length, 1)) * 35)
    + Math.min(15, article.references.length * 7)
    + Math.min(15, article.codeRefs.length * 7)
    + (hasOwner ? 10 : 0)
    + (hasAssignee ? 10 : 0)
    + (article.content.includes("## Implementation") ? 5 : 0)
    + (hasReviewers ? 10 : 0),
  );
  const label = qualityLabel(score);

  const recommendedFor = new Set<ContextPackMode>(["general"]);
  if (
    article.codeRefs.length > 0
    || article.content.includes("## Implementation")
    || ["feature", "bugfix", "refactor"].includes(article.template)
  ) {
    recommendedFor.add("code");
  }
  if (article.template === "spike" || article.references.length > 0 || article.phase === "planning" || article.phase === "enrichment") {
    recommendedFor.add("research");
  }

  return {
    freshness,
    quality: {
      score,
      label,
      summary:
        score >= 70
          ? "Strong execution contract for handoff or implementation."
          : score >= 45
            ? "Partially usable contract, but missing context or ownership."
            : "Weak contract. Tighten scope, sections, and context before handing off.",
    },
    signals: {
      requiredSectionsCovered,
      requiredSectionsTotal: template.requiredSections.length,
      referenceCount: article.references.length,
      codeRefCount: article.codeRefs.length,
      hasOwner,
      hasAssignee,
      hasReviewers,
    },
    recommendedFor: [...recommendedFor],
  };
}
