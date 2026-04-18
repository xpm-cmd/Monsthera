// ─── API client ─────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error ?? "UNKNOWN";
  }
}

async function request(path, options = {}) {
  const init = { ...options };
  if (init.body !== undefined) {
    init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
    init.body = JSON.stringify(init.body);
  }

  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

async function get(path) {
  return request(path);
}

async function post(path, body) {
  return request(path, { method: "POST", body });
}

async function patch(path, body) {
  return request(path, { method: "PATCH", body });
}

async function del(path) {
  return request(path, { method: "DELETE" });
}

export { ApiError };

export function getHealth() { return get("/api/health"); }
export function getStatus() { return get("/api/status"); }
export function getSystemRuntime() { return get("/api/system/runtime"); }
export function getStructureGraph() { return get("/api/structure/graph"); }
export function getContextPack(query, mode = "general", limit = 8, type = "all") {
  const params = new URLSearchParams({ q: query, mode, limit: String(limit) });
  if (type && type !== "all") params.set("type", type);
  return get(`/api/search/context-pack?${params}`);
}
export function getOrchestrationWave(autoAdvanceOnly = false) {
  const qs = autoAdvanceOnly ? "?autoAdvanceOnly=1" : "";
  return get(`/api/orchestration/wave${qs}`);
}
export function executeOrchestrationWave(autoAdvanceOnly = false) {
  const qs = autoAdvanceOnly ? "?autoAdvanceOnly=1" : "";
  return post(`/api/orchestration/wave/execute${qs}`, {});
}
export function getAgents() { return get("/api/agents"); }
export function getAgentById(id) { return get(`/api/agents/${encodeURIComponent(id)}`); }
export function ingestLocalKnowledge(input) { return post("/api/ingest/local", input); }
export function getKnowledge(category) {
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  return get(`/api/knowledge${qs}`);
}
export function getKnowledgeById(id) { return get(`/api/knowledge/${encodeURIComponent(id)}`); }
export function createKnowledge(input) { return post("/api/knowledge", input); }
export function updateKnowledge(id, input) { return patch(`/api/knowledge/${encodeURIComponent(id)}`, input); }
export function deleteKnowledge(id) { return del(`/api/knowledge/${encodeURIComponent(id)}`); }
export function getWork(phase) {
  const qs = phase ? `?phase=${encodeURIComponent(phase)}` : "";
  return get(`/api/work${qs}`);
}
export function getWorkById(id) { return get(`/api/work/${encodeURIComponent(id)}`); }
export function createWork(input) { return post("/api/work", input); }
export function updateWork(id, input) { return patch(`/api/work/${encodeURIComponent(id)}`, input); }
export function deleteWork(id) { return del(`/api/work/${encodeURIComponent(id)}`); }
export function advanceWork(id, phase, options = {}) {
  const body = { phase };
  if (options.reason !== undefined) body.reason = options.reason;
  if (options.skipGuard !== undefined) body.skipGuard = options.skipGuard;
  return post(`/api/work/${encodeURIComponent(id)}/advance`, body);
}
export function contributeEnrichment(id, role, status) { return post(`/api/work/${encodeURIComponent(id)}/enrichment`, { role, status }); }
export function assignReviewer(id, reviewerAgentId) { return post(`/api/work/${encodeURIComponent(id)}/reviewers`, { reviewerAgentId }); }
export function submitReview(id, reviewerAgentId, status) { return post(`/api/work/${encodeURIComponent(id)}/review`, { reviewerAgentId, status }); }
export function addWorkDependency(id, blockedById) { return post(`/api/work/${encodeURIComponent(id)}/dependencies`, { blockedById }); }
export function removeWorkDependency(id, blockedById) { return del(`/api/work/${encodeURIComponent(id)}/dependencies?blockedById=${encodeURIComponent(blockedById)}`); }
export function search(q, limit) {
  const params = new URLSearchParams({ q });
  if (limit) params.set("limit", String(limit));
  return get(`/api/search?${params}`);
}
export function reindexSearch() { return post("/api/search/reindex", {}); }
