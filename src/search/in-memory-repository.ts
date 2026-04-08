import { ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { StorageError } from "../core/errors.js";
import type { SearchIndexRepository, SearchOptions, SearchResult } from "./repository.js";
import { tokenize } from "./tokenizer.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface IndexedDocument {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly type: "knowledge" | "work";
}

// ---------------------------------------------------------------------------
// BM25-lite constants
// ---------------------------------------------------------------------------

const BM25_K1 = 1.2;
const TITLE_BOOST = 3.0;
const SNIPPET_RADIUS = 80;
const SNIPPET_MAX_FALLBACK = 160;
const DEFAULT_LIMIT = 20;
const DEFAULT_OFFSET = 0;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class InMemorySearchIndexRepository implements SearchIndexRepository {
  private readonly documents = new Map<string, IndexedDocument>();

  /** term → set of doc IDs */
  private readonly invertedIndex = new Map<string, Set<string>>();

  /** id → set of terms from title (for title boost during scoring) */
  private readonly titleTerms = new Map<string, Set<string>>();

  // -------------------------------------------------------------------------
  // indexArticle
  // -------------------------------------------------------------------------

  async indexArticle(
    id: string,
    title: string,
    content: string,
    type: "knowledge" | "work",
  ): Promise<Result<void, StorageError>> {
    // If the document already exists, remove it first (upsert semantics)
    if (this.documents.has(id)) {
      this.removeFromIndex(id);
    }

    const doc: IndexedDocument = { id, title, content, type };
    this.documents.set(id, doc);

    // Index title terms
    const titleTokens = tokenize(title);
    this.titleTerms.set(id, new Set(titleTokens));

    // Index combined title + content terms
    const allTokens = [...titleTokens, ...tokenize(content)];
    for (const term of allTokens) {
      let postings = this.invertedIndex.get(term);
      if (postings === undefined) {
        postings = new Set<string>();
        this.invertedIndex.set(term, postings);
      }
      postings.add(id);
    }

    return ok(undefined);
  }

  // -------------------------------------------------------------------------
  // removeArticle
  // -------------------------------------------------------------------------

  async removeArticle(id: string): Promise<Result<void, StorageError>> {
    // Idempotent — no error if the document doesn't exist
    if (this.documents.has(id)) {
      this.removeFromIndex(id);
      this.documents.delete(id);
    }
    return ok(undefined);
  }

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  async search(options: SearchOptions): Promise<Result<SearchResult[], StorageError>> {
    const { query, type, limit = DEFAULT_LIMIT, offset = DEFAULT_OFFSET } = options;

    // Empty / whitespace-only query → no results
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) {
      return ok([]);
    }

    // Gather candidate doc IDs from inverted index
    const candidateIds = new Set<string>();
    for (const term of queryTerms) {
      const postings = this.invertedIndex.get(term);
      if (postings !== undefined) {
        for (const docId of postings) {
          candidateIds.add(docId);
        }
      }
    }

    // Score candidates
    const N = this.documents.size;
    const scored: Array<{ doc: IndexedDocument; score: number }> = [];

    for (const docId of candidateIds) {
      const doc = this.documents.get(docId);
      if (doc === undefined) continue;

      // Apply type filter
      if (type !== undefined && type !== "all" && doc.type !== type) continue;

      const score = this.bm25Score(doc, queryTerms, N);
      scored.push({ doc, score });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Apply offset + limit and build results
    const page = scored.slice(offset, offset + limit);
    const results: SearchResult[] = page.map(({ doc, score }) => ({
      id: doc.id,
      title: doc.title,
      type: doc.type,
      score,
      snippet: generateSnippet(doc.content, queryTerms),
    }));

    return ok(results);
  }

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  async clear(): Promise<Result<void, StorageError>> {
    this.documents.clear();
    this.invertedIndex.clear();
    this.titleTerms.clear();
    return ok(undefined);
  }


  // -------------------------------------------------------------------------
  // reindex
  // -------------------------------------------------------------------------

  async reindex(): Promise<Result<void, StorageError>> {
    // Rebuild derived index structures from stored documents
    this.invertedIndex.clear();
    this.titleTerms.clear();

    for (const doc of this.documents.values()) {
      const titleTokens = tokenize(doc.title);
      this.titleTerms.set(doc.id, new Set(titleTokens));

      const allTokens = [...titleTokens, ...tokenize(doc.content)];
      for (const term of allTokens) {
        let postings = this.invertedIndex.get(term);
        if (postings === undefined) {
          postings = new Set<string>();
          this.invertedIndex.set(term, postings);
        }
        postings.add(doc.id);
      }
    }

    return ok(undefined);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Remove a document from all inverted-index entries and title terms map. */
  private removeFromIndex(id: string): void {
    // Remove from title terms map
    this.titleTerms.delete(id);

    // Remove this doc from every postings list it appears in
    for (const [term, postings] of this.invertedIndex) {
      postings.delete(id);
      if (postings.size === 0) {
        this.invertedIndex.delete(term);
      }
    }
  }

  /** BM25-lite scoring with title boost. */
  private bm25Score(doc: IndexedDocument, queryTerms: string[], N: number): number {
    // Pre-compute term frequencies in the combined token stream
    const allText = `${doc.title} ${doc.content}`;
    const docTokens = tokenize(allText);
    const termFrequencies = new Map<string, number>();
    for (const token of docTokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }

    const docTitleTerms = this.titleTerms.get(doc.id) ?? new Set<string>();
    let totalScore = 0;

    for (const term of queryTerms) {
      const tf = termFrequencies.get(term) ?? 0;
      if (tf === 0) continue;

      const df = this.invertedIndex.get(term)?.size ?? 0;
      const saturatedTf = tf / (tf + BM25_K1);
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      const fieldBoost = docTitleTerms.has(term) ? TITLE_BOOST : 1.0;

      totalScore += saturatedTf * idf * fieldBoost;
    }

    return totalScore;
  }
}

// ---------------------------------------------------------------------------
// Snippet generation (module-level pure function)
// ---------------------------------------------------------------------------

function generateSnippet(content: string, queryTerms: string[]): string {
  if (content.length === 0) return "";

  const lower = content.toLowerCase();

  // Find the first occurrence of any query term
  let firstMatchIndex = -1;
  for (const term of queryTerms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (firstMatchIndex === -1 || idx < firstMatchIndex)) {
      firstMatchIndex = idx;
    }
  }

  if (firstMatchIndex === -1) {
    // No match in content — return the first 160 chars
    const fallback = content.slice(0, SNIPPET_MAX_FALLBACK);
    return content.length > SNIPPET_MAX_FALLBACK ? `${fallback}...` : fallback;
  }

  const start = Math.max(0, firstMatchIndex - SNIPPET_RADIUS);
  const end = Math.min(content.length, firstMatchIndex + SNIPPET_RADIUS);
  const snippet = content.slice(start, end);

  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${snippet}${suffix}`;
}
