import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { Logger } from "../core/logger.js";
import { NotFoundError } from "../core/errors.js";
import type { StorageError } from "../core/errors.js";
import type { KnowledgeArticle, KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { WorkArticle, WorkArticleRepository } from "../work/repository.js";
import type { CanonicalValue } from "../work/policy-loader.js";
import { extractInlineArticleIds, extractWikilinks } from "./wikilink.js";
import {
  collectOrphanCitations,
  detectContradictionsInArticles,
  verifyCitedValuesInArticles,
} from "./citation-analyzer.js";
import { assembleCodeGraphNodes, buildCodeRefOwnerIndexFromArticles } from "./code-ref-indexer.js";
import { buildStalenessReportFromArticles } from "./staleness-report.js";
import { assembleSharedTagEdges } from "./tag-edge-builder.js";

/**
 * A reference token that is an external URL (`http://` / `https://`) is a
 * legitimate citation to something outside the corpus — a GitHub repo, an
 * upstream spec — not a dangling pointer to a missing article. Such tokens
 * must never enter `missingReferences`, otherwise `monsthera lint`,
 * `knowledge refs --orphans`, and the `refs_orphans` MCP tool all report
 * them as broken citations and `missingReferenceCount` is inflated. They
 * are also never resolvable to a `k:`/`w:` node, so excluding them costs no
 * real edges. Authored ids (`k-foo`, `w-bar`) and slugs are unaffected.
 */
function isExternalReference(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

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

/** Single edge returned by `getRefGraph`, always knowledge-or-work-typed. */
export interface RefGraphEdge {
  readonly id: string;
  readonly title: string;
  readonly kind: "knowledge" | "work";
}

/** All reference edges around a single article. Unbounded — audit-grade. */
export interface RefGraphResult {
  readonly articleId: string;
  readonly incoming: readonly RefGraphEdge[];
  readonly outgoing: readonly RefGraphEdge[];
}

/**
 * A citation from some article to an ID that does not resolve to any known
 * article. `sourcePath` is the markdown-root-relative path — stable enough
 * for lint output and click-through in the dashboard, while keeping the
 * absolute location (which may include `/tmp/...`) out of agent surfaces.
 */
export interface OrphanCitation {
  readonly sourceArticleId: string;
  readonly missingRefId: string;
  readonly sourcePath?: string;
}

/**
 * A citation in some article's prose that claims a numeric value adjacent
 * to a reference, where the referenced article's content does not contain
 * that value. The reviewer signal: "you cited X saying Y, but X does not
 * say Y — which side needs updating?".
 *
 * `foundValues` is a bounded list of numeric tokens observed in the cited
 * article, offered as candidates the author may have meant. Empty when
 * the cited article contains no numbers at all.
 */
export interface CitationValueFinding {
  readonly sourceArticle: string;
  readonly citedArticle: string;
  readonly claimedValue: string;
  readonly foundValues: readonly string[];
  readonly lineHint: string;
}

/**
 * Index of code-ref strings to their owning knowledge/work articles. Built from
 * `findMany()` on both repos and indexed by the comparable normalized form
 * (line anchors stripped, leading `./` removed, trailing `/` removed). Node
 * IDs use the same `k:` / `w:` prefix convention as the structure graph so
 * callers can correlate the two surfaces.
 */
export interface CodeRefOwnerIndex {
  /** Normalized code-ref → set of owning node IDs (`k:<articleId>` or `w:<articleId>`). */
  readonly byRef: ReadonlyMap<string, ReadonlySet<string>>;
  /** Knowledge articles indexed by their `k:` node ID. */
  readonly knowledgeById: ReadonlyMap<string, KnowledgeArticle>;
  /** Work articles indexed by their `w:` node ID. */
  readonly workById: ReadonlyMap<string, WorkArticle>;
}

/**
 * A corpus article whose freshness signal is `stale` — older than the
 * 45-day attention window, or (knowledge only) whose linked source file
 * is newer than the article itself. `ageDays` is absent only when the
 * article carries no usable `updatedAt`.
 */
export interface StaleArticleEntry {
  readonly id: string;
  readonly type: "knowledge" | "work";
  readonly title: string;
  readonly slug?: string;
  readonly ageDays?: number;
  readonly detail: string;
  readonly sourcePath?: string;
}

/** A codeRef on some article that no longer resolves to a file on disk. */
export interface StaleCodeRefEntry {
  readonly articleId: string;
  readonly type: "knowledge" | "work";
  readonly title: string;
  readonly codeRef: string;
}

/**
 * A knowledge article whose imported source file changed after the article
 * was last updated — a re-import candidate, distinct from age staleness.
 */
export interface SourceNewerEntry {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly sourcePath: string;
  readonly sourceUpdatedAt?: string;
  readonly articleUpdatedAt: string;
}

/**
 * Consolidated, read-only staleness signal across the whole corpus. Folds
 * `buildContextPack`'s per-item freshness up to corpus scope for
 * `monsthera doctor` and the `refs_stale` MCP tool.
 */
export interface StalenessReport {
  readonly staleArticles: readonly StaleArticleEntry[];
  readonly staleCodeRefs: readonly StaleCodeRefEntry[];
  readonly sourceNewer: readonly SourceNewerEntry[];
  readonly summary: {
    readonly knowledgeScanned: number;
    readonly workScanned: number;
    readonly staleArticleCount: number;
    readonly staleCodeRefCount: number;
    readonly sourceNewerCount: number;
  };
}

/**
 * Two corpus articles that state DIFFERENT values for the same canonical
 * name and are graph-adjacent (share a tag or a code ref). The canonical
 * registry supplies the vocabulary of quantities worth checking; adjacency
 * bounds the comparison and filters out coincidental number reuse across
 * unrelated topics. Article ids are ordered (`articleA < articleB`) so a
 * pair surfaces once regardless of scan order. Deterministic — no LLM.
 */
export interface ContradictionFinding {
  readonly articleA: string;
  readonly articleB: string;
  readonly name: string;
  readonly valueA: string;
  readonly valueB: string;
  readonly sharedVia: "shared_tag" | "code_ref";
  readonly sharedKey: string;
  readonly lineHintA: string;
  readonly lineHintB: string;
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

    // Sorted union of every article id, used by the shorthand-stem fallback
    // below. Sorting makes the first prefix hit deterministic when several
    // ids share a stem.
    const sortedArticleIds = [...knowledgeById.keys(), ...workById.keys()].sort();

    /**
     * Shorthand-stem prefix fallback (Banyan P0-C): externally authored
     * corpora carry FULL-length ids like `k-10-01-picard-1976-maximal-…`
     * while their prose cites the shorthand stem `k-10-01`. A reference
     * that matches no article id or slug exactly still resolves when at
     * least one article id starts with `ref + "-"`. The trailing hyphen is
     * the boundary guard: `k-10-0` must NOT resolve to `k-10-01-…`.
     *
     * Only invoked on exact-miss (rare), and the corpus is hundreds of ids,
     * so a linear scan over the precomputed sorted array is plenty.
     *
     * Returns the first non-self matching id; falls back to `selfId` when
     * the article's own id is the only stem match (resolved, but no
     * self-loop edge is worth drawing); null when nothing matches.
     */
    const resolveByStemPrefix = (ref: string, selfId: string): string | null => {
      const needle = `${ref}-`;
      let matchedSelf = false;
      for (const id of sortedArticleIds) {
        if (!id.startsWith(needle)) continue;
        if (id === selfId) {
          matchedSelf = true;
          continue;
        }
        return id;
      }
      return matchedSelf ? selfId : null;
    };

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

      // Resolve explicit references + wikilinks + inline article IDs from content
      const explicitRefs = article.references ?? [];
      const wikilinks = extractWikilinks(article.content);
      const wikilinkSlugs = wikilinks.map((l) => l.slug);
      const inlineIds = extractInlineArticleIds(article.content);
      const allRefs = [...new Set([...explicitRefs, ...wikilinkSlugs, ...inlineIds])].filter(
        (ref) => ref !== article.id,
      );
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
        } else if (!isExternalReference(ref)) {
          const stemTargetId = resolveByStemPrefix(ref, article.id);
          if (stemTargetId === null) {
            missingReferences.add(`${article.id}:${ref}`);
          } else if (stemTargetId !== article.id) {
            const targetPrefix = knowledgeById.has(stemTargetId) ? "k" : "w";
            addEdge({
              id: `reference:${nodeId}->${targetPrefix}:${stemTargetId}`,
              source: nodeId,
              target: `${targetPrefix}:${stemTargetId}`,
              kind: "reference",
              label: "references",
            });
          }
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

    // Code nodes + code_ref edges: assembly delegated to code-ref-indexer.ts.
    const {
      nodes: codeNodes,
      edges: codeRefEdges,
      codeExistenceEntries,
    } = await assembleCodeGraphNodes(this.repoPath, codeRefOwners);
    for (const node of codeNodes) addNode(node);
    for (const edge of codeRefEdges) addEdge(edge);

    for (const article of workArticles) {
      const sourceId = `w:${article.id}`;

      const workWikilinks = extractWikilinks(article.content);
      const workWikilinkSlugs = workWikilinks.map((l) => l.slug);
      const workInlineIds = extractInlineArticleIds(article.content);
      const allWorkRefs = [...new Set([...article.references, ...workWikilinkSlugs, ...workInlineIds])].filter(
        (ref) => ref !== article.id,
      );
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

        if (isExternalReference(ref)) continue;
        const stemTargetId = resolveByStemPrefix(ref, article.id);
        if (stemTargetId === null) {
          missingReferences.add(`${article.id}:${ref}`);
          continue;
        }
        if (stemTargetId !== article.id) {
          const targetPrefix = knowledgeById.has(stemTargetId) ? "k" : "w";
          addEdge({
            id: `reference:${sourceId}->${targetPrefix}:${stemTargetId}`,
            source: sourceId,
            target: `${targetPrefix}:${stemTargetId}`,
            kind: "reference",
            label: "references",
          });
        }
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

    // Shared-tag hub nodes + edges: assembly delegated to tag-edge-builder.ts.
    const {
      hubNodes,
      edges: sharedTagEdges,
      hubTags,
      omittedSharedTags,
    } = assembleSharedTagEdges(tagBuckets);
    for (const node of hubNodes) addNode(node);
    for (const edge of sharedTagEdges) addEdge(edge);

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

  /**
   * Build an index of code-ref → owner articles, suitable for code-intelligence
   * lookups. Cheaper than `getGraph()` because it skips edge construction,
   * tag bucketing, and reference resolution. Returns the comparable normalized
   * form for each ref so callers don't need to normalize on every lookup.
   *
   * Owners are returned per-ref as a set of node IDs (`k:<id>` / `w:<id>`).
   * The full article objects are returned alongside so callers that need
   * `category`, `phase`, `priority`, etc. don't have to issue another
   * `findMany()`.
   */
  async buildCodeRefOwnerIndex(): Promise<Result<CodeRefOwnerIndex, StorageError>> {
    const [knowledgeResult, workResult] = await Promise.all([
      this.knowledgeRepo.findMany(),
      this.workRepo.findMany(),
    ]);
    if (!knowledgeResult.ok) return knowledgeResult;
    if (!workResult.ok) return workResult;

    return ok(buildCodeRefOwnerIndexFromArticles(knowledgeResult.value, workResult.value));
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

  /**
   * Full reference edge set around a single article. Unlike `getNeighbors`,
   * this is unbounded (no `limit` cap), filtered to `reference` edges only,
   * and scoped to `knowledge | work` nodes — designed for audit use cases
   * (`monsthera knowledge refs --to|--from`) where truncation would silently
   * hide citations.
   */
  async getRefGraph(
    articleIdOrSlug: string,
  ): Promise<Result<RefGraphResult, NotFoundError | StorageError>> {
    const graphResult = await this.getGraph();
    if (!graphResult.ok) return graphResult;
    const graph = graphResult.value;

    const targetNode = this.resolveTargetNode(graph, articleIdOrSlug);
    if (!targetNode) {
      return err(new NotFoundError("StructureNode", articleIdOrSlug));
    }

    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const incoming: RefGraphEdge[] = [];
    const outgoing: RefGraphEdge[] = [];

    for (const edge of graph.edges) {
      if (edge.kind !== "reference") continue;
      const neighborNodeId =
        edge.source === targetNode.id
          ? edge.target
          : edge.target === targetNode.id
            ? edge.source
            : undefined;
      if (!neighborNodeId) continue;

      const neighbor = nodeMap.get(neighborNodeId);
      if (!neighbor) continue;
      if (neighbor.kind !== "knowledge" && neighbor.kind !== "work") continue;

      const refEdge: RefGraphEdge = {
        id: neighbor.articleId ?? neighbor.id,
        title: neighbor.label,
        kind: neighbor.kind,
      };
      if (edge.source === targetNode.id) outgoing.push(refEdge);
      else incoming.push(refEdge);
    }

    incoming.sort((a, b) => a.title.localeCompare(b.title));
    outgoing.sort((a, b) => a.title.localeCompare(b.title));

    return ok({
      articleId: targetNode.articleId ?? targetNode.id,
      incoming,
      outgoing,
    });
  }

  /**
   * Enumerate every citation in the corpus whose target ID does not resolve.
   * Reuses the `missingReferences` gap set that `getGraph` already populates
   * — the widening from inline-ID extraction (ADR-010 / S4 commit 4) means
   * raw `k-foo` / `w-bar` citations in prose also flow through here, not
   * just frontmatter `references:` entries.
   */
  async getOrphanCitations(): Promise<Result<readonly OrphanCitation[], StorageError>> {
    const graphResult = await this.getGraph();
    if (!graphResult.ok) return graphResult;

    const knowledge = await this.knowledgeRepo.findMany();
    if (!knowledge.ok) return knowledge;
    const work = await this.workRepo.findMany();
    if (!work.ok) return work;

    return ok(
      collectOrphanCitations(graphResult.value.gaps.missingReferences, knowledge.value, work.value),
    );
  }

  /**
   * Resolve `articleIdOrSlug` to a graph node via the same 4-tier fallback
   * used by `getNeighbors`: exact node ID → `k:` prefix → `w:` prefix →
   * slug match. Extracted to a private helper so `getRefGraph` can reuse it
   * without going through the limited-by-default `getNeighbors` path.
   */
  private resolveTargetNode(
    graph: StructureGraph,
    articleIdOrSlug: string,
  ): StructureGraphNode | undefined {
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    let targetNode = nodeMap.get(articleIdOrSlug);
    if (!targetNode) targetNode = nodeMap.get(`k:${articleIdOrSlug}`);
    if (!targetNode) targetNode = nodeMap.get(`w:${articleIdOrSlug}`);
    if (!targetNode) {
      for (const node of graph.nodes) {
        if (node.slug === articleIdOrSlug) return node;
      }
    }
    return targetNode;
  }

  /**
   * Verify every "citation-with-number" claim in an article against the
   * content of the cited article. For each pair `(citation, claimedValue)`
   * extracted from source prose, resolve the citation to a knowledge or
   * work article and check whether `claimedValue` appears anywhere in
   * that article's content or frontmatter fields. Mismatches surface as
   * `CitationValueFinding` entries.
   *
   * Scope note: unlike `getRefGraph`, this method opens target articles
   * and scans their text — the complexity grows with the number of
   * citation-value pairs in the source. Callers that want corpus-wide
   * verification should iterate at their layer; the CLI does this
   * explicitly under `--all` to keep the signal bounded.
   */
  async verifyCitedValues(
    articleIdOrSlug: string,
  ): Promise<Result<readonly CitationValueFinding[], NotFoundError | StorageError>> {
    const [knowledgeResult, workResult] = await Promise.all([
      this.knowledgeRepo.findMany(),
      this.workRepo.findMany(),
    ]);
    if (!knowledgeResult.ok) return knowledgeResult;
    if (!workResult.ok) return workResult;

    return verifyCitedValuesInArticles(articleIdOrSlug, knowledgeResult.value, workResult.value);
  }

  /**
   * Build a consolidated, read-only staleness report across the whole
   * corpus. Three independent, individually actionable signals:
   *  - `staleArticles` — knowledge/work whose freshness is `stale`,
   *    sorted most-stale-first so callers can bound their own display.
   *  - `staleCodeRefs` — codeRefs that no longer resolve on disk.
   *  - `sourceNewer`   — knowledge whose imported source changed after the
   *    article was last updated (a re-import candidate).
   *
   * Reuses `inspectKnowledgeArticle` / `inspectWorkArticle` (the same
   * freshness logic `buildContextPack` applies per item) and
   * `codeRefExists` (code-ref-indexer.ts), so the report can never drift
   * from those surfaces.
   */
  async buildStalenessReport(): Promise<Result<StalenessReport, StorageError>> {
    const [knowledgeResult, workResult] = await Promise.all([
      this.knowledgeRepo.findMany(),
      this.workRepo.findMany(),
    ]);
    if (!knowledgeResult.ok) return knowledgeResult;
    if (!workResult.ok) return workResult;

    return ok(
      await buildStalenessReportFromArticles(knowledgeResult.value, workResult.value, this.repoPath),
    );
  }

  /**
   * Detect cross-article contradictions: graph-adjacent articles (sharing a
   * tag or a code ref) that state DIFFERENT values for the same canonical
   * name. Deterministic — reuses the same name→number extraction as the
   * `canonical_value_mismatch` lint rule (`extractStatedCanonicalValues`),
   * but compares articles against each other rather than against the
   * registry's expected figure. The registry only supplies the vocabulary
   * of quantities worth checking; an empty registry yields no findings.
   *
   * Adjacency bounds the work and suppresses coincidental number reuse:
   * two notes about unrelated subsystems that both mention "timeout: 30"
   * are not flagged unless they actually share a tag or code ref.
   *
   * Pass `opts.articleId` (id or slug) to restrict findings to pairs
   * involving that article. An LLM tier is intentionally out of scope here;
   * this is the deterministic foundation it would build on.
   */
  async detectContradictions(
    canonicalValues: readonly CanonicalValue[],
    opts?: { articleId?: string },
  ): Promise<Result<readonly ContradictionFinding[], StorageError>> {
    if (canonicalValues.length === 0) return ok([]);

    const [knowledgeResult, workResult] = await Promise.all([
      this.knowledgeRepo.findMany(),
      this.workRepo.findMany(),
    ]);
    if (!knowledgeResult.ok) return knowledgeResult;
    if (!workResult.ok) return workResult;

    return ok(
      detectContradictionsInArticles(canonicalValues, knowledgeResult.value, workResult.value, opts),
    );
  }
}
