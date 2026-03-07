export interface SearchResult {
  path: string;
  score: number;
  matchLines?: number[];
  snippet?: string;
}

export type SearchBackendName = "fts5" | "zoekt" | "fts5+semantic" | "zoekt+semantic";

export interface SearchBackend {
  readonly name: "fts5" | "zoekt";
  search(query: string, repoId: number, limit?: number): Promise<SearchResult[]>;
  isAvailable(): Promise<boolean>;
}
