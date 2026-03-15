import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { getImportGraph } from "../db/queries.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface CouplingMetrics {
  path: string;
  afferentCoupling: number;   // Ca: who depends on me (inbound edges)
  efferentCoupling: number;   // Ce: what I depend on (outbound edges)
  instability: number;         // Ce / (Ca + Ce), 0=maximally stable, 1=maximally unstable
  totalCoupling: number;       // Ca + Ce
}

export type CouplingSortBy = "instability" | "totalCoupling" | "afferent" | "efferent";

export function analyzeCoupling(
  db: DB,
  repoId: number,
  opts?: { scope?: string; sortBy?: CouplingSortBy; limit?: number },
): CouplingMetrics[] {
  const graph = getImportGraph(db, repoId, { scope: opts?.scope });
  if (graph.files.length === 0) return [];

  // Build path lookup
  const idToPath = new Map(graph.files.map((f) => [f.id, f.path]));

  // Count afferent (inbound) and efferent (outbound) coupling per file
  const afferent = new Map<string, number>();
  const efferent = new Map<string, number>();

  for (const file of graph.files) {
    afferent.set(file.path, 0);
    efferent.set(file.path, 0);
  }

  for (const edge of graph.edges) {
    const sourcePath = idToPath.get(edge.source);
    const targetPath = idToPath.get(edge.target);
    if (sourcePath && targetPath && sourcePath !== targetPath) {
      efferent.set(sourcePath, (efferent.get(sourcePath) ?? 0) + 1);
      afferent.set(targetPath, (afferent.get(targetPath) ?? 0) + 1);
    }
  }

  const metrics: CouplingMetrics[] = graph.files.map((file) => {
    const ca = afferent.get(file.path) ?? 0;
    const ce = efferent.get(file.path) ?? 0;
    const total = ca + ce;
    return {
      path: file.path,
      afferentCoupling: ca,
      efferentCoupling: ce,
      instability: total > 0 ? ce / total : 0,
      totalCoupling: total,
    };
  });

  // Sort
  const sortBy = opts?.sortBy ?? "totalCoupling";
  const sortFn: (a: CouplingMetrics, b: CouplingMetrics) => number =
    sortBy === "instability"
      ? (a, b) => b.instability - a.instability || b.totalCoupling - a.totalCoupling
      : sortBy === "afferent"
        ? (a, b) => b.afferentCoupling - a.afferentCoupling
        : sortBy === "efferent"
          ? (a, b) => b.efferentCoupling - a.efferentCoupling
          : (a, b) => b.totalCoupling - a.totalCoupling;

  metrics.sort(sortFn);

  const limit = opts?.limit ?? 20;
  return metrics.slice(0, limit);
}
