import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { Logger } from "../core/logger.js";
import type { StorageError } from "../core/errors.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { WorkArticleRepository } from "../work/repository.js";

const MAX_SHARED_TAG_OCCURRENCES = 6;

export type StructureNodeKind = "knowledge" | "work" | "code";
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

      for (const ref of article.references) {
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

    for (const [tag, bucket] of tagBuckets) {
      const nodeIds = [...bucket];
      if (nodeIds.length < 2) continue;
      if (nodeIds.length > MAX_SHARED_TAG_OCCURRENCES) {
        omittedSharedTags.add(tag);
        continue;
      }

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
