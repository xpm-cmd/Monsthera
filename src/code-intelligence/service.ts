import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "../core/logger.js";
import { StorageError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";
import {
  extractLineAnchor,
  normalizeCodeRefPath,
  resolveCodeRef,
} from "../core/code-refs.js";
import { WorkPhase } from "../core/types.js";
import type { KnowledgeArticleRepository, KnowledgeArticle } from "../knowledge/repository.js";
import type { WorkArticleRepository, WorkArticle } from "../work/repository.js";
import { POLICY_CATEGORY } from "../knowledge/schemas.js";
import type { CodeRefOwnerIndex, StructureService } from "../structure/service.js";

/**
 * Phases that count as "active work" for code-intelligence purposes. Whitelist
 * (not blacklist) so a future phase like `archived` does not silently classify
 * as active. Mirrors the canonical phase set in `src/core/types.ts`.
 */
const ACTIVE_WORK_PHASES: ReadonlySet<WorkPhase> = new Set<WorkPhase>([
  WorkPhase.PLANNING,
  WorkPhase.ENRICHMENT,
  WorkPhase.IMPLEMENTATION,
  WorkPhase.REVIEW,
]);

/** Minimum target length for the policy `content`-fallback match (avoid false positives on short tokens). */
const POLICY_CONTENT_MATCH_MIN_LENGTH = 6;

export interface CodeRefOwner {
  readonly id: string;
  readonly title: string;
  readonly type: "knowledge" | "work";
  readonly ref: string;
  readonly match: "exact" | "prefix" | "content";
  readonly category?: string;
  readonly phase?: string;
  readonly template?: string;
  readonly priority?: string;
  readonly active?: boolean;
}

export interface CodeRefDetail {
  readonly input: string;
  readonly normalizedPath: string;
  readonly absolutePath: string;
  readonly exists: boolean;
  readonly outOfRepo?: boolean;
  readonly lineAnchor?: string;
  readonly isDirectory?: boolean;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
  readonly owners: readonly CodeRefOwner[];
  readonly activeWork: readonly CodeRefOwner[];
  readonly policies: readonly CodeRefOwner[];
  readonly summary: {
    readonly ownerCount: number;
    readonly knowledgeCount: number;
    readonly workCount: number;
    readonly activeWorkCount: number;
    readonly policyCount: number;
  };
}

export interface CodeRefOwners {
  readonly input: string;
  readonly normalizedPath: string;
  readonly lineAnchor?: string;
  readonly owners: readonly CodeRefOwner[];
  readonly summary: {
    readonly ownerCount: number;
    readonly knowledgeCount: number;
    readonly workCount: number;
  };
}

export interface CodeRefImpact {
  readonly ref: CodeRefDetail;
  readonly risk: "none" | "low" | "medium" | "high";
  readonly reasons: readonly string[];
  readonly recommendedNextActions: readonly string[];
}

export interface ChangedCodeRefImpact {
  readonly changedPathCount: number;
  readonly impacts: readonly CodeRefImpact[];
  readonly summary: {
    readonly impactedOwnerCount: number;
    readonly impactedActiveWorkCount: number;
    readonly impactedPolicyCount: number;
    readonly highestRisk: "none" | "low" | "medium" | "high";
  };
  readonly recommendedNextActions: readonly string[];
}

export interface CodeIntelligenceServiceDeps {
  readonly knowledgeRepo: KnowledgeArticleRepository;
  readonly workRepo: WorkArticleRepository;
  readonly structureService: StructureService;
  readonly repoPath: string;
  readonly logger: Logger;
}

export class CodeIntelligenceService {
  private readonly knowledgeRepo: KnowledgeArticleRepository;
  private readonly workRepo: WorkArticleRepository;
  private readonly structureService: StructureService;
  private readonly repoPath: string;
  private readonly logger: Logger;

  constructor(deps: CodeIntelligenceServiceDeps) {
    this.knowledgeRepo = deps.knowledgeRepo;
    this.workRepo = deps.workRepo;
    this.structureService = deps.structureService;
    this.repoPath = deps.repoPath;
    this.logger = deps.logger.child({ domain: "code-intelligence" });
  }

  async getCodeRef(input: { ref: string }): Promise<Result<CodeRefDetail, StorageError>> {
    const normalizedPath = normalizeCodeRefPath(input.ref);
    const lineAnchor = extractLineAnchor(input.ref);
    const absolutePath = resolveCodeRef(this.repoPath, normalizedPath);
    const outOfRepo = isOutOfRepo(this.repoPath, absolutePath);

    const [indexResult, statResult] = await Promise.all([
      this.structureService.buildCodeRefOwnerIndex(),
      outOfRepo ? Promise.resolve(ok({ exists: false } as StatResult)) : this.statPath(absolutePath),
    ]);
    if (!indexResult.ok) return indexResult;
    if (!statResult.ok) return statResult;

    const owners = collectOwners(normalizedPath, indexResult.value);
    const activeWork = owners.filter((owner) => owner.type === "work" && owner.active);
    const policies = owners.filter(
      (owner) => owner.type === "knowledge" && owner.category === POLICY_CATEGORY,
    );

    const detail: CodeRefDetail = {
      input: input.ref,
      normalizedPath,
      absolutePath,
      exists: statResult.value.exists,
      ...(outOfRepo && { outOfRepo: true }),
      ...(lineAnchor !== undefined && { lineAnchor }),
      ...(statResult.value.isDirectory !== undefined && { isDirectory: statResult.value.isDirectory }),
      ...(statResult.value.sizeBytes !== undefined && { sizeBytes: statResult.value.sizeBytes }),
      ...(statResult.value.modifiedAt !== undefined && { modifiedAt: statResult.value.modifiedAt }),
      owners,
      activeWork,
      policies,
      summary: {
        ownerCount: owners.length,
        knowledgeCount: owners.filter((owner) => owner.type === "knowledge").length,
        workCount: owners.filter((owner) => owner.type === "work").length,
        activeWorkCount: activeWork.length,
        policyCount: policies.length,
      },
    };

    return ok(detail);
  }

  /**
   * Lighter-weight variant of `getCodeRef` for ADR-015 M1 milestone: returns
   * just the linked owners and category breakdown without filesystem stat,
   * risk scoring, or recommended next actions. Use when an agent only needs
   * "who owns this file?" without the editing-context guidance.
   */
  async findCodeOwners(input: { ref: string }): Promise<Result<CodeRefOwners, StorageError>> {
    const normalizedPath = normalizeCodeRefPath(input.ref);
    const lineAnchor = extractLineAnchor(input.ref);

    const indexResult = await this.structureService.buildCodeRefOwnerIndex();
    if (!indexResult.ok) return indexResult;

    const owners = collectOwners(normalizedPath, indexResult.value);

    return ok({
      input: input.ref,
      normalizedPath,
      ...(lineAnchor !== undefined && { lineAnchor }),
      owners,
      summary: {
        ownerCount: owners.length,
        knowledgeCount: owners.filter((owner) => owner.type === "knowledge").length,
        workCount: owners.filter((owner) => owner.type === "work").length,
      },
    });
  }

  async analyzeCodeRefImpact(input: { ref: string }): Promise<Result<CodeRefImpact, StorageError>> {
    const detailResult = await this.getCodeRef(input);
    if (!detailResult.ok) return detailResult;

    const ref = detailResult.value;
    const reasons: string[] = [];
    const recommendedNextActions: string[] = [];

    if (ref.outOfRepo) {
      reasons.push("ref_out_of_repo");
      recommendedNextActions.push("Code refs must point inside the repository; remove or correct this reference.");
    } else if (!ref.exists) {
      reasons.push("code_ref_missing");
      recommendedNextActions.push("Repair or remove stale code refs before relying on this path.");
    }
    if (ref.summary.activeWorkCount > 0) {
      reasons.push("active_work_linked");
      recommendedNextActions.push("Open the linked active work before editing or reviewing this path.");
    }
    if (ref.summary.policyCount > 0) {
      reasons.push("policy_linked");
      recommendedNextActions.push("Review linked policy articles before advancing affected work.");
    }
    if (ref.summary.ownerCount > 0) {
      recommendedNextActions.push("Use build_context_pack with this path to retrieve linked knowledge/work context.");
    }
    if (ref.summary.ownerCount === 0) {
      reasons.push("no_monsthera_context");
      recommendedNextActions.push("Consider adding code refs to relevant knowledge or work articles if this path matters.");
    }

    return ok({
      ref,
      risk: riskFor(ref),
      reasons,
      recommendedNextActions,
    });
  }

  async detectChangedCodeRefs(input: {
    changedPaths: readonly string[];
  }): Promise<Result<ChangedCodeRefImpact, StorageError>> {
    const indexResult = await this.structureService.buildCodeRefOwnerIndex();
    if (!indexResult.ok) return indexResult;

    const uniquePaths = [...new Set(input.changedPaths.map(normalizeCodeRefPath).filter(Boolean))];
    const impacts: CodeRefImpact[] = [];

    for (const changedPath of uniquePaths) {
      const impact = await this.analyzeWithIndex(changedPath, indexResult.value);
      if (impact.ref.summary.ownerCount > 0 || !impact.ref.exists || impact.ref.outOfRepo) {
        impacts.push(impact);
      }
    }

    const impactedOwnerIds = new Set<string>();
    const activeWorkIds = new Set<string>();
    const policyIds = new Set<string>();
    for (const impact of impacts) {
      for (const owner of impact.ref.owners) {
        impactedOwnerIds.add(`${owner.type}:${owner.id}`);
        if (owner.type === "work" && owner.active) activeWorkIds.add(owner.id);
        if (owner.type === "knowledge" && owner.category === POLICY_CATEGORY) policyIds.add(owner.id);
      }
    }

    const highestRisk = impacts.reduce<ChangedCodeRefImpact["summary"]["highestRisk"]>(
      (highest, impact) => higherRisk(highest, impact.risk),
      "none",
    );

    const recommendedNextActions = [
      ...(activeWorkIds.size > 0
        ? ["Review impacted active work articles and update their implementation evidence."]
        : []),
      ...(policyIds.size > 0
        ? ["Review impacted policies before advancing work to review or done."]
        : []),
      ...(impactedOwnerIds.size > 0
        ? ["Attach the changed paths to the relevant work article if they are part of the implementation."]
        : ["No existing Monsthera code refs matched these changed paths; add refs if the change should be durable context."]),
    ];

    this.logger.debug("Detected changed code refs", {
      changedPathCount: uniquePaths.length,
      impactedOwnerCount: impactedOwnerIds.size,
    });

    return ok({
      changedPathCount: uniquePaths.length,
      impacts,
      summary: {
        impactedOwnerCount: impactedOwnerIds.size,
        impactedActiveWorkCount: activeWorkIds.size,
        impactedPolicyCount: policyIds.size,
        highestRisk,
      },
      recommendedNextActions,
    });
  }

  /** Internal variant of analyzeCodeRefImpact that reuses an already-built owner index. */
  private async analyzeWithIndex(
    normalizedPath: string,
    index: CodeRefOwnerIndex,
  ): Promise<CodeRefImpact> {
    const absolutePath = resolveCodeRef(this.repoPath, normalizedPath);
    const outOfRepo = isOutOfRepo(this.repoPath, absolutePath);
    const statResult = outOfRepo
      ? ok({ exists: false } as StatResult)
      : await this.statPath(absolutePath);

    const stat: StatResult = statResult.ok
      ? statResult.value
      : { exists: false };

    const owners = collectOwners(normalizedPath, index);
    const activeWork = owners.filter((owner) => owner.type === "work" && owner.active);
    const policies = owners.filter(
      (owner) => owner.type === "knowledge" && owner.category === POLICY_CATEGORY,
    );

    const ref: CodeRefDetail = {
      input: normalizedPath,
      normalizedPath,
      absolutePath,
      exists: stat.exists,
      ...(outOfRepo && { outOfRepo: true }),
      ...(stat.isDirectory !== undefined && { isDirectory: stat.isDirectory }),
      ...(stat.sizeBytes !== undefined && { sizeBytes: stat.sizeBytes }),
      ...(stat.modifiedAt !== undefined && { modifiedAt: stat.modifiedAt }),
      owners,
      activeWork,
      policies,
      summary: {
        ownerCount: owners.length,
        knowledgeCount: owners.filter((owner) => owner.type === "knowledge").length,
        workCount: owners.filter((owner) => owner.type === "work").length,
        activeWorkCount: activeWork.length,
        policyCount: policies.length,
      },
    };

    const reasons: string[] = [];
    const recommendedNextActions: string[] = [];
    if (ref.outOfRepo) {
      reasons.push("ref_out_of_repo");
      recommendedNextActions.push("Code refs must point inside the repository; remove or correct this reference.");
    } else if (!ref.exists) {
      reasons.push("code_ref_missing");
      recommendedNextActions.push("Repair or remove stale code refs before relying on this path.");
    }
    if (ref.summary.activeWorkCount > 0) {
      reasons.push("active_work_linked");
      recommendedNextActions.push("Open the linked active work before editing or reviewing this path.");
    }
    if (ref.summary.policyCount > 0) {
      reasons.push("policy_linked");
      recommendedNextActions.push("Review linked policy articles before advancing affected work.");
    }
    if (ref.summary.ownerCount > 0) {
      recommendedNextActions.push("Use build_context_pack with this path to retrieve linked knowledge/work context.");
    }
    if (ref.summary.ownerCount === 0) {
      reasons.push("no_monsthera_context");
      recommendedNextActions.push("Consider adding code refs to relevant knowledge or work articles if this path matters.");
    }

    return { ref, risk: riskFor(ref), reasons, recommendedNextActions };
  }

  private async statPath(filePath: string): Promise<Result<StatResult, StorageError>> {
    try {
      const stat = await fs.stat(filePath);
      return ok({
        exists: true,
        isDirectory: stat.isDirectory(),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return ok({ exists: false });
      }
      return err(new StorageError(`Failed to inspect code ref: ${filePath}`, { cause: String(error) }));
    }
  }
}

interface StatResult {
  exists: boolean;
  isDirectory?: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
}

/**
 * Reject paths that resolve outside the repository root. Catches both `..`
 * traversal and absolute paths pointing elsewhere on disk. Returning `true`
 * means callers must NOT call `fs.stat` (or any other filesystem op) on the
 * resolved path — they should treat the ref as missing and surface
 * `outOfRepo: true` to clients.
 */
function isOutOfRepo(repoPath: string, absolutePath: string): boolean {
  const relative = path.relative(repoPath, absolutePath);
  if (relative === "") return false;
  return relative.startsWith("..") || path.isAbsolute(relative);
}

/**
 * Build the full owner list for a normalized target path against an
 * already-loaded `CodeRefOwnerIndex`. Combines exact + prefix matches from
 * the index with a content-fallback for policy articles whose body mentions
 * the path even though it isn't in `codeRefs`.
 */
function collectOwners(target: string, index: CodeRefOwnerIndex): CodeRefOwner[] {
  if (!target) return [];

  const matches = new Map<string, CodeRefOwner>();
  const keyOf = (owner: CodeRefOwner): string =>
    `${owner.type}:${owner.id}:${owner.ref}:${owner.match}`;

  // Pass 1: exact + prefix matches against the index. The index is keyed by
  // normalized refs, so matching is symmetric (any normalized ref that is a
  // directory ancestor or descendant of the target counts as a prefix hit).
  for (const [indexedRef, ownerNodeIds] of index.byRef) {
    const matchKind = pathMatchKind(indexedRef, target);
    if (!matchKind) continue;

    for (const nodeId of ownerNodeIds) {
      const knowledge = index.knowledgeById.get(nodeId);
      if (knowledge) {
        const owner = ownerForKnowledge(knowledge, indexedRef, matchKind);
        matches.set(keyOf(owner), owner);
        continue;
      }
      const work = index.workById.get(nodeId);
      if (work) {
        const owner = ownerForWork(work, indexedRef, matchKind);
        matches.set(keyOf(owner), owner);
      }
    }
  }

  // Pass 2: policy content fallback — if no explicit code-ref hit, but a
  // policy mentions the target literally and the target is long enough to
  // avoid noise. Word-boundary regex prevents `src` matching `transcribe`.
  if (target.length >= POLICY_CONTENT_MATCH_MIN_LENGTH) {
    const wordBoundary = new RegExp(`\\b${escapeRegExp(target)}\\b`);
    for (const knowledge of index.knowledgeById.values()) {
      if (knowledge.category !== POLICY_CATEGORY) continue;
      const ownerKey = `knowledge:${knowledge.id}`;
      const alreadyMatched = [...matches.values()].some(
        (owner) => owner.type === "knowledge" && owner.id === knowledge.id,
      );
      if (alreadyMatched) continue;
      if (!wordBoundary.test(knowledge.content)) continue;

      const owner: CodeRefOwner = {
        id: knowledge.id,
        title: knowledge.title,
        type: "knowledge",
        ref: target,
        match: "content",
        category: knowledge.category,
      };
      matches.set(`${ownerKey}:${target}:content`, owner);
    }
  }

  return [...matches.values()].sort(compareOwners);
}

function ownerForKnowledge(
  article: KnowledgeArticle,
  ref: string,
  match: "exact" | "prefix",
): CodeRefOwner {
  return {
    id: article.id,
    title: article.title,
    type: "knowledge",
    ref,
    match,
    category: article.category,
  };
}

function ownerForWork(
  article: WorkArticle,
  ref: string,
  match: "exact" | "prefix",
): CodeRefOwner {
  return {
    id: article.id,
    title: article.title,
    type: "work",
    ref,
    match,
    phase: article.phase,
    template: article.template,
    priority: article.priority,
    active: ACTIVE_WORK_PHASES.has(article.phase as WorkPhase),
  };
}

/**
 * Classify the relationship between an indexed code-ref and a target path:
 * exact match, directory-ancestor prefix in either direction, or no match.
 * `target.length === 0` is rejected upstream by `collectOwners`.
 */
function pathMatchKind(indexedRef: string, target: string): "exact" | "prefix" | undefined {
  if (!indexedRef) return undefined;
  if (indexedRef === target) return "exact";
  if (isPathPrefix(indexedRef, target) || isPathPrefix(target, indexedRef)) return "prefix";
  return undefined;
}

function isPathPrefix(prefix: string, candidate: string): boolean {
  return candidate.startsWith(`${prefix}/`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareOwners(left: CodeRefOwner, right: CodeRefOwner): number {
  if (left.type !== right.type) return left.type.localeCompare(right.type);
  if (left.match !== right.match) return left.match.localeCompare(right.match);
  const byTitle = left.title.localeCompare(right.title);
  if (byTitle !== 0) return byTitle;
  return left.id.localeCompare(right.id);
}

function riskFor(ref: CodeRefDetail): CodeRefImpact["risk"] {
  if (!ref.exists || ref.summary.policyCount > 0) return "high";
  if (ref.activeWork.some((owner) => owner.phase === WorkPhase.IMPLEMENTATION || owner.phase === WorkPhase.REVIEW)) {
    return "high";
  }
  if (ref.summary.activeWorkCount > 0) return "medium";
  if (ref.summary.ownerCount > 0) return "low";
  return "none";
}

function higherRisk(
  left: ChangedCodeRefImpact["summary"]["highestRisk"],
  right: ChangedCodeRefImpact["summary"]["highestRisk"],
): ChangedCodeRefImpact["summary"]["highestRisk"] {
  const rank = { none: 0, low: 1, medium: 2, high: 3 } satisfies Record<string, number>;
  return rank[right] > rank[left] ? right : left;
}
