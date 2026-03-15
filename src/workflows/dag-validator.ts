/**
 * DAG (Directed Acyclic Graph) validator using Kahn's algorithm.
 *
 * Used by the decompose_goal tool to validate that proposed task
 * dependencies form a valid DAG before creating tickets.
 */

export interface DAGEdge {
  from: number;
  to: number;
}

export interface DAGValidationResult {
  valid: boolean;
  /** Topological order of node indices (only when valid). */
  topologicalOrder?: number[];
  /** Indices involved in a cycle (only when invalid). */
  cycleNodes?: number[];
  /** Out-of-bounds index errors. */
  boundsErrors?: Array<{ nodeIndex: number; invalidDep: number }>;
}

/**
 * Validate that edges form a DAG over nodeCount nodes.
 *
 * Checks two things:
 * 1. All edge indices are within bounds [0, nodeCount)
 * 2. No cycles exist (Kahn's algorithm)
 */
export function validateDAG(edges: DAGEdge[], nodeCount: number): DAGValidationResult {
  // Bounds validation
  const boundsErrors: Array<{ nodeIndex: number; invalidDep: number }> = [];
  for (const edge of edges) {
    if (edge.from < 0 || edge.from >= nodeCount) {
      boundsErrors.push({ nodeIndex: edge.to, invalidDep: edge.from });
    }
    if (edge.to < 0 || edge.to >= nodeCount) {
      boundsErrors.push({ nodeIndex: edge.from, invalidDep: edge.to });
    }
  }
  if (boundsErrors.length > 0) {
    return { valid: false, boundsErrors };
  }

  // Kahn's algorithm for topological sort + cycle detection
  const inDegree = new Array<number>(nodeCount).fill(0);
  const adjacency = new Array<number[]>(nodeCount);
  for (let i = 0; i < nodeCount; i++) adjacency[i] = [];

  for (const edge of edges) {
    adjacency[edge.from]!.push(edge.to);
    inDegree[edge.to]!++;
  }

  // Queue of nodes with in-degree 0
  const queue: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  const topologicalOrder: number[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    topologicalOrder.push(node);
    for (const neighbor of adjacency[node]!) {
      inDegree[neighbor]!--;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (topologicalOrder.length === nodeCount) {
    return { valid: true, topologicalOrder };
  }

  // Cycle detected: nodes not in topological order are in cycles
  const inOrder = new Set(topologicalOrder);
  const cycleNodes: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    if (!inOrder.has(i)) cycleNodes.push(i);
  }

  return { valid: false, cycleNodes };
}
