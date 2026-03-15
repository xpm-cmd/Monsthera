import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { getImportGraph } from "../db/queries.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface DependencyCycle {
  path: string[];   // [A, B, C, A] — the cycle chain ending with the start node
  length: number;   // number of edges in the cycle
}

/**
 * Find circular import chains using DFS with color marking.
 * Returns deduplicated cycles, capped at maxCycles.
 */
export function findDependencyCycles(
  db: DB,
  repoId: number,
  opts?: { scope?: string; maxCycles?: number },
): DependencyCycle[] {
  const graph = getImportGraph(db, repoId, { scope: opts?.scope });
  if (graph.files.length === 0) return [];

  const maxCycles = opts?.maxCycles ?? 50;

  // Build adjacency list using paths for readability
  const idToPath = new Map(graph.files.map((f) => [f.id, f.path]));
  const adj = new Map<string, string[]>();

  for (const file of graph.files) {
    adj.set(file.path, []);
  }

  for (const edge of graph.edges) {
    const sourcePath = idToPath.get(edge.source);
    const targetPath = idToPath.get(edge.target);
    if (sourcePath && targetPath && sourcePath !== targetPath) {
      adj.get(sourcePath)!.push(targetPath);
    }
  }

  // DFS with color marking
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const dfsStack: string[] = [];
  const cycles: DependencyCycle[] = [];
  const seenNormalized = new Set<string>();

  for (const node of adj.keys()) {
    color.set(node, WHITE);
  }

  function dfs(node: string): void {
    if (cycles.length >= maxCycles) return;

    color.set(node, GRAY);
    dfsStack.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (cycles.length >= maxCycles) break;

      const neighborColor = color.get(neighbor) ?? WHITE;
      if (neighborColor === GRAY) {
        // Back edge found — extract cycle
        const cycleStart = dfsStack.indexOf(neighbor);
        if (cycleStart >= 0) {
          const cyclePath = [...dfsStack.slice(cycleStart), neighbor];
          const normalized = normalizeCycle(cyclePath);
          if (!seenNormalized.has(normalized)) {
            seenNormalized.add(normalized);
            cycles.push({
              path: cyclePath,
              length: cyclePath.length - 1,
            });
          }
        }
      } else if (neighborColor === WHITE) {
        dfs(neighbor);
      }
    }

    dfsStack.pop();
    color.set(node, BLACK);
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE && cycles.length < maxCycles) {
      dfs(node);
    }
  }

  // Sort by cycle length (shorter cycles are more actionable)
  cycles.sort((a, b) => a.length - b.length);

  return cycles;
}

/**
 * Normalize a cycle for deduplication.
 * Rotate so the lexicographically smallest element is first.
 * [A, B, C, A] and [B, C, A, B] are the same cycle.
 */
function normalizeCycle(cyclePath: string[]): string {
  // Remove the trailing repeated element
  const nodes = cyclePath.slice(0, -1);
  if (nodes.length === 0) return "";

  // Find the index of the smallest element
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i]! < nodes[minIdx]!) {
      minIdx = i;
    }
  }

  // Rotate so smallest is first
  const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
  return rotated.join("→");
}
