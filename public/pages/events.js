// /events — orchestration event stream + agent-dispatch surface (ADR-008).
//
// Read-only: lists recent events, filters by type, auto-refreshes every 5s.
// The dispatcher emits `agent_needed` from the wave loop; harnesses emit the
// rest via `monsthera events emit` / `events_emit` MCP tool / POST
// /api/events/emit. The events stream is the read surface; emit lives in the
// CLI/MCP for now.
//
// Security note: all API-derived values are sanitised via esc() — same
// pattern as the rest of the SPA. No raw user input is interpolated.

import { getEvents } from "../lib/api.js";
import { esc, renderBadge, renderCard } from "../lib/components.js";

const FILTER_TYPES = [
  { value: "", label: "All" },
  { value: "agent_needed", label: "agent_needed" },
  { value: "agent_started", label: "agent_started" },
  { value: "agent_completed", label: "agent_completed" },
  { value: "agent_failed", label: "agent_failed" },
  { value: "phase_advanced", label: "phase_advanced" },
  { value: "guard_evaluated", label: "guard_evaluated" },
  { value: "error_occurred", label: "error_occurred" },
];

const REFRESH_MS = 5000;

function typeVariant(type) {
  switch (type) {
    case "agent_needed": return "warning";
    case "agent_started": return "primary";
    case "agent_completed": return "success";
    case "agent_failed": return "error";
    case "phase_advanced": return "success";
    case "error_occurred": return "error";
    default: return "secondary";
  }
}

function renderEventRow(event) {
  const created = new Date(event.createdAt);
  const when = Number.isFinite(created.getTime()) ? created.toLocaleString() : event.createdAt;
  const details = event.details ?? {};
  const role = typeof details.role === "string" ? details.role : null;
  const transition = details.transition && typeof details.transition === "object"
    ? `${details.transition.from} -> ${details.transition.to}`
    : null;
  const reason = typeof details.reason === "string" ? details.reason : null;
  const triggeredBy = details.triggeredBy && typeof details.triggeredBy === "object"
    ? (details.triggeredBy.policySlug || details.triggeredBy.guardName || "")
    : "";
  const errorMsg = typeof details.error === "string" ? details.error : null;

  const meta = [
    renderBadge(event.eventType, typeVariant(event.eventType)),
    role ? renderBadge(`role: ${esc(role)}`, "outline") : "",
    transition ? `<span class="text-sm text-muted">${esc(transition)}</span>` : "",
    reason ? `<span class="text-sm text-muted">reason: ${esc(reason)}</span>` : "",
    triggeredBy ? `<span class="text-sm text-muted">via ${esc(String(triggeredBy))}</span>` : "",
  ].filter(Boolean).join(" ");

  const detailLines = [];
  if (event.workId) {
    detailLines.push(`<div class="text-sm"><strong>work:</strong> <code>${esc(String(event.workId))}</code></div>`);
  }
  if (event.agentId) {
    detailLines.push(`<div class="text-sm"><strong>agent:</strong> <code>${esc(String(event.agentId))}</code></div>`);
  }
  if (errorMsg) {
    detailLines.push(`<div class="text-sm" style="color:var(--color-error,#c33);"><strong>error:</strong> ${esc(errorMsg)}</div>`);
  }
  if (Array.isArray(details.contextPackSummary?.guidance) && details.contextPackSummary.guidance.length > 0) {
    const items = details.contextPackSummary.guidance
      .map((line) => `<li><code>${esc(String(line))}</code></li>`)
      .join("");
    detailLines.push(
      `<details class="mt-8"><summary class="text-sm">guidance (${details.contextPackSummary.guidance.length})</summary><ul class="text-sm mt-8">${items}</ul></details>`,
    );
  }

  const body = meta + (detailLines.length ? `<div class="mt-8">${detailLines.join("")}</div>` : "");
  return renderCard({
    title: `<code>${esc(event.id)}</code> <span class="text-sm text-muted">- ${esc(when)}</span>`,
    body,
  });
}

export async function render(container) {
  let typeFilter = "";
  let timer = null;

  function buildShell() {
    const typeOptions = FILTER_TYPES.map(
      (t) => `<option value="${esc(t.value)}"${t.value === typeFilter ? " selected" : ""}>${esc(t.label)}</option>`,
    ).join("");
    const shell = [
      '<div class="page-header"><h1>Events</h1>',
      '<p class="text-sm text-muted">Orchestration event stream. Auto-refreshes every ',
      String(Math.round(REFRESH_MS / 1000)),
      's. See ADR-008 (Agent Dispatch Contract) for what each lifecycle type means.</p></div>',
      '<div class="filters" style="display:flex;gap:8px;align-items:center;margin-bottom:16px;">',
      '<label class="text-sm">Filter: <select id="events-type-filter" class="select select--sm">',
      typeOptions,
      '</select></label>',
      '<button id="events-refresh" class="btn btn--outline btn--sm">Refresh</button>',
      '</div>',
      '<div id="events-list" class="events-list"><div class="loading">Loading...</div></div>',
    ].join("");
    // Safe: typeOptions is built from a static FILTER_TYPES array via esc().
    container.innerHTML = shell;
    container.querySelector("#events-type-filter").addEventListener("change", (e) => {
      typeFilter = e.target.value;
      void load();
    });
    container.querySelector("#events-refresh").addEventListener("click", () => void load());
  }

  async function load() {
    const list = container.querySelector("#events-list");
    if (!list) return;
    try {
      const opts = { limit: 200 };
      if (typeFilter) opts.type = typeFilter;
      const data = await getEvents(opts);
      const events = (data && Array.isArray(data.events)) ? data.events : [];
      if (events.length === 0) {
        // Safe: hardcoded message string.
        list.innerHTML = '<div class="empty-state">No events match this filter.</div>';
        return;
      }
      // Safe: every interpolated value in renderEventRow flows through esc().
      list.innerHTML = events.map(renderEventRow).join("");
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      // Safe: error message escaped via esc().
      list.innerHTML = '<div class="alert alert--error">Failed to load events: ' + esc(msg) + '</div>';
    }
  }

  buildShell();
  await load();
  timer = setInterval(() => { void load(); }, REFRESH_MS);

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
