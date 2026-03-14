const DUPLICATE_TITLE_THRESHOLD = 0.7;
const DUPLICATE_OVERLAP_THRESHOLD = 0.8;
const DUPLICATE_BATCH_WINDOW_MINUTES = 5;
const TERMINAL_TICKET_STATUSES = new Set(["resolved", "closed", "wont_fix"]);

export interface DuplicateClusterTicket {
  ticketId: string;
  title: string;
  status: string;
  creatorAgentId: string | null;
  assigneeAgentId: string | null;
  commitSha: string | null;
  createdAt: string;
  tags: string[];
  affectedPaths: string[];
}

export interface DuplicateClusterSummary {
  id: string;
  ticketIds: string[];
  tickets: Array<{
    ticketId: string;
    title: string;
    status: string;
    createdAt: string;
  }>;
  score: number;
  reasons: string[];
  createdSpanMinutes: number;
}

export interface DuplicateTicketSignal {
  ticketId: string;
  clusterIds: string[];
  peerTicketIds: string[];
  score: number;
  reasons: string[];
}

export interface DuplicateDetectionInsights {
  clusters: DuplicateClusterSummary[];
  byTicketId: Map<string, DuplicateTicketSignal>;
}

interface PairDuplicateSignal {
  suspicious: boolean;
  score: number;
  reasons: string[];
}

export function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeTitle(a));
  const wordsB = new Set(normalizeTitle(b));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection += 1;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function buildDuplicateDetectionInsights(
  tickets: DuplicateClusterTicket[],
): DuplicateDetectionInsights {
  const adjacency = new Map<string, Set<string>>();
  const ticketById = new Map(tickets.map((ticket) => [ticket.ticketId, ticket] as const));
  const pairSignals = new Map<string, PairDuplicateSignal>();

  for (let index = 0; index < tickets.length; index += 1) {
    for (let inner = index + 1; inner < tickets.length; inner += 1) {
      const left = tickets[index]!;
      const right = tickets[inner]!;
      const signal = analyzePair(left, right);
      if (!signal.suspicious) continue;

      const pairKey = buildPairKey(left.ticketId, right.ticketId);
      pairSignals.set(pairKey, signal);
      connect(adjacency, left.ticketId, right.ticketId);
      connect(adjacency, right.ticketId, left.ticketId);
    }
  }

  const visited = new Set<string>();
  const clusters: DuplicateClusterSummary[] = [];

  for (const ticket of tickets) {
    if (visited.has(ticket.ticketId) || !adjacency.has(ticket.ticketId)) continue;
    const component = collectComponent(ticket.ticketId, adjacency, visited).sort((a, b) => a.localeCompare(b));
    if (component.length < 2) continue;

    const reasons = new Set<string>();
    let bestScore = 0;
    const timestamps = component
      .map((ticketId) => Date.parse(ticketById.get(ticketId)?.createdAt ?? ""))
      .filter((value) => Number.isFinite(value));

    for (let index = 0; index < component.length; index += 1) {
      for (let inner = index + 1; inner < component.length; inner += 1) {
        const signal = pairSignals.get(buildPairKey(component[index]!, component[inner]!));
        if (!signal) continue;
        bestScore = Math.max(bestScore, signal.score);
        for (const reason of signal.reasons) reasons.add(reason);
      }
    }

    const createdSpanMinutes = timestamps.length > 1
      ? Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 60_000)
      : 0;

    clusters.push({
      id: component.join("|"),
      ticketIds: component,
      tickets: component
        .map((ticketId) => ticketById.get(ticketId)!)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((entry) => ({
          ticketId: entry.ticketId,
          title: entry.title,
          status: entry.status,
          createdAt: entry.createdAt,
        })),
      score: roundScore(bestScore),
      reasons: [...reasons].sort(),
      createdSpanMinutes,
    });
  }

  clusters.sort((left, right) => right.score - left.score || right.ticketIds.length - left.ticketIds.length);

  const byTicketId = new Map<string, DuplicateTicketSignal>();
  for (const cluster of clusters) {
    for (const ticketId of cluster.ticketIds) {
      const current = byTicketId.get(ticketId) ?? {
        ticketId,
        clusterIds: [],
        peerTicketIds: [],
        score: 0,
        reasons: [],
      };
      current.clusterIds.push(cluster.id);
      current.score = Math.max(current.score, cluster.score);
      current.peerTicketIds = uniqueStrings([...current.peerTicketIds, ...cluster.ticketIds.filter((peer) => peer !== ticketId)]);
      current.reasons = uniqueStrings([...current.reasons, ...cluster.reasons]);
      byTicketId.set(ticketId, current);
    }
  }

  return { clusters, byTicketId };
}

