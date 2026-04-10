import type { KnowledgeArticle } from "../knowledge/repository.js";
import type { WorkArticle } from "../work/repository.js";

const LEGACY_TAG_PREFIXES = ["v2-source:", "v2:", "migration-hash:"];
const LEGACY_QUERY_RE = /\b(?:agora|legacy|v2|tkt-[a-z0-9]+)\b/i;

export function hasLegacyTag(tags: readonly string[]): boolean {
  return tags.some((tag) => LEGACY_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix)));
}

export function isLegacyKnowledgeArticle(article: Pick<KnowledgeArticle, "tags">): boolean {
  return hasLegacyTag(article.tags);
}

export function isLegacyWorkArticle(article: Pick<WorkArticle, "tags" | "author">): boolean {
  return article.author === "migration" || hasLegacyTag(article.tags);
}

export function isLegacyQuery(query: string): boolean {
  return LEGACY_QUERY_RE.test(query);
}
