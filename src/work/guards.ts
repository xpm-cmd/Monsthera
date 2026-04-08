import type { WorkArticle } from "./repository.js";

// ─── Content Guards ───

export function has_objective(article: WorkArticle): boolean {
  return article.content.includes("## Objective");
}

export function has_acceptance_criteria(article: WorkArticle): boolean {
  return article.content.includes("## Acceptance Criteria");
}

// ─── Enrichment Guards ───

// Note: the lifecycle layer will call this with the template's minEnrichmentCount
export function min_enrichment_met(article: WorkArticle, min: number): boolean {
  const count = article.enrichmentRoles.filter(
    (r) => r.status === "contributed" || r.status === "skipped"
  ).length;
  return count >= min;
}

// ─── Implementation Guards ───

export function implementation_linked(article: WorkArticle): boolean {
  return article.content.includes("## Implementation");
}

// ─── Review Guards ───

// Empty reviewers array returns false (no reviewers = not approved)
export function all_reviewers_approved(article: WorkArticle): boolean {
  return article.reviewers.length > 0 && article.reviewers.every((r) => r.status === "approved");
}
