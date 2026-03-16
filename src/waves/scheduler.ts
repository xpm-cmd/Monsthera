/**
 * Wave scheduler — pure-logic module that computes wave assignments
 * from a dependency DAG.
 *
 * A "wave" is a group of tickets that can be worked on in parallel
 * because none of them block each other. Wave 0 has no blockers,
 * wave 1 depends only on wave 0 tickets, etc.
 */

import { validateDAG } from "../workflows/dag-validator.js";
import type { DAGEdge } from "../workflows/dag-validator.js";
import { pathsOverlap } from "../core/path-overlap.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WavePlan {
  /** waves[i] = ticketIds that can run in parallel in wave i */
  waves: string[][];
  waveCount: number;
  /** ticketId -> wave index */
  ticketWaveMap: Map<string, number>;
  /** ticketId -> [blockerTicketIds] */
  blockers: Map<string, string[]>;
}

export interface PreflightResult {
  valid: boolean;
  plan?: WavePlan;
  cycleTicketIds?: string[];
  fileOverlapWarnings: Array<{
    wave: number;
    ticketA: string;
    ticketB: string;
    overlappingPaths: string[];
  }>;
}

export interface TicketNode {
  ticketId: string;
  affectedPaths: string[];
}

export type ComputeWavesResult =
  | WavePlan
  | { error: "cycle"; cycleTicketIds: string[] };

/** An edge meaning `blocker` must finish before `blocked` can start. */
export interface BlocksEdge {
  blocker: string;
  blocked: string;
}

// ---------------------------------------------------------------------------
// Terminal statuses — a ticket in one of these is considered "done".
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["resolved", "closed", "wont_fix"]);

// ---------------------------------------------------------------------------
// computeWaves
// ---------------------------------------------------------------------------

/**
 * Compute parallel wave assignments from ticket IDs and "blocks" edges.
 *
 * Algorithm:
 * 1. Map ticketIds to indices [0..N)
 * 2. Convert BlocksEdge[] to DAGEdge[] (from = blocker, to = blocked)
 * 3. Validate DAG
 * 4. Compute depth for each node via topological order
 * 5. Group by depth -> waves
 */
export function computeWaves(
  ticketIds: string[],
  blocksEdges: BlocksEdge[],
): ComputeWavesResult {
  const n = ticketIds.length;
  if (n === 0) {
    return {
      waves: [],
      waveCount: 0,
      ticketWaveMap: new Map(),
      blockers: new Map(),
    };
  }

  // 1. Map ticketIds to indices
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    idToIndex.set(ticketIds[i]!, i);
  }

  // 2. Convert to DAGEdge[] and build blockers map
  const dagEdges: DAGEdge[] = [];
  const blockersMap = new Map<string, string[]>();

  for (const edge of blocksEdges) {
    const fromIdx = idToIndex.get(edge.blocker);
    const toIdx = idToIndex.get(edge.blocked);
    // Skip edges referencing tickets not in our set
    if (fromIdx === undefined || toIdx === undefined) continue;

    dagEdges.push({ from: fromIdx, to: toIdx });

    let list = blockersMap.get(edge.blocked);
    if (!list) {
      list = [];
      blockersMap.set(edge.blocked, list);
    }
    list.push(edge.blocker);
  }

  // 3. Validate DAG
  const result = validateDAG(dagEdges, n);

  if (!result.valid) {
    // Cycle detected — translate indices back to ticket IDs
    const cycleTicketIds = (result.cycleNodes ?? []).map(
      (idx) => ticketIds[idx]!,
    );
    return { error: "cycle", cycleTicketIds };
  }

  // 4. Compute depth for each node in topological order
  //    depth[node] = max(depth[predecessor] + 1) over all incoming edges
  //    Source nodes (no incoming edges) have depth 0.
  const topoOrder = result.topologicalOrder!;
  const depth = new Array<number>(n).fill(0);

  // Build reverse adjacency (incoming edges) for depth computation
  const incoming = new Array<number[]>(n);
  for (let i = 0; i < n; i++) incoming[i] = [];
  for (const edge of dagEdges) {
    incoming[edge.to]!.push(edge.from);
  }

  for (const node of topoOrder) {
    for (const pred of incoming[node]!) {
      const candidate = depth[pred]! + 1;
      if (candidate > depth[node]!) {
        depth[node] = candidate;
      }
    }
  }

  // 5. Group by depth -> waves
  let maxDepth = 0;
  for (let i = 0; i < n; i++) {
    if (depth[i]! > maxDepth) maxDepth = depth[i]!;
  }

  const waves: string[][] = [];
  for (let w = 0; w <= maxDepth; w++) {
    waves.push([]);
  }

  const ticketWaveMap = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const waveIdx = depth[i]!;
    waves[waveIdx]!.push(ticketIds[i]!);
    ticketWaveMap.set(ticketIds[i]!, waveIdx);
  }

  return {
    waves,
    waveCount: waves.length,
    ticketWaveMap,
    blockers: blockersMap,
  };
}

