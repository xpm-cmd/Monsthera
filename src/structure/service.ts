import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { Logger } from "../core/logger.js";
import { NotFoundError } from "../core/errors.js";
import type { StorageError } from "../core/errors.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { WorkArticleRepository } from "../work/repository.js";

/** Tags shared by up to this many articles get full pairwise edges. */
const SHARED_TAG_DIRECT_THRESHOLD = 15;
/** Tags shared by up to this many articles get a hub node instead of pairwise edges. */
const SHARED_TAG_HUB_THRESHOLD = 30;

export type StructureNodeKind = "knowledge" | "work" | "code" | "tag";
export type StructureEdgeKind = "code_ref" | "reference" | "dependency" | "shared_tag";

export interface StructureGraphNode {
  readonly id: string;
  readonly kind: StructureNodeKind;
  readonly label: string;
  readonly articleId?: string;
  readonly slug?: string;
  readonly category?: string;
  readonly phase?: string;
  readonly template?: string;
  readonly priority?: string;
  readonly preview?: string;
  readonly path?: string;
  readonly exists?: boolean;
  readonly tags?: readonly string[];
}

export interface StructureGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: StructureEdgeKind;
  readonly label?: string;
  readonly tags?: readonly string[];
}

export interface StructureGraphSummary {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly knowledgeCount: number;
  readonly workCount: number;
  readonly codeCount: number;
  readonly sharedTagEdgeCount: number;
  readonly hubTagCount: number;
  readonly missingReferenceCount: number;
  readonly missingDependencyCount: number;
  readonly missingCodeRefCount: number;
  readonly omittedSharedTagCount: number;
}

export interface StructureGraphGaps {
  readonly missingReferences: readonly string[];
  readonly missingDependencies: readonly string[];
  readonly missingCodeRefs: readonly string[];
  readonly omittedSharedTags: readonly string[];
}

export interface StructureGraph {
  readonly nodes: readonly StructureGraphNode[];
  readonly edges: readonly StructureGraphEdge[];
  readonly summary: StructureGraphSummary;
  readonly gaps: StructureGraphGaps;
}

export interface NeighborEdge {
  readonly direction: "outgoing" | "incoming";
  readonly kind: StructureEdgeKind;
  readonly neighborId: string;
  readonly neighborLabel: string;
  readonly neighborKind: StructureNodeKind;
  readonly neighborSlug?: string;
  readonly label?: string;
  readonly tags?: readonly string[];
}

export interface NeighborResult {
  readonly node: StructureGraphNode;
  readonly edges: readonly NeighborEdge[];
  readonly summary: {
    readonly totalEdges: number;
    readonly byKind: Readonly<Record<string, number>>;
  };
}

export interface StructureServiceDeps {
  readonly knowledgeRepo: KnowledgeArticleRepository;
  readonly workRepo: WorkArticleRepository;
  readonly repoPath: string;
  readonly logger: Logger;
}

export class StructureService {
  private readonly knowledgeRepo: KnowledgeArticleRepository;
  private readonly workRepo: WorkArticleRepository;
  private readonly repoPath: string;
  private readonly logger: Logger;

  constructor(deps: StructureServiceDeps) {
    this.knowledgeRepo = deps.knowledgeRepo;
    this.workRepo = deps.workRepo;
    this.repoPath = deps.repoPath;
    this.logger = deps.logger.child({ domain: "structure" });
  }

