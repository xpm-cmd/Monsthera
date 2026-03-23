import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { okJson } from "./response-helpers.js";
import { z } from "zod/v4";
import { VERSION, SUPPORTED_LANGUAGES, STAGE_A_MAX_CANDIDATES, STAGE_B_MAX_EXPANDED, MAX_DIFF_LINES_PER_FILE, HEARTBEAT_TIMEOUT_MS } from "../core/constants.js";
import type { MonstheraContext } from "../core/context.js";
import {
  AgentIdSchema,
  FilePathSchema,
  MAX_TICKET_LONG_TEXT_LENGTH,
  SessionIdSchema,
  parseStringArrayJson,
} from "../core/input-hardening.js";
import * as queries from "../db/queries.js";
import { buildEvidenceBundle, type EvidenceBundleResult } from "../retrieval/evidence-bundle.js";
import { exportAuditTrail } from "../export/audit.js";
import { getHead, getChangedFiles, getDiffStats, getPerFileDiffs, getRecentCommits, isValidCommit } from "../git/operations.js";
import { getIndexedCommit, incrementalIndex, buildIndexOptions } from "../indexing/indexer.js";
import { CAPABILITY_TOOL_NAMES } from "../core/tool-manifest.js";
import { compileSecretPatterns } from "../trust/secret-patterns.js";
import { analyzeFileComplexity } from "../analysis/complexity.js";
import { analyzeTestCoverage } from "../analysis/test-coverage.js";
import { analyzeCoupling } from "../analysis/coupling.js";
import { findDependencyCycles } from "../analysis/cycles.js";
import { suggestActionsForChanges } from "../dispatch/rules.js";
import { loadRepoAgentCatalog } from "../repo-agents/catalog.js";
import { BUILTIN_WORKFLOW_NAMES, listBuiltInWorkflows } from "../workflows/builtins.js";
import { loadCustomWorkflows, summarizeCustomWorkflows } from "../workflows/loader.js";
import {
  CrossInstanceSearchSurfaceSchema,
  searchAcrossRemoteInstances,
} from "../federation/search.js";
import { resolveAgent } from "./resolve-agent.js";

type GetContext = () => Promise<MonstheraContext>;

const ReadToolVerbositySchema = z.enum(["full", "compact", "minimal"]);
export type ReadToolVerbosity = z.infer<typeof ReadToolVerbositySchema>;

const COMPACT_CODE_PACK_LIMIT = 5;
const MINIMAL_CODE_PACK_LIMIT = 3;
const COMPACT_CHANGE_FILE_LIMIT = 20;
const MINIMAL_CHANGE_FILE_LIMIT = 10;
const COMPACT_RECENT_COMMIT_LIMIT = 3;
const MINIMAL_RECENT_COMMIT_LIMIT = 3;
const COMPACT_ISSUE_MATCH_LIMIT = 10;
const MINIMAL_ISSUE_MATCH_LIMIT = 5;
const COMPACT_SUMMARY_LENGTH = 240;
const MINIMAL_SUMMARY_LENGTH = 120;

type CodePackPayload = EvidenceBundleResult & {
  currentHead: string;
  indexStale: boolean;
  autoReindexed?: true;
};

type ChangePackPayload = {
  currentHead: string;
  sinceCommit: string;
  changedFiles: Array<{
    status: string;
    path: string;
    language: string | null;
    summary: string | null;
    hasSecrets: boolean;
    linesAdded: number | null;
    linesRemoved: number | null;
    diff: string | null;
  }>;
  recentCommits: Array<{
    sha: string;
    message: string;
    timestamp: string;
  }>;
};

type IssuePackPayload = {
  currentHead: string;
  query: string;
  matchedNotes: Array<{
    key: string;
    type: string;
    content: string;
    linkedPaths: string[];
    agentId: string | null;
    commitSha: string | null;
    updatedAt: string;
  }>;
  matchedKnowledge: Array<{
    key: string;
    type: string;
    scope: string;
    title: string;
    content: string;
    tags: string[];
    updatedAt: string;
  }>;
};

