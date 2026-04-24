import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { Logger } from "../core/logger.js";
import { NotFoundError } from "../core/errors.js";
import type { StorageError } from "../core/errors.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { WorkArticleRepository } from "../work/repository.js";
import { resolveCodeRef } from "../core/code-refs.js";
import { extractInlineArticleIds, extractWikilinks, stripCodeRegions } from "./wikilink.js";

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

    const sourcePaths = new Map<string, string>();
    for (const a of knowledge.value) {
      sourcePaths.set(a.id, path.join("notes", `${a.slug}.md`));
    }
    for (const a of work.value) {
      sourcePaths.set(a.id, path.join("work-articles", `${a.id}.md`));
    }

    const orphans: OrphanCitation[] = [];
    for (const entry of graphResult.value.gaps.missingReferences) {
      const colonIdx = entry.indexOf(":");
      if (colonIdx === -1) continue;
      const sourceArticleId = entry.slice(0, colonIdx);
      const missingRefId = entry.slice(colonIdx + 1);
      const sourcePath = sourcePaths.get(sourceArticleId);
      orphans.push({
        sourceArticleId,
        missingRefId,
        ...(sourcePath ? { sourcePath } : {}),
      });
    }

    orphans.sort((a, b) => {
      const byPath = (a.sourcePath ?? "").localeCompare(b.sourcePath ?? "");
      return byPath !== 0 ? byPath : a.missingRefId.localeCompare(b.missingRefId);
    });

    return ok(orphans);
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

    const knowledgeArticles = knowledgeResult.value;
    const workArticles = workResult.value;

    const source = resolveArticle(articleIdOrSlug, knowledgeArticles, workArticles);
    if (!source) return err(new NotFoundError("Article", articleIdOrSlug));

    const knowledgeById = new Map<string, string>(
      knowledgeArticles.map((a) => [a.id, a.content]),
    );
    const knowledgeBySlug = new Map<string, string>(
      knowledgeArticles.map((a) => [a.slug, a.content]),
    );
    const workById = new Map<string, string>(
      workArticles.map((a) => [a.id, a.content]),
    );

    const resolveTargetContent = (ref: string): string | undefined =>
      knowledgeById.get(ref) ?? knowledgeBySlug.get(ref) ?? workById.get(ref);

    const pairs = extractCitationValuePairs(source.content);
    const findings: CitationValueFinding[] = [];

    for (const pair of pairs) {
      if (pair.citationId === source.id) continue;

      const targetContent = resolveTargetContent(pair.citationId);
      // Unknown citation targets are the domain of `getOrphanCitations`,
      // not of value verification.
      if (targetContent === undefined) continue;

      if (contentContainsValue(targetContent, pair.claimedValue)) continue;

      findings.push({
        sourceArticle: source.id,
        citedArticle: pair.citationId,
        claimedValue: pair.claimedValue,
        foundValues: extractNumericTokens(targetContent, 10),
        lineHint: pair.lineHint,
      });
    }

    return ok(findings);
  }

  private async codeRefExists(codeRef: string): Promise<boolean> {
    const resolved = resolveCodeRef(this.repoPath, codeRef);

    try {
      await fs.access(resolved);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Helpers for verifyCitedValues ────────────────────────────────────────

interface ResolvedArticleLike {
  readonly id: string;
  readonly content: string;
}

function resolveArticle(
  idOrSlug: string,
  knowledge: ReadonlyArray<{ id: string; slug: string; content: string }>,
  work: ReadonlyArray<{ id: string; content: string }>,
): ResolvedArticleLike | undefined {
  const byId = knowledge.find((a) => a.id === idOrSlug) ?? work.find((a) => a.id === idOrSlug);
  if (byId) return { id: byId.id, content: byId.content };
  const bySlug = knowledge.find((a) => a.slug === idOrSlug);
  if (bySlug) return { id: bySlug.id, content: bySlug.content };
  return undefined;
}

/** Citation-value window: how far after a citation token we look for a number. */
const CITATION_VALUE_WINDOW = 80;

/** A numeric token with optional `$`, thousands separator, decimal, and `%`. */
const NUMERIC_TOKEN = /-?\$?\d[\d,]*(?:\.\d+)?%?/g;

interface CitationValuePair {
  readonly citationId: string;
  readonly claimedValue: string;
  readonly lineHint: string;
}

/**
 * Extract every `(citation, nearby-number)` pair in an article's prose.
 * A citation is either an inline `k-*` / `w-*` id or a `[[slug]]`
 * wikilink. Code regions are stripped first so example citations inside
 * fenced blocks do not produce false pairs.
 *
 * Multiple numbers after a single citation each yield a separate pair
 * — when the author wrote "see k-foo: 22.4% ($923 floor)", the verifier
 * checks both numbers against the cited article.
 */
function extractCitationValuePairs(content: string): readonly CitationValuePair[] {
  const stripped = stripCodeRegions(content);
  const citationPattern = /(\b[kw]-[a-z0-9]+(?:-[a-z0-9]+)*\b|\[\[([^\]]+)\]\])/g;
  const pairs: CitationValuePair[] = [];

  for (const match of stripped.matchAll(citationPattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const windowText = stripped.slice(end, end + CITATION_VALUE_WINDOW);
    const citationId = match[2] !== undefined ? parseWikilinkSlug(match[2]) : match[0];
    if (!citationId) continue;

    for (const numMatch of windowText.matchAll(NUMERIC_TOKEN)) {
      pairs.push({
        citationId,
        claimedValue: numMatch[0],
        lineHint: extractLineAt(stripped, start),
      });
    }
  }

  return pairs;
}

function parseWikilinkSlug(inner: string): string | undefined {
  const trimmed = inner.trim();
  const pipe = trimmed.indexOf("|");
  const slugPart = pipe >= 0 ? trimmed.slice(0, pipe) : trimmed;
  const hash = slugPart.indexOf("#");
  const slug = hash >= 0 ? slugPart.slice(0, hash).trim() : slugPart.trim();
  return slug.length > 0 ? slug : undefined;
}

function contentContainsValue(content: string, claimed: string): boolean {
  const normClaimed = normaliseNumericToken(claimed);
  if (normClaimed === "") return false;
  for (const match of content.matchAll(NUMERIC_TOKEN)) {
    if (normaliseNumericToken(match[0]) === normClaimed) return true;
  }
  return false;
}

function normaliseNumericToken(raw: string): string {
  return raw.replace(/[$,\s%]/g, "").trim();
}

function extractNumericTokens(content: string, limit: number): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of content.matchAll(NUMERIC_TOKEN)) {
    const tok = match[0];
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= limit) break;
  }
  return out;
}

function extractLineAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
}
