import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { MonstheraContext } from "../core/context.js";
import type { CrossInstancePeer } from "../core/config.js";
import * as queries from "../db/queries.js";
import { searchKnowledgeEntries } from "../knowledge/search.js";
import { signCrossInstanceRequest } from "../trust/cross-instance-auth.js";
import { authorizeCrossInstanceTool } from "../trust/cross-instance-policy.js";
import {
  TicketSeverity,
  TicketStatus,
} from "../../schemas/ticket.js";

export const CROSS_INSTANCE_SEARCH_PATH = "/cross-instance/search";
const DEFAULT_REMOTE_SEARCH_TIMEOUT_MS = 4_000;

export const CrossInstanceSearchSurfaceSchema = z.enum(["code", "knowledge", "tickets"]);

export const CrossInstanceSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  surface: CrossInstanceSearchSurfaceSchema,
  limit: z.number().int().min(1).max(20).default(10),
  scope: z.string().trim().min(1).max(500).optional(),
  type: z.string().trim().min(1).max(100).optional(),
  status: z.enum(TicketStatus.options).optional(),
  severity: z.enum(TicketSeverity.options).optional(),
});

const CodeSearchHitSchema = z.object({
  path: z.string(),
  score: z.number(),
  snippet: z.string().nullable().optional(),
  matchLines: z.array(z.number().int()).optional(),
});

const KnowledgeSearchHitSchema = z.object({
  key: z.string(),
  title: z.string(),
  type: z.string(),
  scope: z.enum(["repo", "global"]),
  updatedAt: z.string(),
  score: z.number(),
});

const TicketSearchHitSchema = z.object({
  ticketId: z.string(),
  title: z.string(),
  status: z.string(),
  severity: z.string(),
  priority: z.number().nullable().optional(),
  updatedAt: z.string(),
  score: z.number(),
});

export const CrossInstanceSearchResponseSchema = z.object({
  instanceId: z.string().nullable(),
  surface: CrossInstanceSearchSurfaceSchema,
  query: z.string(),
  count: z.number().int().min(0),
  results: z.array(z.union([
    CodeSearchHitSchema,
    KnowledgeSearchHitSchema,
    TicketSearchHitSchema,
  ])),
});

export type CrossInstanceSearchSurface = z.infer<typeof CrossInstanceSearchSurfaceSchema>;
export type CrossInstanceSearchRequest = z.infer<typeof CrossInstanceSearchRequestSchema>;
export type CrossInstanceSearchResponse = z.infer<typeof CrossInstanceSearchResponseSchema>;

export interface FederatedSearchFailure {
  instanceId: string;
  baseUrl: string;
  reason: string;
}

export interface FederatedSearchResult {
  surface: CrossInstanceSearchSurface;
  query: string;
  count: number;
  results: Array<Record<string, unknown> & {
    provenance: {
      instanceId: string;
      baseUrl: string;
    };
  }>;
  failures: FederatedSearchFailure[];
}

export async function runLocalCrossInstanceSearch(
  ctx: MonstheraContext,
  request: CrossInstanceSearchRequest,
): Promise<CrossInstanceSearchResponse> {
  const parsed = CrossInstanceSearchRequestSchema.parse(request);

  if (parsed.surface === "code") {
    const results = await ctx.searchRouter.search(parsed.query, ctx.repoId, parsed.limit, parsed.scope);
    return {
      instanceId: ctx.config.crossInstance.instanceId ?? null,
      surface: parsed.surface,
      query: parsed.query,
      count: results.length,
      results: results.map((result) => ({
        path: result.path,
        score: roundScore(result.score),
        snippet: result.snippet ?? null,
        matchLines: result.matchLines ?? [],
      })),
    };
  }

  if (parsed.surface === "knowledge") {
    const results = await searchKnowledgeEntries({
      db: ctx.db,
      sqlite: ctx.sqlite,
      globalDb: ctx.globalDb,
      globalSqlite: ctx.globalSqlite,
      searchRouter: ctx.searchRouter,
    }, {
      query: parsed.query,
      scope: parsed.scope === "repo" || parsed.scope === "global" || parsed.scope === "all" ? parsed.scope : "all",
      type: parsed.type,
      limit: parsed.limit,
    });

    return {
      instanceId: ctx.config.crossInstance.instanceId ?? null,
      surface: parsed.surface,
      query: parsed.query,
      count: results.length,
      results: results.map((result) => ({
        key: result.key,
        title: result.title,
        type: result.type,
        scope: result.scope,
        updatedAt: result.updatedAt,
        score: roundScore(result.score),
      })),
    };
  }

  const ticketHits = ctx.searchRouter.searchTickets(parsed.query, ctx.repoId, parsed.limit, {
    status: parsed.status,
    severity: parsed.severity,
  });

  return {
    instanceId: ctx.config.crossInstance.instanceId ?? null,
    surface: parsed.surface,
    query: parsed.query,
    count: ticketHits.length,
    results: ticketHits.flatMap((hit) => {
      const ticket = queries.getTicketById(ctx.db, hit.ticketInternalId);
      if (!ticket) return [];
      return [{
        ticketId: ticket.ticketId,
        title: ticket.title,
        status: ticket.status,
        severity: ticket.severity,
        priority: ticket.priority,
        updatedAt: ticket.updatedAt,
        score: roundScore(hit.score),
      }];
    }),
  };
}

