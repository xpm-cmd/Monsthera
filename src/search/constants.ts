export const DEFAULT_SEMANTIC_BLEND_ALPHA = 0.5;

export const DEFAULT_FILE_BM25_WEIGHTS = {
  path: 1.5,
  summary: 1.0,
  symbols: 2.0,
} as const;

export const DEFAULT_TICKET_BM25_WEIGHTS = {
  ticketId: 2.5,
  title: 3.0,
  description: 1.0,
  tags: 2.0,
} as const;

export const DEFAULT_KNOWLEDGE_BM25_WEIGHTS = {
  title: 3.0,
  content: 1.0,
} as const;

export const DEFAULT_TEST_FILE_PENALTY_FACTOR = 0.4;
export const DEFAULT_CONFIG_FILE_PENALTY_FACTOR = 0.5;
export const DEFAULT_MIN_RELEVANCE_SCORE = 0.35;
export const DEFAULT_MIN_RELEVANCE_SCORE_SCOPED = 0.20;
export const DEFAULT_KNOWLEDGE_VECTOR_MIN_SCORE = 0.45;
export const DEFAULT_AND_QUERY_TERM_THRESHOLD = 3;

export const FTS5_ONLY_PENALTY_FACTOR = 0.8;
export const VECTOR_ONLY_PENALTY_FACTOR = 0.8;
export const SCOPED_VECTOR_ONLY_PENALTY_FACTOR = 0.85;

export interface SearchConfigShape {
  semanticBlendAlpha: number;
  bm25: {
    file: {
      path: number;
      summary: number;
      symbols: number;
    };
    ticket: {
      ticketId: number;
      title: number;
      description: number;
      tags: number;
    };
    knowledge: {
      title: number;
      content: number;
    };
  };
  penalties: {
    testFiles: number;
    configFiles: number;
  };
  thresholds: {
    relevance: number;
    scopedRelevance: number;
    knowledgeVectorMinScore: number;
    andQueryTermCount: number;
  };
}

export const DEFAULT_SEARCH_CONFIG: SearchConfigShape = {
  semanticBlendAlpha: DEFAULT_SEMANTIC_BLEND_ALPHA,
  bm25: {
    file: { ...DEFAULT_FILE_BM25_WEIGHTS },
    ticket: { ...DEFAULT_TICKET_BM25_WEIGHTS },
    knowledge: { ...DEFAULT_KNOWLEDGE_BM25_WEIGHTS },
  },
  penalties: {
    testFiles: DEFAULT_TEST_FILE_PENALTY_FACTOR,
    configFiles: DEFAULT_CONFIG_FILE_PENALTY_FACTOR,
  },
  thresholds: {
    relevance: DEFAULT_MIN_RELEVANCE_SCORE,
    scopedRelevance: DEFAULT_MIN_RELEVANCE_SCORE_SCOPED,
    knowledgeVectorMinScore: DEFAULT_KNOWLEDGE_VECTOR_MIN_SCORE,
    andQueryTermCount: DEFAULT_AND_QUERY_TERM_THRESHOLD,
  },
};