// ---------------------------------------------------------------------------
// preflightWorkGroup
// ---------------------------------------------------------------------------

/**
 * Validate a work group: compute waves and detect file-path overlaps
 * within each wave (tickets in the same wave would run concurrently,
 * so overlapping files are a merge-conflict risk).
 */
export function preflightWorkGroup(
  tickets: TicketNode[],
  blocksEdges: BlocksEdge[],
): PreflightResult {
  const ticketIds = tickets.map((t) => t.ticketId);
  const result = computeWaves(ticketIds, blocksEdges);

  // Cycle?
  if ("error" in result) {
    return {
      valid: false,
      cycleTicketIds: result.cycleTicketIds,
      fileOverlapWarnings: [],
    };
  }

  const plan = result;

  // Build a lookup from ticketId -> affectedPaths
  const pathsByTicket = new Map<string, string[]>();
  for (const t of tickets) {
    pathsByTicket.set(t.ticketId, t.affectedPaths);
  }

  // Check all pairs within each wave for path overlaps
  const fileOverlapWarnings: PreflightResult["fileOverlapWarnings"] = [];

  for (let w = 0; w < plan.waveCount; w++) {
    const wave = plan.waves[w]!;
    for (let i = 0; i < wave.length; i++) {
      for (let j = i + 1; j < wave.length; j++) {
        const aId = wave[i]!;
        const bId = wave[j]!;
        const aPaths = pathsByTicket.get(aId) ?? [];
        const bPaths = pathsByTicket.get(bId) ?? [];

        const overlapping: string[] = [];
        for (const ap of aPaths) {
          for (const bp of bPaths) {
            if (pathsOverlap(ap, bp)) {
              // Report the more specific path (or both if neither nests)
              overlapping.push(ap.length >= bp.length ? ap : bp);
            }
          }
        }

        if (overlapping.length > 0) {
          fileOverlapWarnings.push({
            wave: w,
            ticketA: aId,
            ticketB: bId,
            overlappingPaths: overlapping,
          });
        }
      }
    }
  }

  return {
    valid: true,
    plan,
    fileOverlapWarnings,
  };
}

// ---------------------------------------------------------------------------
// getReadyTickets
// ---------------------------------------------------------------------------

/**
 * Given a wave plan, a current wave index, and a map of ticket statuses,
 * return the ticket IDs from `currentWave` whose blockers are all in a
 * terminal status ("resolved", "closed", "wont_fix").
 */
export function getReadyTickets(
  plan: WavePlan,
  currentWave: number,
  ticketStatuses: Map<string, string>,
): string[] {
  if (currentWave < 0 || currentWave >= plan.waveCount) {
    return [];
  }

  const waveTickets = plan.waves[currentWave]!;
  const ready: string[] = [];

  for (const ticketId of waveTickets) {
    const deps = plan.blockers.get(ticketId) ?? [];
    const allDone = deps.every((dep) => {
      const status = ticketStatuses.get(dep);
      return status !== undefined && TERMINAL_STATUSES.has(status);
    });
    if (allDone) {
      ready.push(ticketId);
    }
  }

  return ready;
}