export async function searchAcrossRemoteInstances(
  ctx: MonstheraContext,
  request: CrossInstanceSearchRequest,
  opts: {
    fetchImpl?: typeof fetch;
    peerIds?: string[];
  } = {},
): Promise<FederatedSearchResult> {
  const parsed = CrossInstanceSearchRequestSchema.parse(request);
  const localInstanceId = ctx.config.crossInstance.instanceId;
  if (!ctx.config.crossInstance.enabled || !localInstanceId) {
    return {
      surface: parsed.surface,
      query: parsed.query,
      count: 0,
      results: [],
      failures: [{
        instanceId: "local",
        baseUrl: "",
        reason: "crossInstance is disabled or missing a local instanceId",
      }],
    };
  }

  const capabilityTool = getCrossInstanceCapabilityTool(parsed.surface);
  const peerIdFilter = opts.peerIds ? new Set(opts.peerIds.map((peerId) => peerId.trim()).filter(Boolean)) : null;
  const eligiblePeers = ctx.config.crossInstance.peers.filter((peer) =>
    peer.enabled &&
    (!peerIdFilter || peerIdFilter.has(peer.instanceId)) &&
    authorizeCrossInstanceTool(peer, capabilityTool).allowed,
  );

  const results: FederatedSearchResult["results"] = [];
  const failures: FederatedSearchFailure[] = [];

  for (const peer of eligiblePeers) {
    const remote = await fetchCrossInstanceSearch(peer, localInstanceId, parsed, opts.fetchImpl ?? fetch);
    if (!remote.ok) {
      failures.push({
        instanceId: peer.instanceId,
        baseUrl: peer.baseUrl,
        reason: remote.reason,
      });
      continue;
    }

    for (const hit of remote.data.results) {
      results.push({
        ...hit,
        provenance: {
          instanceId: remote.data.instanceId ?? peer.instanceId,
          baseUrl: peer.baseUrl,
        },
      });
    }
  }

  results.sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0));
  return {
    surface: parsed.surface,
    query: parsed.query,
    count: results.length,
    results,
    failures,
  };
}

export function getCrossInstanceCapabilityTool(surface: CrossInstanceSearchSurface): string {
  switch (surface) {
    case "code":
      return "get_code_pack";
    case "knowledge":
      return "search_knowledge";
    case "tickets":
      return "search_tickets";
  }
}

async function fetchCrossInstanceSearch(
  peer: CrossInstancePeer,
  localInstanceId: string,
  request: CrossInstanceSearchRequest,
  fetchImpl: typeof fetch,
): Promise<
  | { ok: true; data: CrossInstanceSearchResponse }
  | { ok: false; reason: string }
> {
  const url = new URL(CROSS_INSTANCE_SEARCH_PATH, ensureTrailingSlash(peer.baseUrl));
  const body = JSON.stringify(request);
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const signature = signCrossInstanceRequest({
    method: "POST",
    path: url.pathname,
    query: url.searchParams,
    timestamp,
    nonce,
    instanceId: localInstanceId,
    body,
  }, peer.sharedSecret);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-monsthera-instance-id": localInstanceId,
        "x-monsthera-timestamp": timestamp,
        "x-monsthera-nonce": nonce,
        "x-monsthera-signature": signature.signature,
      },
      body,
      signal: AbortSignal.timeout(DEFAULT_REMOTE_SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const responseBody = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      reason: responseBody || `${response.status} ${response.statusText}`.trim(),
    };
  }

  try {
    const parsed = CrossInstanceSearchResponseSchema.parse(JSON.parse(responseBody) as unknown);
    return { ok: true, data: parsed };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Invalid cross-instance search response",
    };
  }
}

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}