function truncateText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return value ?? null;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isTruncated(total: number, limit: number): boolean {
  return total > limit;
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeClaimPath(left);
  const b = normalizeClaimPath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function normalizeClaimPath(path: string): string {
  return path.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
}

export function shapeCodePackResult(
  payload: CodePackPayload,
  verbosity: ReadToolVerbosity,
): CodePackPayload | Record<string, unknown> {
  if (verbosity === "full") return payload;

  const candidateLimit = verbosity === "compact" ? COMPACT_CODE_PACK_LIMIT : MINIMAL_CODE_PACK_LIMIT;
  const candidates = payload.candidates.slice(0, candidateLimit).map((candidate) => (
    verbosity === "compact"
      ? {
          path: candidate.path,
          language: candidate.language,
          relevanceScore: candidate.relevanceScore,
          summary: truncateText(candidate.summary, COMPACT_SUMMARY_LENGTH) ?? "",
          provenance: candidate.provenance,
        }
      : {
          path: candidate.path,
          language: candidate.language,
          summary: truncateText(candidate.summary, MINIMAL_SUMMARY_LENGTH) ?? "",
        }
  ));

  return {
    verbosity,
    commit: payload.commit,
    query: payload.query,
    currentHead: payload.currentHead,
    indexStale: payload.indexStale,
    ...(payload.autoReindexed ? { autoReindexed: true } : {}),
    candidateCount: payload.candidates.length,
    ...(isTruncated(payload.candidates.length, candidateLimit)
      ? { candidatesTruncated: true }
      : {}),
    candidates,
  };
}

export function shapeChangePackResult(
  payload: ChangePackPayload,
  verbosity: ReadToolVerbosity,
): ChangePackPayload | Record<string, unknown> {
  if (verbosity === "full") return payload;

  const fileLimit = verbosity === "compact" ? COMPACT_CHANGE_FILE_LIMIT : MINIMAL_CHANGE_FILE_LIMIT;
  const commitLimit = verbosity === "compact" ? COMPACT_RECENT_COMMIT_LIMIT : MINIMAL_RECENT_COMMIT_LIMIT;

  return {
    verbosity,
    currentHead: payload.currentHead,
    sinceCommit: payload.sinceCommit,
    changedFileCount: payload.changedFiles.length,
    changedFilesTruncated: isTruncated(payload.changedFiles.length, fileLimit),
    changedFiles: payload.changedFiles.slice(0, fileLimit).map((file) => (
      verbosity === "compact"
        ? {
            status: file.status,
            path: file.path,
            language: file.language,
            summary: truncateText(file.summary, COMPACT_SUMMARY_LENGTH),
            hasSecrets: file.hasSecrets,
            linesAdded: file.linesAdded,
            linesRemoved: file.linesRemoved,
          }
        : {
            status: file.status,
            path: file.path,
            summary: truncateText(file.summary, MINIMAL_SUMMARY_LENGTH),
            linesAdded: file.linesAdded,
            linesRemoved: file.linesRemoved,
          }
    )),
    recentCommitCount: payload.recentCommits.length,
    recentCommitsTruncated: isTruncated(payload.recentCommits.length, commitLimit),
    recentCommits: payload.recentCommits.slice(0, commitLimit).map((commit) => (
      verbosity === "compact"
        ? commit
        : {
            sha: commit.sha,
            message: truncateText(commit.message, MINIMAL_SUMMARY_LENGTH) ?? "",
            timestamp: commit.timestamp,
          }
    )),
  };
}

export function shapeIssuePackResult(
  payload: IssuePackPayload,
  verbosity: ReadToolVerbosity,
): IssuePackPayload | Record<string, unknown> {
  if (verbosity === "full") return payload;

  const matchLimit = verbosity === "compact" ? COMPACT_ISSUE_MATCH_LIMIT : MINIMAL_ISSUE_MATCH_LIMIT;

  return {
    verbosity,
    currentHead: payload.currentHead,
    query: payload.query,
    matchedNoteCount: payload.matchedNotes.length,
    matchedNotesTruncated: isTruncated(payload.matchedNotes.length, matchLimit),
    matchedNotes: payload.matchedNotes.slice(0, matchLimit).map((note) => (
      verbosity === "compact"
        ? {
            key: note.key,
            type: note.type,
            excerpt: truncateText(note.content, COMPACT_SUMMARY_LENGTH) ?? "",
            linkedPaths: note.linkedPaths.slice(0, 5),
            agentId: note.agentId,
            commitSha: note.commitSha,
            updatedAt: note.updatedAt,
          }
        : {
            key: note.key,
            type: note.type,
            excerpt: truncateText(note.content, MINIMAL_SUMMARY_LENGTH) ?? "",
            updatedAt: note.updatedAt,
          }
    )),
    matchedKnowledgeCount: payload.matchedKnowledge.length,
    matchedKnowledgeTruncated: isTruncated(payload.matchedKnowledge.length, matchLimit),
    matchedKnowledge: payload.matchedKnowledge.slice(0, matchLimit).map((entry) => (
      verbosity === "compact"
        ? {
            key: entry.key,
            type: entry.type,
            scope: entry.scope,
            title: entry.title,
            excerpt: truncateText(entry.content, COMPACT_SUMMARY_LENGTH) ?? "",
            tags: entry.tags.slice(0, 10),
            updatedAt: entry.updatedAt,
          }
        : {
            key: entry.key,
            type: entry.type,
            scope: entry.scope,
            title: entry.title,
            excerpt: truncateText(entry.content, MINIMAL_SUMMARY_LENGTH) ?? "",
            updatedAt: entry.updatedAt,
          }
    )),
  };
}

export function registerReadTools(server: McpServer, getContext: GetContext): void {
  // ─── status ───────────────────────────────────────────────
  server.tool("status", "Get Monsthera index status and connected agents", {}, async () => {
    const c = await getContext();
    const indexState = queries.getIndexState(c.db, c.repoId);
    const activeSessions = queries.getLiveSessions(
      c.db,
      new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString(),
    );
    const head = await getHead({ cwd: c.repoPath });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          version: VERSION,
          repoPath: c.repoPath,
          coordinationTopology: c.config.coordinationTopology,
          indexedCommit: indexState?.dbIndexedCommit ?? null,
          currentHead: head,
          indexStale: indexState?.dbIndexedCommit !== head,
          fileCount: queries.getFileCount(c.db, c.repoId),
          connectedAgents: activeSessions.length,
          searchBackend: c.searchRouter.getActiveBackendName(),
          debugLogging: c.config.debugLogging,
          claimEnforceMode: c.config.claimEnforceMode ?? "advisory",
          lifecycle: {
            enabled: c.config.lifecycle?.enabled ?? false,
            rules: {
              autoTriage: c.config.lifecycle?.autoTriageOnCreate ?? false,
              autoClose: (c.config.lifecycle?.autoCloseResolvedAfterMs ?? 0) > 0,
              autoReview: c.config.lifecycle?.autoReviewOnPatch ?? false,
              autoCascade: c.config.lifecycle?.autoCascadeBlocked ?? false,
            },
          },
        }),
      }],
    };
  });

  // ─── capabilities ─────────────────────────────────────────
  server.tool("capabilities", "List Monsthera capabilities and supported features", {}, async () => {
    const c = await getContext();
    const repoAgentCatalog = await loadRepoAgentCatalog(c.repoPath);
    const customWorkflowCatalog = await loadCustomWorkflows(c.repoPath);
    const customWorkflows = summarizeCustomWorkflows(customWorkflowCatalog.workflows);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          version: VERSION,
          tools: [...CAPABILITY_TOOL_NAMES],
          workflows: [...listBuiltInWorkflows(), ...customWorkflows],
          customWorkflows,
          customWorkflowWarnings: customWorkflowCatalog.warnings,
          ticketStatuses: ["backlog", "technical_analysis", "approved", "in_progress", "in_review", "ready_for_commit", "blocked", "resolved", "closed", "wont_fix"],
          ticketSeverities: ["critical", "high", "medium", "low"],
          languages: [...SUPPORTED_LANGUAGES],
          trustTiers: ["A", "B"],
          agentIdentity: {
            fields: ["provider", "model", "modelFamily", "modelVersion", "identitySource"],
            identitySources: ["self_declared", "config", "peer_asserted", "system_assigned"],
            uniquenessKey: "provider+model",
            strictDiversityEligibility: "requires both provider and model",
          },
          roles: ["developer", "reviewer", "facilitator", "planner", "observer", "admin"],
          coordinationTopologies: ["hub-spoke", "hybrid", "mesh"],
          maxCandidates: STAGE_A_MAX_CANDIDATES,
          maxExpanded: STAGE_B_MAX_EXPANDED,
          maxCodeSpanLines: 200,
          semanticSearch: {
            available: c.searchRouter.getSemanticReranker()?.isAvailable() ?? false,
            model: "all-MiniLM-L6-v2",
            embeddingDim: 384,
          },
          repoAgents: repoAgentCatalog.repoAgents.map((agent) => ({
            name: agent.name,
            description: agent.description,
            filePath: agent.filePath,
            role: agent.role,
            reviewRole: agent.reviewRole,
            tags: agent.tags,
          })),
          availableReviewRoles: repoAgentCatalog.availableReviewRoles,
          repoAgentWarnings: repoAgentCatalog.warnings,
        }),
      }],
    };
  });

  // ─── schema ───────────────────────────────────────────────
  server.tool(
    "schema",
    "Get the input schema for a specific Monsthera tool",
    { toolName: z.string().describe("Tool name") },
    async ({ toolName }) => {
      const c = await getContext();
      const customWorkflows = await loadCustomWorkflows(c.repoPath);
      const discoveredCustomNames = customWorkflows.workflows.map((workflow) => workflow.name);
      const runWorkflowNameSchema = discoveredCustomNames.length > 0
        ? `string (built-in: ${BUILTIN_WORKFLOW_NAMES.join("|")}; custom: ${discoveredCustomNames.join("|")})`
        : `string (built-in: ${BUILTIN_WORKFLOW_NAMES.join("|")}; custom: custom:<name>)`;
      const schemas: Record<string, object> = {
        // ── read tools ──
        status: {},
        capabilities: {},
        schema: { toolName: "string (required)" },
        get_code_pack: {
          query: "string (1-1000 chars, required)",
          scope: "string (optional path prefix filter)",
          expand: "boolean (default false)",
          maxFiles: "number 1-20 (optional, limits expanded files when expand=true)",
          verbosity: "enum: full|compact|minimal (default full)",
        },
        get_change_pack: {
          sinceCommit: "string (optional, defaults to last 5 commits)",
          verbosity: "enum: full|compact|minimal (default full)",
        },
        get_issue_pack: {
          query: "string (1-1000 chars, required)",
          verbosity: "enum: full|compact|minimal (default full)",
        },
        search_remote_instances: {
          query: "string (1-1000 chars, required)",
          surface: "enum: code|knowledge|tickets",
          limit: "number 1-20 (default 10)",
          scope: "string (optional path or scope filter)",
          type: "string (optional, knowledge only)",
          status: "enum: ticket status (optional, tickets only)",
          severity: "enum: ticket severity (optional, tickets only)",
          peerIds: "string[] (optional peer filter)",
        },
        run_workflow: {
          name: runWorkflowNameSchema,
          params: "object (optional workflow parameters)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        analyze_complexity: {
          filePath: "string (file path relative to repo root, required)",
        },
        analyze_test_coverage: {
          filePath: "string (file path relative to repo root, required)",
        },
        suggest_actions: {
          changedPaths: "string[] (repo-relative changed file paths, required)",
        },
        suggest_next_work: {
          agentId: "string (required)",
          sessionId: "string (required)",
          limit: "number 1-20 (default 5)",
        },
        // ── knowledge tools ──
        store_knowledge: {
          type: "enum: decision|gotcha|pattern|context|plan|solution|preference",
          scope: "enum: repo|global (default repo)",
          title: "string (1-200 chars)",
          content: "string (1-10000 chars)",
          tags: "string[] (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        search_knowledge: {
          query: "string (1-1000 chars)",
          scope: "enum: repo|global|all (default all)",
          type: "enum (optional, same as store_knowledge.type)",
          limit: "number 1-50 (default 10)",
        },
        query_knowledge: {
          scope: "enum: repo|global|all (default all)",
          type: "enum (optional)",
          tags: "string[] (optional, AND logic)",
          status: "enum: active|archived (default active)",
          limit: "number 1-100 (default 20)",
        },
        archive_knowledge: {
          key: "string",
          scope: "enum: repo|global",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        delete_knowledge: {
          key: "string",
          scope: "enum: repo|global",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── coordination tools ──
        send_coordination: {
          type: "enum: task_claim|task_release|patch_intent|conflict_alert|status_update|broadcast",
          payload: "object (arbitrary key-value)",
          to: "string|null (default null = broadcast)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        poll_coordination: {
          agentId: "string (required)",
          sessionId: "string (required)",
          since: "string ISO timestamp (optional)",
          limit: "number 1-100 (default 20)",
        },
        // ── agent tools ──
        register_agent: {
          name: "string (1-100 chars)",
          type: "string (default unknown)",
          provider: "string (optional normalized provider)",
          model: "string (optional normalized model)",
          modelFamily: "string (optional model family)",
          modelVersion: "string (optional model version)",
          identitySource: "enum: self_declared|config|peer_asserted|system_assigned (optional)",
          desiredRole: "enum: developer|reviewer|facilitator|observer|admin (default observer)",
          authToken: "string (optional, required when registrationAuth is enabled for the requested role)",
        },
        agent_status: { agentId: "string (optional, omit for all)" },
        broadcast: {
          message: "string (1-500 chars)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        claim_files: {
          agentId: "string (required)",
          sessionId: "string (required)",
          paths: "string[] (1-50 paths, advisory lock)",
        },
        end_session: {
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── index tools ──
        request_reindex: {
          full: "boolean (default false)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── patch tools ──
        propose_patch: {
          diff: "string (unified diff, required)",
          message: "string (1-1000 chars)",
          baseCommit: "string (min 7 chars SHA)",
          bundleId: "string (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
          dryRun: "boolean (default false)",
          ticketId: "string (optional, links patch to ticket)",
        },
        list_patches: {
          state: "enum: proposed|validated|applied|committed|stale|failed (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── note tools ──
        propose_note: {
          type: "enum: issue|decision|change_note|gotcha|runbook|repo_map|module_map|file_summary",
          content: "string (1-10000 chars)",
          linkedPaths: "string[] (optional)",
          metadata: "object (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        list_notes: {
          type: "enum: issue|decision|change_note|gotcha|runbook|repo_map|module_map|file_summary (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── ticket tools ──
        create_ticket: {
          title: "string (1-200 chars)",
          description: "string (1-5000 chars)",
          severity: "enum: critical|high|medium|low (default medium)",
          priority: "number 0-10 (default 5)",
          tags: "string[] (optional)",
          affectedPaths: "string[] (optional)",
          acceptanceCriteria: `string (optional, max ${MAX_TICKET_LONG_TEXT_LENGTH})`,
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        assign_ticket: {
          ticketId: "string (TKT-...)",
          assigneeAgentId: "string (required)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        update_ticket_status: {
          ticketId: "string (TKT-...)",
          status: "enum: backlog|technical_analysis|approved|in_progress|in_review|ready_for_commit|blocked|resolved|closed|wont_fix",
          comment: "string (optional, max 500)",
          skipKnowledgeCapture: "boolean (optional, only relevant for resolved|closed transitions)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        update_ticket: {
          ticketId: "string (TKT-...)",
          title: "string (optional)",
          description: "string (optional)",
          severity: "enum (optional)",
          priority: "number 0-10 (optional)",
          tags: "string[] (optional)",
          affectedPaths: "string[] (optional)",
          acceptanceCriteria: `string (optional, max ${MAX_TICKET_LONG_TEXT_LENGTH})`,
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        list_tickets: {
          agentId: "string (required)",
          sessionId: "string (required)",
          status: "enum (optional)",
          assigneeAgentId: "string (optional)",
          severity: "enum (optional)",
          creatorAgentId: "string (optional)",
          tags: "string[] (optional, AND logic filter)",
          limit: "number 1-100 (default 20)",
        },
        search_tickets: {
          query: "string (1-1000 chars)",
          agentId: "string (required)",
          sessionId: "string (required)",
          status: "enum (optional)",
          severity: "enum (optional)",
          assigneeAgentId: "string (optional)",
          limit: "number 1-50 (default 10)",
        },
        get_ticket: {
          ticketId: "string (TKT-...)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        comment_ticket: {
          ticketId: "string (TKT-...)",
          content: `string (1-${MAX_TICKET_LONG_TEXT_LENGTH} chars)`,
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        assign_council: {
          ticketId: "string (TKT-...)",
          councilAgentId: "string (required)",
          specialization: "enum: architect|simplifier|security|performance|patterns|design",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        submit_verdict: {
          ticketId: "string (TKT-...)",
          specialization: "enum: architect|simplifier|security|performance|patterns|design",
          verdict: "enum: pass|fail|abstain",
          reasoning: `string (optional, max ${MAX_TICKET_LONG_TEXT_LENGTH})`,
          transition: "enum: technical_analysis→approved|in_review→ready_for_commit (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        check_consensus: {
          ticketId: "string (TKT-...)",
          transition: "enum: technical_analysis→approved|in_review→ready_for_commit (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        link_tickets: {
          fromTicketId: "string (TKT-...)",
          toTicketId: "string (TKT-...)",
          relationType: "enum: blocks|relates_to",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        unlink_tickets: {
          fromTicketId: "string (TKT-...)",
          toTicketId: "string (TKT-...)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── protection tools ──
        add_protected_artifact: {
          pathPattern: "string (1-500 chars)",
          reason: "string (1-500 chars)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        remove_protected_artifact: {
          pathPattern: "string (1-500 chars)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        list_protected_artifacts: {
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── analysis tools ──
        lookup_dependencies: {
          filePath: "string (file path relative to repo root, required)",
        },
        trace_dependencies: {
          filePath: "string (file path relative to repo root, required)",
          direction: "enum: inbound|outbound|both (default outbound)",
          maxDepth: "number 1-5 (default 3)",
        },
        analyze_coupling: {
          scope: "string (optional path prefix)",
          sortBy: "enum: instability|totalCoupling|afferent|efferent (default totalCoupling)",
          limit: "number 1-100 (default 20)",
        },
        find_dependency_cycles: {
          scope: "string (optional path prefix)",
          maxCycles: "number 1-100 (default 50)",
        },
        find_references: {
          symbolName: "string (required)",
          direction: "enum: forward|reverse (default reverse)",
          kind: "enum: call|member_call|type_ref|all (default all)",
          limit: "number 1-200 (default 50)",
        },
        // ── export tools ──
        export_audit: {
          format: "enum: json|csv (required)",
          agentId: "string (optional, filter by agent)",
          sessionId: "string (optional, filter by session)",
          since: "string ISO timestamp (optional)",
          until: "string ISO timestamp (optional)",
          limit: "number 1-10000 (default 10000)",
        },
        // ── simulation tools ──
        run_simulation: {
          targetCorpusSize: "number 1-1000 (default 200)",
          realWorkBatchSize: "number 1-100 (default 50)",
          skipRealWork: "boolean (default true)",
          phase: "enum: all|A|B|C|D|E (default all)",
          outputPath: "string (default .monsthera/simulation-results.jsonl)",
          ticketTimeoutMs: "number 10000-600000 (default 120000)",
        },
        run_optimization: {
          iterations: "number 1-20 (default 3)",
          topK: "number 1-50 (default 5)",
          testCommand: "string (default pnpm test)",
          testTimeoutMs: "number 10000-600000 (default 120000)",
          outputPath: "string (default .monsthera/simulation-results.jsonl)",
          ticketTimeoutMs: "number 10000-600000 (default 120000)",
        },
        // ── job tools ──
        create_loop: {
          loopId: "string (1-100 chars)",
          template: "enum: full-team|full-team-unified-council|small-team|custom (default full-team)",
          slots: "object[] (required if template=custom; each: role, label, description, systemPrompt, contextJson, ticketId)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        list_jobs: {
          loopId: "string (optional, 1-100 chars)",
          status: "enum: open|claimed|active|completed|abandoned (optional)",
          role: "string (optional, max 50 chars)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        claim_job: {
          slotId: "string (optional, max 50 chars)",
          loopId: "string (optional, max 100 chars)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        update_job_progress: {
          slotId: "string (1-50 chars)",
          progressNote: "string (optional, max 500 chars)",
          status: "enum: active|completed (optional)",
          ticketId: "string (optional, max 50 chars)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        complete_job: {
          slotId: "string (1-50 chars)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        release_job: {
          slotId: "string (1-50 chars)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── work group tools ──
        create_work_group: {
          title: "string (1-200 chars)",
          description: "string (optional, max 2000 chars)",
          tags: "string[] (optional, max 25 tags)",
          ticketIds: "string[] (optional, max 50 TKT-... IDs)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        update_work_group: {
          groupId: "string (WG-...)",
          title: "string (optional, 1-200 chars)",
          description: "string (optional, max 2000 chars)",
          status: "enum: open|completed|cancelled (optional)",
          tags: "string[] (optional, max 25 tags)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        add_tickets_to_group: {
          groupId: "string (WG-...)",
          ticketIds: "string[] (1-50 TKT-... IDs)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        remove_tickets_from_group: {
          groupId: "string (WG-...)",
          ticketIds: "string[] (1-50 TKT-... IDs)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        list_work_groups: {
          status: "enum: open|completed|cancelled (optional)",
          tag: "string (optional, filter by tag)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── decompose tools ──
        decompose_goal: {
          goal: "string (1-1000 chars)",
          scope: "string (optional, max 500 chars, path scope filter)",
          proposedTasks: "object[] (1-20 tasks with: title, description, affectedPaths, tags, severity, priority, rationale, dependsOn)",
          maxTickets: "number 1-20 (default 8)",
          dryRun: "boolean (default true)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── wave/convoy tools ──
        compute_waves: {
          groupId: "string (WG-...)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        launch_convoy: {
          groupId: "string (WG-...)",
          testCommand: "string (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        advance_wave: {
          groupId: "string (WG-...)",
          testCommand: "string (optional)",
          testTimeoutMs: "number (positive, optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        get_wave_status: {
          groupId: "string (WG-...)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── spawn tools ──
        spawn_agent: {
          ticketId: "string (TKT-...)",
          role: "enum: developer|reviewer (default developer)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── governance tools ──
        get_governance_settings: {
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        get_ticket_metrics: {
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        list_events: {
          agentId: "string (required)",
          sessionId: "string (required)",
          limit: "number 1-200 (default 50)",
          since: "string ISO timestamp (optional)",
        },
        // ── ticket tools (additional) ──
        list_verdicts: {
          agentId: "string (required)",
          sessionId: "string (required)",
          targetAgentId: "string (optional, defaults to caller)",
          ticketId: "string (optional, TKT-...)",
          specialization: "string (optional)",
          limit: "number 1-100 (default 50)",
        },
        prune_stale_relations: {
          dryRun: "boolean (default true)",
          olderThanDays: "number 1-90 (default 7)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
      };

      const s = schemas[toolName];
      if (!s) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ tool: toolName, inputSchema: s }),
        }],
      };
    },
  );

  // ─── get_code_pack ────────────────────────────────────────
  server.tool(
    "get_code_pack",
    "Search for relevant code files and return an Evidence Bundle. Auto-reindexes incrementally when stale. For convention, architecture, or historical questions, use get_issue_pack instead.",
    {
      query: z.string().trim().min(1).max(1000).describe("Search query"),
      scope: z.string().optional().describe("Path scope filter"),
      expand: z.boolean().default(false).describe("Include code spans"),
      maxFiles: z.number().int().min(1).max(20).optional().describe("Max files to expand when expand=true"),
      verbosity: ReadToolVerbositySchema.default("full").describe("Response verbosity"),
    },
    async ({ query, scope, expand, maxFiles, verbosity }) => {
      const c = await getContext();
      const head = await getHead({ cwd: c.repoPath });
      const indexedCommit = getIndexedCommit(c.db, c.repoId);

      if (!indexedCommit) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "No index available. Run request_reindex first.",
              indexStale: true,
              currentHead: head,
            }),
          }],
          isError: true,
        };
      }

      // Auto-incremental reindex when stale (cheap: just git diff + changed files)
      let autoReindexed = false;
      let effectiveCommit = indexedCommit;
      if (indexedCommit !== head) {
        try {
          const result = await incrementalIndex(indexedCommit, buildIndexOptions({
            repoPath: c.repoPath,
            repoId: c.repoId,
            db: c.db,
            sensitiveFilePatterns: c.config.sensitiveFilePatterns,
            secretPatterns: compileSecretPatterns(c.config.secretPatterns),
            excludePatterns: c.config.excludePatterns,
            onProgress: (msg) => c.insight.detail(msg),
            semanticReranker: c.searchRouter.getSemanticReranker(),
          }));
          await c.searchRouter.rebuildIndex(c.repoId);
          autoReindexed = true;
          effectiveCommit = result.commit;
          c.insight.info(`Auto-reindex: ${result.filesIndexed} files in ${result.durationMs}ms`);
        } catch {
          // Non-fatal: search with stale index rather than fail
          c.insight.debug("Auto-reindex failed, using stale index");
        }
      }

      const rawResults = await c.searchRouter.search(query, c.repoId, 10, scope);
      // Nonsense guard: dynamic threshold — scoped queries have smaller candidate pools so scores are lower
      const threshold = scope
        ? c.config.search.thresholds.scopedRelevance
        : c.config.search.thresholds.relevance;
      const searchResults = rawResults.filter((r) => r.score >= threshold);
      c.insight.debug(`get_code_pack: "${query}" → ${rawResults.length} raw, ${searchResults.length} above threshold (${threshold})`);

      const bundle = await buildEvidenceBundle({
        query,
        repoId: c.repoId,
        repoPath: c.repoPath,
        commit: effectiveCommit,
        trustTier: "A",
        searchBackend: c.searchRouter.getActiveBackendName(),
        searchResults,
        db: c.db,
        expand: verbosity === "full" ? expand : false,
        maxFiles,
        secretPatterns: compileSecretPatterns(c.config.secretPatterns),
      });

      const payload = shapeCodePackResult({
        ...bundle,
        indexStale: !autoReindexed && indexedCommit !== head,
        currentHead: head,
        ...(autoReindexed && { autoReindexed: true as const }),
      }, verbosity);

      return okJson(payload);
    },
  );

  // ─── get_change_pack ──────────────────────────────────────
  server.tool(
    "get_change_pack",
    "Get recently changed files with summaries and commit context",
    {
      sinceCommit: z.string().optional().describe("Base commit (defaults to last 5)"),
      verbosity: ReadToolVerbositySchema.default("full").describe("Response verbosity"),
    },
    async ({ sinceCommit, verbosity }) => {
      const c = await getContext();
      const head = await getHead({ cwd: c.repoPath });

      let base = sinceCommit;
      if (base) {
        const valid = await isValidCommit(base, { cwd: c.repoPath });
        if (!valid) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: `Invalid commit hash: ${base}`,
                hint: "Provide a valid commit SHA or omit sinceCommit to use recent history",
              }),
            }],
            isError: true,
          };
        }
      } else {
        const recent = await getRecentCommits(6, { cwd: c.repoPath });
        base = recent.at(-1)?.sha ?? head;
      }

      const changes = await getChangedFiles(base, head, { cwd: c.repoPath });
      const [diffStats, fileDiffs] = await Promise.all([
        getDiffStats(base, head, { cwd: c.repoPath }),
        getPerFileDiffs(base, head, MAX_DIFF_LINES_PER_FILE, { cwd: c.repoPath }),
      ]);
      c.insight.debug(`get_change_pack: ${changes.length} files since ${base.slice(0, 7)}`);

      const enriched = changes.map((ch) => {
        const f = queries.getFileByPath(c.db, c.repoId, ch.path);
        const stats = diffStats.get(ch.path);
        return {
          status: ch.status,
          path: ch.path,
          language: f?.language ?? null,
          summary: f?.summary ?? null,
          hasSecrets: f?.hasSecrets ?? false,
          linesAdded: stats?.added ?? null,
          linesRemoved: stats?.removed ?? null,
          diff: fileDiffs.get(ch.path) ?? null,
        };
      });

      const recentCommits = await getRecentCommits(5, { cwd: c.repoPath });

      const payload = shapeChangePackResult({
        currentHead: head,
        sinceCommit: base,
        changedFiles: enriched,
        recentCommits,
      }, verbosity);

      return okJson(payload);
    },
  );

  // ─── get_issue_pack ───────────────────────────────────────
  server.tool(
    "get_issue_pack",
    "Search notes (issues, decisions, change notes) for context",
    {
      query: z.string().trim().min(1).max(1000).describe("Search query"),
      verbosity: ReadToolVerbositySchema.default("full").describe("Response verbosity"),
    },
    async ({ query, verbosity }) => {
      const c = await getContext();
      const head = await getHead({ cwd: c.repoPath });

      const allNotes = queries.getNotesByRepo(c.db, c.repoId);
      const q = query.toLowerCase();
      const matchedNotes = allNotes.filter((n) =>
        n.content.toLowerCase().includes(q) ||
        n.key.toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q),
      );

      // Search knowledge entries via FTS5 (always available, no model dependency)
      const searchKnowledgeFts = (sqlite: typeof c.sqlite, db: typeof c.db, scopeLabel: string) => {
        const ftsResults = c.searchRouter.searchKnowledge(sqlite, query, 10);
        return ftsResults.map((r) => {
          const entry = queries.getKnowledgeById(db, r.knowledgeId);
          if (!entry) return null;
          return {
            key: entry.key,
            type: entry.type,
            scope: scopeLabel,
            title: entry.title,
            content: entry.content.slice(0, 500) + (entry.content.length > 500 ? "..." : ""),
            tags: parseStringArrayJson(entry.tagsJson, {
              maxItems: 25,
              maxItemLength: 64,
            }),
            updatedAt: entry.updatedAt,
          };
        }).filter(Boolean);
      };

      const matchedKnowledge = [
        ...searchKnowledgeFts(c.sqlite, c.db, "repo"),
        ...(c.globalSqlite && c.globalDb ? searchKnowledgeFts(c.globalSqlite, c.globalDb, "global") : []),
      ];

      const payload = shapeIssuePackResult({
        currentHead: head,
        query,
        matchedNotes: matchedNotes.map((n) => ({
          key: n.key,
          type: n.type,
          content: n.content,
          linkedPaths: parseStringArrayJson(n.linkedPathsJson, {
            maxItems: 50,
            maxItemLength: 500,
          }),
          agentId: n.agentId,
          commitSha: n.commitSha,
          updatedAt: n.updatedAt,
        })),
        matchedKnowledge: matchedKnowledge as IssuePackPayload["matchedKnowledge"],
      }, verbosity);

      return okJson(payload);
    },
  );

  // ─── search_remote_instances ─────────────────────────────
  server.tool(
    "search_remote_instances",
    "Query configured remote Monsthera instances over authenticated HTTP and merge read-only search hits with explicit provenance.",
    {
      query: z.string().trim().min(1).max(1000).describe("Search query"),
      surface: CrossInstanceSearchSurfaceSchema.describe("Remote search surface"),
      limit: z.number().int().min(1).max(20).default(10).describe("Max hits per remote"),
      scope: z.string().trim().min(1).max(500).optional().describe("Optional scope or path filter"),
      type: z.string().trim().min(1).max(100).optional().describe("Knowledge type filter"),
      status: z.enum(["backlog", "technical_analysis", "approved", "in_progress", "in_review", "ready_for_commit", "blocked", "resolved", "closed", "wont_fix"]).optional().describe("Ticket status filter"),
      severity: z.enum(["critical", "high", "medium", "low"]).optional().describe("Ticket severity filter"),
      peerIds: z.array(z.string().trim().min(1).max(64)).max(20).optional().describe("Optional remote peer filter"),
    },
    async ({ query, surface, limit, scope, type, status, severity, peerIds }) => {
      const c = await getContext();
      const result = await searchAcrossRemoteInstances(c, {
        query,
        surface,
        limit,
        scope,
        type,
        status,
        severity,
      }, {
        peerIds,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result),
        }],
      };
    },
  );

  // ─── analyze_complexity ────────────────────────────────
  server.tool(
    "analyze_complexity",
    "Analyze a single source file and return stable complexity metrics such as LOC, function count, max nesting, and a cyclomatic-like score.",
    {
      filePath: FilePathSchema.describe("File path relative to repo root"),
    },
    async ({ filePath }) => {
      const c = await getContext();
      const result = await analyzeFileComplexity(c.repoPath, filePath);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result),
        }],
      };
    },
  );

  // ─── analyze_test_coverage ──────────────────────────────
  server.tool(
    "analyze_test_coverage",
    "Analyze structural test coverage for a single source file and return explicit tested, untested, or unknown signals without implying runtime coverage.",
    {
      filePath: FilePathSchema.describe("File path relative to repo root"),
    },
    async ({ filePath }) => {
      const c = await getContext();
      const result = await analyzeTestCoverage(c.db, c.repoId, c.repoPath, filePath);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result),
        }],
      };
    },
  );


  // ─── analyze_coupling ──────────────────────────────────
  server.tool(
    "analyze_coupling",
    "Analyze coupling metrics between files. Returns afferent (inbound), efferent (outbound), instability index, and total coupling per file. Uses existing import graph data.",
    {
      scope: z.string().optional().describe("Path prefix to scope analysis (e.g. 'src/api/')"),
      sortBy: z.enum(["instability", "totalCoupling", "afferent", "efferent"]).default("totalCoupling").describe("Sort results by this metric"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max results to return"),
    },
    async ({ scope, sortBy, limit }) => {
      const c = await getContext();
      const metrics = analyzeCoupling(c.db, c.repoId, { scope, sortBy, limit });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            scope: scope ?? "(all files)",
            sortBy,
            count: metrics.length,
            metrics,
          }),
        }],
      };
    },
  );

  // ─── find_dependency_cycles ────────────────────────────
  server.tool(
    "find_dependency_cycles",
    "Detect circular import chains in the codebase. Returns deduplicated cycles sorted by length (shorter cycles first). Uses DFS on the existing import graph.",
    {
      scope: z.string().optional().describe("Path prefix to scope analysis (e.g. 'src/')"),
      maxCycles: z.number().int().min(1).max(100).default(50).describe("Maximum number of cycles to report"),
    },
    async ({ scope, maxCycles }) => {
      const c = await getContext();
      const cycles = findDependencyCycles(c.db, c.repoId, { scope, maxCycles });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            scope: scope ?? "(all files)",
            totalCycles: cycles.length,
            cycles,
          }),
        }],
      };
    },
  );

  // ─── suggest_actions ────────────────────────────────────
  server.tool(
    "suggest_actions",
    "Advisory-only rule engine for changed paths. Returns recommended Monsthera tools, required review roles, quorum, and rule-level reasoning.",
    {
      changedPaths: z.array(FilePathSchema).max(100).describe("Repo-relative changed file paths"),
    },
    async ({ changedPaths }) => {
      const c = await getContext();
      const result = suggestActionsForChanges(changedPaths, c.repoPath);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result),
        }],
      };
    },
  );

  // ─── suggest_next_work ──────────────────────────────────
  server.tool(
    "suggest_next_work",
    "Suggest approved tickets that match your claimed files. Returns ranked list by path overlap and priority.",
    {
      agentId: AgentIdSchema.describe("Your agent ID"),
      sessionId: SessionIdSchema.describe("Your session ID"),
      limit: z.number().int().min(1).max(20).default(5).describe("Max suggestions"),
    },
    async ({ agentId, sessionId, limit }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved.ok) {
        return {
          content: [{ type: "text" as const, text: resolved.error }],
          isError: true,
        };
      }

      const session = queries.getSession(c.db, resolved.agent.sessionId);
      const claimed = parseStringArrayJson(session?.claimedFilesJson, {
        maxItems: 50,
        maxItemLength: 500,
      });

      const approved = queries.getTicketsByRepo(c.db, c.repoId, { status: "approved" });
      const unassigned = approved.filter((t) => !t.assigneeAgentId);

      // Wave-awareness: exclude tickets that belong to a launched convoy
      // but are NOT in the current wave or NOT in "dispatched" status.
      // Wrapped in try/catch for backwards compatibility with older DBs
      // that may not have the work_group_tickets table yet.
      let candidates = unassigned;
      try {
        candidates = unassigned.filter((ticket) => {
          const convoyInfo = queries.getLaunchedWorkGroupsForTicket(c.db, ticket.id);
          if (convoyInfo.length === 0) return true;
          return convoyInfo.some(
            (ci) => ci.waveNumber === ci.currentWave && ci.waveStatus === "dispatched"
          );
        });
      } catch {
        // Table may not exist in older DBs — skip wave filtering
      }

      const scored = candidates.map((ticket) => {
        const affected = parseStringArrayJson(ticket.affectedPathsJson, {
          maxItems: 100,
          maxItemLength: 500,
        });
        const overlapPaths = [...new Set(claimed.filter((cp) =>
          affected.some((ap) => pathsOverlap(cp, ap)),
        ))];
        const rankingScore = overlapPaths.length * 100 + ticket.priority;
        return {
          internalId: ticket.id,
          ticketId: ticket.ticketId,
          title: ticket.title,
          status: ticket.status,
          severity: ticket.severity,
          priority: ticket.priority,
          affectedPaths: affected,
          overlapPaths,
          overlapScore: overlapPaths.length,
          rankingScore,
        };
      });

      scored.sort((a, b) => b.rankingScore - a.rankingScore || a.ticketId.localeCompare(b.ticketId));

      const top = scored[0] ?? null;
      const topScore = top?.rankingScore ?? 0;
      const topOverlap = top?.overlapScore ?? 0;
      const tiedTop = scored.filter((ticket) => ticket.rankingScore === topScore && ticket.overlapScore === topOverlap);
      const hasPriorityOnlyWinner = claimed.length === 0 && tiedTop.length === 1 && top !== null;
      const matchKind = topOverlap === 0
        ? "no_match"
        : tiedTop.length > 1
          ? "ambiguous_match"
          : "clear_match";
      const matchReason = matchKind === "clear_match" && top
        ? `${top.ticketId} has the strongest overlap (${top.overlapScore}) and priority (${top.priority}).`
        : matchKind === "ambiguous_match"
          ? `${tiedTop.length} approved tickets share the same top overlap/priority score.`
          : claimed.length === 0
            ? "No claimed files on this session, so suggestions are priority-only."
            : "No approved tickets overlap the currently claimed files.";
      const routingRecommendation = matchKind === "clear_match" && top
        ? { action: "recommend", ticketId: top.ticketId, confidence: "high" as const }
        : hasPriorityOnlyWinner && top
          ? {
            action: "recommend",
            ticketId: top.ticketId,
            confidence: "medium" as const,
            basis: "priority_only" as const,
          }
        : matchKind === "ambiguous_match"
          ? { action: "review_manually", ticketIds: tiedTop.map((ticket) => ticket.ticketId), confidence: "medium" as const }
          : { action: "review_manually", ticketIds: [] as string[], confidence: "low" as const };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            match: {
              kind: matchKind,
              reason: matchReason,
            },
            routingRecommendation,
            suggestions: scored.slice(0, limit).map((ticket) => {
              let waveContext: { groupId: string; wave: number | null; integrationBranch: string | null } | undefined;
              try {
                const convoyInfo = queries.getLaunchedWorkGroupsForTicket(c.db, ticket.internalId);
                if (convoyInfo.length > 0) {
                  waveContext = {
                    groupId: convoyInfo[0]!.groupId,
                    wave: convoyInfo[0]!.waveNumber,
                    integrationBranch: convoyInfo[0]!.integrationBranch,
                  };
                }
              } catch {
                // Table may not exist in older DBs
              }
              return {
                ...ticket,
                matchKind: ticket.overlapScore === 0
                  ? "no_match"
                  : ticket.rankingScore === topScore
                    ? matchKind
                    : "possible_match",
                reason: ticket.overlapScore > 0
                  ? `${ticket.overlapScore} claimed path(s) overlap affected paths; priority=${ticket.priority}.`
                  : `No claimed-path overlap; priority=${ticket.priority}.`,
                waveContext,
              };
            }),
            totalApprovedUnassigned: candidates.length,
            claimedPaths: claimed,
          }),
        }],
      };
    },
  );

  // ─── lookup_dependencies ─────────────────────────────────
  server.tool(
    "lookup_dependencies",
    "Look up file dependencies from the imports index. Returns what a file imports (forward) and which files import it (reverse).",
    {
      filePath: z.string().min(1).describe("File path relative to repo root"),
    },
    async ({ filePath }) => {
      const c = await getContext();
      const file = queries.getFileByPath(c.db, c.repoId, filePath);

      const forward = file
        ? queries.getImportsForFile(c.db, file.id).map((imp) => ({
            targetPath: imp.targetPath,
            kind: imp.kind,
          }))
        : [];

      const reverseRows = queries.getFilesImporting(c.db, filePath);
      const reverse = reverseRows.map((row) => ({
        sourcePath: row.files.path,
        importPath: row.imports.targetPath,
        kind: row.imports.kind,
      }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            filePath,
            indexed: !!file,
            forward,
            reverse,
          }),
        }],
      };
    },
  );


  // ─── find_references ────────────────────────────────────
  server.tool(
    "find_references",
    "Find who calls/uses a given symbol (reverse) or what a symbol calls/uses (forward). Returns symbol-level reference edges extracted during indexing.",
    {
      symbolName: z.string().min(1).describe("Symbol name to search for"),
      direction: z.enum(["forward", "reverse"]).default("reverse").describe(
        "forward: what does this symbol call? reverse: who calls this symbol?"
      ),
      kind: z.enum(["call", "member_call", "type_ref", "all"]).default("all").describe(
        "Filter by reference kind: call (direct function calls), member_call (method calls on objects), type_ref (type annotations/inheritance), all"
      ),
      limit: z.number().int().min(1).max(200).default(50).describe("Max results to return"),
    },
    async ({ symbolName, direction, kind, limit }) => {
      const c = await getContext();
      const filterKind = kind === "all" ? undefined : kind;

      let results;
      if (direction === "reverse") {
        // Who references symbolName?
        const rows = queries.getReferencesTo(c.db, c.repoId, symbolName, filterKind, limit);
        results = rows.map((row) => ({
          sourceFile: row.files.path,
          sourceSymbol: row.symbol_references.sourceSymbolName,
          targetName: row.symbol_references.targetName,
          kind: row.symbol_references.referenceKind,
          line: row.symbol_references.line,
        }));
      } else {
        // What does symbolName reference?
        const rows = queries.getReferencesFrom(c.db, c.repoId, symbolName, filterKind, limit);
        results = rows.map((row) => ({
          sourceFile: row.files.path,
          sourceSymbol: row.symbol_references.sourceSymbolName,
          targetName: row.symbol_references.targetName,
          kind: row.symbol_references.referenceKind,
          line: row.symbol_references.line,
        }));
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            symbolName,
            direction,
            kind,
            totalResults: results.length,
            references: results,
          }),
        }],
      };
    },
  );

  // ─── trace_dependencies ─────────────────────────────────
  server.tool(
    "trace_dependencies",
    "Trace transitive dependency chains with configurable depth. Returns all files reachable from a starting file through import edges.",
    {
      filePath: z.string().min(1).describe("File path relative to repo root"),
      direction: z.enum(["inbound", "outbound", "both"]).default("outbound").describe("Trace direction: outbound (what I import), inbound (who imports me), both"),
      maxDepth: z.number().int().min(1).max(5).default(3).describe("Maximum traversal depth (1-5)"),
    },
    async ({ filePath, direction, maxDepth }) => {
      const c = await getContext();
      const deps = queries.traceTransitiveDeps(c.db, c.repoId, filePath, { direction, maxDepth });
      const cycles = deps.filter(d => d.isCycle);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            filePath,
            direction,
            maxDepth,
            totalDependencies: deps.filter(d => !d.isCycle).length,
            cyclesDetected: cycles.length,
            dependencies: deps,
          }),
        }],
      };
    },
  );

  // ─── export_audit ────────────────────────────────────────
  server.tool(
    "export_audit",
    "Export audit trail (event logs) as JSON or CSV. Metadata-only by default — no raw payloads.",
    {
      format: z.enum(["json", "csv"]).describe("Export format"),
      agentId: AgentIdSchema.optional().describe("Filter by agent ID"),
      sessionId: SessionIdSchema.optional().describe("Filter by session ID"),
      since: z.string().optional().describe("ISO timestamp lower bound"),
      until: z.string().optional().describe("ISO timestamp upper bound"),
      limit: z.number().int().min(1).max(10000).default(10000).describe("Max rows"),
    },
    async ({ format, agentId, sessionId, since, until, limit }) => {
      const c = await getContext();
      const result = exportAuditTrail({
        db: c.db,
        format,
        agentId,
        sessionId,
        since,
        until,
        limit,
      });

      return {
        content: [{
          type: "text" as const,
          text: format === "json"
            ? result.content
            : JSON.stringify({ format: "csv", rows: result.rows, csv: result.content }),
        }],
      };
    },
  );
}