function analyzePair(left: DuplicateClusterTicket, right: DuplicateClusterTicket): PairDuplicateSignal {
  const reasons: string[] = [];
  const titleScore = titleSimilarity(left.title, right.title);
  const tagScore = overlapCoefficient(left.tags, right.tags);
  const pathScore = overlapCoefficient(left.affectedPaths, right.affectedPaths);
  const sameCreator = !!left.creatorAgentId && left.creatorAgentId === right.creatorAgentId;
  const sameAssignee = !!left.assigneeAgentId && left.assigneeAgentId === right.assigneeAgentId;
  const sameTerminalCommit = shareTerminalCommit(left, right);
  const createdDeltaMinutes = Math.abs(Date.parse(left.createdAt) - Date.parse(right.createdAt)) / 60_000;
  const batchedCreate = sameCreator && createdDeltaMinutes <= DUPLICATE_BATCH_WINDOW_MINUTES;

  if (titleScore >= DUPLICATE_TITLE_THRESHOLD) {
    reasons.push(`title similarity ${Math.round(titleScore * 100)}%`);
  }
  if (tagScore >= DUPLICATE_OVERLAP_THRESHOLD) {
    reasons.push(`tags overlap ${Math.round(tagScore * 100)}%`);
  }
  if (pathScore >= DUPLICATE_OVERLAP_THRESHOLD) {
    reasons.push(`paths overlap ${Math.round(pathScore * 100)}%`);
  }
  if (batchedCreate) {
    reasons.push(`same creator within ${Math.max(1, Math.round(createdDeltaMinutes))}m`);
  }
  if (sameAssignee) {
    reasons.push("same assignee");
  }
  if (sameTerminalCommit) {
    reasons.push(`shared resolution commit ${(left.commitSha ?? "").slice(0, 7)}`);
  }

  const metadataTwin = batchedCreate && sameAssignee && sameTerminalCommit;
  const overlapTwin = batchedCreate && tagScore >= DUPLICATE_OVERLAP_THRESHOLD && pathScore >= DUPLICATE_OVERLAP_THRESHOLD;
  const suspicious = titleScore >= DUPLICATE_TITLE_THRESHOLD || metadataTwin || overlapTwin;

  let score = 0;
  if (titleScore >= 0.55) score += titleScore * 0.55;
  if (tagScore >= 0.5) score += tagScore * 0.15;
  if (pathScore >= 0.5) score += pathScore * 0.15;
  if (batchedCreate) score += 0.08;
  if (sameAssignee) score += 0.04;
  if (sameTerminalCommit) score += 0.08;
  if (metadataTwin) score += 0.18;

  return {
    suspicious,
    score: roundScore(score),
    reasons,
  };
}

function normalizeTitle(value: string): string[] {
  return value.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function overlapCoefficient(left: string[], right: string[]): number {
  const leftSet = new Set(left.map(normalizeEntry).filter(Boolean));
  const rightSet = new Set(right.map(normalizeEntry).filter(Boolean));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;

  let intersection = 0;
  for (const entry of leftSet) {
    if (rightSet.has(entry)) intersection += 1;
  }

  return intersection / Math.min(leftSet.size, rightSet.size);
}

function normalizeEntry(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

function shareTerminalCommit(left: DuplicateClusterTicket, right: DuplicateClusterTicket): boolean {
  if (!left.commitSha || left.commitSha !== right.commitSha) return false;
  return TERMINAL_TICKET_STATUSES.has(left.status) && TERMINAL_TICKET_STATUSES.has(right.status);
}

function buildPairKey(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join("::");
}

function connect(map: Map<string, Set<string>>, source: string, target: string): void {
  if (!map.has(source)) map.set(source, new Set());
  map.get(source)!.add(target);
}

function collectComponent(
  start: string,
  adjacency: Map<string, Set<string>>,
  visited: Set<string>,
): string[] {
  const stack = [start];
  const component: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    component.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!visited.has(neighbor)) stack.push(neighbor);
    }
  }

  return component;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function roundScore(value: number): number {
  return Math.round(Math.min(value, 0.99) * 100) / 100;
}
