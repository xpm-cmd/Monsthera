// ─── API client ─────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error ?? "UNKNOWN";
  }
}

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body);
  }
  return res.json();
}

export function getHealth() { return get("/api/health"); }
export function getStatus() { return get("/api/status"); }
export function getKnowledge(category) {
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  return get(`/api/knowledge${qs}`);
}
export function getKnowledgeById(id) { return get(`/api/knowledge/${encodeURIComponent(id)}`); }
export function getWork(phase) {
  const qs = phase ? `?phase=${encodeURIComponent(phase)}` : "";
  return get(`/api/work${qs}`);
}
export function getWorkById(id) { return get(`/api/work/${encodeURIComponent(id)}`); }
export function search(q, limit) {
  const params = new URLSearchParams({ q });
  if (limit) params.set("limit", String(limit));
  return get(`/api/search?${params}`);
}
