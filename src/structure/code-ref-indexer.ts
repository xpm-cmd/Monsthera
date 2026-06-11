import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizeCodeRefPath, resolveCodeRef } from "../core/code-refs.js";
import type { KnowledgeArticle } from "../knowledge/repository.js";
import type { WorkArticle } from "../work/repository.js";
import type { CodeRefOwnerIndex, StructureGraphEdge, StructureGraphNode } from "./service.js";

// ─── Code-ref indexing ─────────────────────────────────────────────────────
// Code-ref → owner indexing, on-disk existence checks, and the code-node /
// code_ref-edge portion of the structure graph. Repository fetches stay in
// `StructureService`, which delegates here with explicit inputs. Bodies are
// moved verbatim from the original src/structure/service.ts.

/** Whether `codeRef` (path, optional `#L<line>` anchor) resolves to a file on disk under `repoPath`. */
export async function codeRefExists(repoPath: string, codeRef: string): Promise<boolean> {
  const resolved = resolveCodeRef(repoPath, codeRef);

  try {
    await fs.access(resolved);
    return true;
  } catch {
    return false;
  }
}

/**
 * Index code-ref strings to their owning articles by the comparable
 * normalized form (line anchors stripped, leading `./` removed, trailing
 * `/` removed). Node IDs use the same `k:` / `w:` prefix convention as the
 * structure graph. `StructureService.buildCodeRefOwnerIndex` supplies the
 * article arrays.
 */
export function buildCodeRefOwnerIndexFromArticles(
  knowledgeArticles: readonly KnowledgeArticle[],
  workArticles: readonly WorkArticle[],
): CodeRefOwnerIndex {
  const byRef = new Map<string, Set<string>>();
  const knowledgeById = new Map<string, KnowledgeArticle>();
  const workById = new Map<string, WorkArticle>();

  const remember = (nodeId: string, refs: readonly string[] | undefined): void => {
    for (const ref of refs ?? []) {
      const normalized = normalizeCodeRefPath(ref);
      if (!normalized) continue;
      let bucket = byRef.get(normalized);
      if (!bucket) {
        bucket = new Set();
        byRef.set(normalized, bucket);
      }
      bucket.add(nodeId);
    }
  };

  for (const article of knowledgeArticles) {
    const nodeId = `k:${article.id}`;
    knowledgeById.set(nodeId, article);
    remember(nodeId, article.codeRefs);
  }
  for (const article of workArticles) {
    const nodeId = `w:${article.id}`;
    workById.set(nodeId, article);
    remember(nodeId, article.codeRefs);
  }

  return { byRef, knowledgeById, workById };
}

/** Result of `assembleCodeGraphNodes`: code nodes, their `code_ref` edges, and per-ref existence. */
export interface CodeGraphAssembly {
  readonly nodes: readonly StructureGraphNode[];
  readonly edges: readonly StructureGraphEdge[];
  readonly codeExistenceEntries: ReadonlyArray<{ readonly codeRef: string; readonly exists: boolean }>;
}

/**
 * Build one `code` node per referenced path (annotated with on-disk
 * existence) and one `code_ref` edge per owning article. `codeRefOwners`
 * maps each raw code ref to its owning node IDs, as collected by
 * `StructureService.getGraph`. Node/edge insertion order matches the
 * original inline loop, so graph output ordering is unchanged.
 */
export async function assembleCodeGraphNodes(
  repoPath: string,
  codeRefOwners: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<CodeGraphAssembly> {
  const codeExistenceEntries = await Promise.all(
    [...codeRefOwners.keys()].map(async (codeRef) => ({
      codeRef,
      exists: await codeRefExists(repoPath, codeRef),
    })),
  );
  const codeExistence = new Map(codeExistenceEntries.map((entry) => [entry.codeRef, entry.exists]));

  const nodes: StructureGraphNode[] = [];
  const edges: StructureGraphEdge[] = [];

  for (const [codeRef, ownerIds] of codeRefOwners) {
    const codeNodeId = `c:${codeRef}`;
    nodes.push({
      id: codeNodeId,
      kind: "code",
      label: path.basename(codeRef),
      path: codeRef,
      exists: codeExistence.get(codeRef) ?? false,
    });

    for (const ownerId of ownerIds) {
      edges.push({
        id: `code_ref:${ownerId}->${codeNodeId}`,
        source: ownerId,
        target: codeNodeId,
        kind: "code_ref",
        label: "codeRef",
      });
    }
  }

  return { nodes, edges, codeExistenceEntries };
}