  async getGraph(): Promise<Result<StructureGraph, StorageError>> {
    const [knowledgeResult, workResult] = await Promise.all([
      this.knowledgeRepo.findMany(),
      this.workRepo.findMany(),
    ]);

    if (!knowledgeResult.ok) return knowledgeResult;
    if (!workResult.ok) return workResult;

    const knowledgeArticles = knowledgeResult.value;
    const workArticles = workResult.value;

    const nodes = new Map<string, StructureGraphNode>();
    const edges = new Map<string, StructureGraphEdge>();
    const knowledgeById = new Map<string, (typeof knowledgeArticles)[number]>(
      knowledgeArticles.map((article) => [article.id, article]),
    );
    const knowledgeBySlug = new Map<string, (typeof knowledgeArticles)[number]>(
      knowledgeArticles.map((article) => [article.slug, article]),
    );
    const workById = new Map<string, (typeof workArticles)[number]>(
      workArticles.map((article) => [article.id, article]),
    );
    const tagBuckets = new Map<string, Set<string>>();
    const codeRefOwners = new Map<string, Set<string>>();
    const missingReferences = new Set<string>();
    const missingDependencies = new Set<string>();
    const omittedSharedTags = new Set<string>();

    const addNode = (node: StructureGraphNode): void => {
      nodes.set(node.id, node);
    };

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

    const bucketTags = (nodeId: string, tags: readonly string[] | undefined): void => {
      for (const tag of tags ?? []) {
        if (!tagBuckets.has(tag)) tagBuckets.set(tag, new Set());
        tagBuckets.get(tag)!.add(nodeId);
      }
    };

    const rememberCodeRef = (nodeId: string, refs: readonly string[] | undefined): void => {
      for (const ref of refs ?? []) {
        if (!codeRefOwners.has(ref)) codeRefOwners.set(ref, new Set());
        codeRefOwners.get(ref)!.add(nodeId);
      }
    };

    for (const article of knowledgeArticles) {
      const nodeId = `k:${article.id}`;
      addNode({
        id: nodeId,
        kind: "knowledge",
        label: article.title,
        articleId: article.id,
        slug: article.slug,
        category: article.category,
        preview: article.content.slice(0, 240),
        tags: article.tags,
      });
      bucketTags(nodeId, article.tags);
      rememberCodeRef(nodeId, article.codeRefs);

      // Resolve explicit references + wikilinks from content
      const explicitRefs = article.references ?? [];
      const wikilinks = this.extractWikilinks(article.content);
      const allRefs = [...new Set([...explicitRefs, ...wikilinks])];
      for (const ref of allRefs) {
        const knowledgeTarget = knowledgeById.get(ref) ?? knowledgeBySlug.get(ref);
        const workTarget = workById.get(ref);
        if (knowledgeTarget) {
          addEdge({
            id: `reference:${nodeId}->k:${knowledgeTarget.id}`,
            source: nodeId,
            target: `k:${knowledgeTarget.id}`,
            kind: "reference",
            label: "references",
          });
        } else if (workTarget) {
          addEdge({
            id: `reference:${nodeId}->w:${workTarget.id}`,
            source: nodeId,
            target: `w:${workTarget.id}`,
            kind: "reference",
            label: "references",
          });
        } else {
          missingReferences.add(`${article.id}:${ref}`);
        }
      }
    }

    for (const article of workArticles) {
      const nodeId = `w:${article.id}`;
      addNode({
        id: nodeId,
        kind: "work",
        label: article.title,
        articleId: article.id,
        phase: article.phase,
        template: article.template,
        priority: article.priority,
        preview: article.content.slice(0, 240),
        tags: article.tags,
      });
      bucketTags(nodeId, article.tags);
      rememberCodeRef(nodeId, article.codeRefs);
    }

    const codeExistenceEntries = await Promise.all(
      [...codeRefOwners.keys()].map(async (codeRef) => ({
        codeRef,
        exists: await this.codeRefExists(codeRef),
      })),
    );
    const codeExistence = new Map(codeExistenceEntries.map((entry) => [entry.codeRef, entry.exists]));

    for (const [codeRef, ownerIds] of codeRefOwners) {
      const codeNodeId = `c:${codeRef}`;
      addNode({
        id: codeNodeId,
        kind: "code",
        label: path.basename(codeRef),
        path: codeRef,
        exists: codeExistence.get(codeRef) ?? false,
      });

      for (const ownerId of ownerIds) {
        addEdge({
          id: `code_ref:${ownerId}->${codeNodeId}`,
          source: ownerId,
          target: codeNodeId,
          kind: "code_ref",
          label: "codeRef",
        });
      }
    }

    for (const article of workArticles) {
      const sourceId = `w:${article.id}`;

      const workWikilinks = this.extractWikilinks(article.content);
      const allWorkRefs = [...new Set([...article.references, ...workWikilinks])];
      for (const ref of allWorkRefs) {
        const knowledgeTarget = knowledgeById.get(ref) ?? knowledgeBySlug.get(ref);
        const workTarget = workById.get(ref);
        if (knowledgeTarget) {
          addEdge({
            id: `reference:${sourceId}->k:${knowledgeTarget.id}`,
            source: sourceId,
            target: `k:${knowledgeTarget.id}`,
            kind: "reference",
            label: "references",
          });
          continue;
        }

        if (workTarget) {
          addEdge({
            id: `reference:${sourceId}->w:${workTarget.id}`,
            source: sourceId,
            target: `w:${workTarget.id}`,
            kind: "reference",
            label: "references",
          });
          continue;
        }

        missingReferences.add(`${article.id}:${ref}`);
      }

      const blockers = new Set([...article.dependencies, ...article.blockedBy]);
      for (const blockerId of blockers) {
        if (!workById.has(blockerId)) {
          missingDependencies.add(`${article.id}:${blockerId}`);
          continue;
        }

        addEdge({
          id: `dependency:${sourceId}->w:${blockerId}`,
          source: sourceId,
          target: `w:${blockerId}`,
          kind: "dependency",
          label: "blocked by",
        });
      }
    }

    const hubTags = new Set<string>();

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
        nodes.set(hubId, {
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

    const graph: StructureGraph = {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      summary: {
        nodeCount: nodes.size,
        edgeCount: edges.size,
        knowledgeCount: knowledgeArticles.length,
        workCount: workArticles.length,
        codeCount: [...nodes.values()].filter((node) => node.kind === "code").length,
        sharedTagEdgeCount: [...edges.values()].filter((edge) => edge.kind === "shared_tag").length,
        hubTagCount: hubTags.size,
        missingReferenceCount: missingReferences.size,
        missingDependencyCount: missingDependencies.size,
        missingCodeRefCount: codeExistenceEntries.filter((entry) => !entry.exists).length,
        omittedSharedTagCount: omittedSharedTags.size,
      },
      gaps: {
        missingReferences: [...missingReferences],
        missingDependencies: [...missingDependencies],
        missingCodeRefs: codeExistenceEntries.filter((entry) => !entry.exists).map((entry) => entry.codeRef),
        omittedSharedTags: [...omittedSharedTags],
      },
    };

    this.logger.debug("Derived structure graph", {
      operation: "getGraph",
      nodeCount: graph.summary.nodeCount,
      edgeCount: graph.summary.edgeCount,
    });

    return ok(graph);
  }

  async getNeighbors(
    articleIdOrSlug: string,
    options?: { edgeKinds?: StructureEdgeKind[]; limit?: number },
  ): Promise<Result<NeighborResult, NotFoundError | StorageError>> {
    const graphResult = await this.getGraph();
    if (!graphResult.ok) return graphResult;
    const graph = graphResult.value;

    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 50);
    const edgeKindFilter = options?.edgeKinds
      ? new Set(options.edgeKinds)
      : undefined;

    // Find the target node — try multiple resolution strategies
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    let targetNode: StructureGraphNode | undefined;

    // 1. Exact node ID
    targetNode = nodeMap.get(articleIdOrSlug);
    // 2. Prefixed article ID
    if (!targetNode) targetNode = nodeMap.get(`k:${articleIdOrSlug}`);
    if (!targetNode) targetNode = nodeMap.get(`w:${articleIdOrSlug}`);
    // 3. Slug match
    if (!targetNode) {
      for (const node of graph.nodes) {
        if (node.slug === articleIdOrSlug) {
          targetNode = node;
          break;
        }
      }
    }

    if (!targetNode) {
      return err(new NotFoundError("StructureNode", articleIdOrSlug));
    }

    const nodeId = targetNode.id;
    const edgePriority: Record<string, number> = {
      reference: 0,
      dependency: 1,
      code_ref: 2,
      shared_tag: 3,
    };

    const neighborEdges: NeighborEdge[] = [];

    for (const edge of graph.edges) {
      if (edgeKindFilter && !edgeKindFilter.has(edge.kind)) continue;

      let direction: "outgoing" | "incoming" | undefined;
      let neighborNodeId: string | undefined;

      if (edge.source === nodeId) {
        direction = "outgoing";
        neighborNodeId = edge.target;
      } else if (edge.target === nodeId) {
        direction = "incoming";
        neighborNodeId = edge.source;
      }

      if (!direction || !neighborNodeId) continue;

      const neighbor = nodeMap.get(neighborNodeId);
      if (!neighbor) continue;

      neighborEdges.push({
        direction,
        kind: edge.kind,
        neighborId: neighbor.articleId ?? neighbor.path ?? neighbor.id,
        neighborLabel: neighbor.label,
        neighborKind: neighbor.kind,
        neighborSlug: neighbor.slug,
        label: edge.label,
        tags: edge.tags,
      });
    }

    // Sort by edge kind priority, then alphabetically by label
    neighborEdges.sort((a, b) => {
      const pa = edgePriority[a.kind] ?? 99;
      const pb = edgePriority[b.kind] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.neighborLabel.localeCompare(b.neighborLabel);
    });

    // Count by kind before truncating
    const byKind: Record<string, number> = {};
    for (const edge of neighborEdges) {
      byKind[edge.kind] = (byKind[edge.kind] ?? 0) + 1;
    }

    return ok({
      node: targetNode,
      edges: neighborEdges.slice(0, limit),
      summary: {
        totalEdges: neighborEdges.length,
        byKind,
      },
    });
  }

  async getGraphSummary(): Promise<Result<StructureGraphSummary & { gaps: StructureGraphGaps }, StorageError>> {
    const graphResult = await this.getGraph();
    if (!graphResult.ok) return graphResult;
    return ok({
      ...graphResult.value.summary,
      gaps: graphResult.value.gaps,
    });
  }

  private extractWikilinks(content: string): string[] {
    const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
    return [...new Set([...matches].map((m) => m[1]!.trim()))];
  }

  private async codeRefExists(codeRef: string): Promise<boolean> {
    const resolved = path.isAbsolute(codeRef)
      ? codeRef
      : path.resolve(this.repoPath, codeRef);

    try {
      await fs.access(resolved);
      return true;
    } catch {
      return false;
    }
  }
}
