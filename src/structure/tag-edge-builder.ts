import type { StructureGraphEdge, StructureGraphNode } from "./service.js";

// ─── Shared-tag edge assembly ──────────────────────────────────────────────
// Three-tier shared-tag fan-out control: pairwise edges for small tags, a
// hub node for medium tags, omission for ubiquitous tags. `StructureService.
// getGraph` collects the tag buckets and delegates here. Bodies are moved
// verbatim from the original src/structure/service.ts.

/** Tags shared by up to this many articles get full pairwise edges. */
const SHARED_TAG_DIRECT_THRESHOLD = 15;
/** Tags shared by up to this many articles get a hub node instead of pairwise edges. */
const SHARED_TAG_HUB_THRESHOLD = 30;

/** Result of `assembleSharedTagEdges`: hub nodes, shared_tag edges, and tier bookkeeping. */
export interface SharedTagAssembly {
  readonly hubNodes: readonly StructureGraphNode[];
  readonly edges: readonly StructureGraphEdge[];
  readonly hubTags: ReadonlySet<string>;
  readonly omittedSharedTags: ReadonlySet<string>;
}

/**
 * Turn `tag → article-node-ids` buckets into `shared_tag` edges (plus hub
 * nodes for Tier-2 tags). Edge ids never collide with the graph's other
 * edge kinds (distinct `shared_tag:` prefix), so the merge bookkeeping is
 * fully self-contained here.
 */
export function assembleSharedTagEdges(
  tagBuckets: ReadonlyMap<string, ReadonlySet<string>>,
): SharedTagAssembly {
  const hubNodes: StructureGraphNode[] = [];
  const edges = new Map<string, StructureGraphEdge>();
  const hubTags = new Set<string>();
  const omittedSharedTags = new Set<string>();

  // Same merge semantics as `addEdge` in `StructureService.getGraph`: a
  // pair connected by several tags keeps a single edge whose `tags` array
  // is the union of every contributing tag.
  const addEdge = (edge: StructureGraphEdge): void => {
    const existing = edges.get(edge.id);
    if (!existing) {
      edges.set(edge.id, edge);
      return;
    }

    if (edge.kind === "shared_tag" && existing.kind === "shared_tag") {
      const combinedTags = new Set([...(existing.tags ?? []), ...(edge.tags ?? [])]);
      edges.set(edge.id, { ...existing, tags: [...combinedTags] });
    }
  };

  for (const [tag, bucket] of tagBuckets) {
    const nodeIds = [...bucket];
    if (nodeIds.length < 2) continue;

    if (nodeIds.length > SHARED_TAG_HUB_THRESHOLD) {
      // Tier 3: truly ubiquitous — omit entirely
      omittedSharedTags.add(tag);
      continue;
    }

    if (nodeIds.length > SHARED_TAG_DIRECT_THRESHOLD) {
      // Tier 2: create a hub node and connect each article to it
      hubTags.add(tag);
      const hubId = `tag:${tag}`;
      hubNodes.push({
        id: hubId,
        kind: "tag",
        label: tag,
      });
      for (const nodeId of nodeIds) {
        addEdge({
          id: `shared_tag:${nodeId}<->${hubId}`,
          source: nodeId,
          target: hubId,
          kind: "shared_tag",
          label: "shared tag",
          tags: [tag],
        });
      }
      continue;
    }

    // Tier 1: pairwise edges (≤ SHARED_TAG_DIRECT_THRESHOLD articles)
    nodeIds.sort();
    for (let index = 0; index < nodeIds.length; index += 1) {
      for (let inner = index + 1; inner < nodeIds.length; inner += 1) {
        const source = nodeIds[index]!;
        const target = nodeIds[inner]!;
        addEdge({
          id: `shared_tag:${source}<->${target}`,
          source,
          target,
          kind: "shared_tag",
          label: "shared tag",
          tags: [tag],
        });
      }
    }
  }

  return { hubNodes, edges: [...edges.values()], hubTags, omittedSharedTags };
}
