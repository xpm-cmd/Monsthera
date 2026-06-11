// Sessions — the cognitive-handoff lifecycle finally gets a visual surface.
// Read-only: opening/closing sessions stays with the CLI/MCP lifecycle.
//
// Security note (house pattern, see app.js header): HTML is assembled into a
// detached <template> element and EVERY API-derived value is escaped via the
// esc() helper before interpolation — identical to the other page modules.
// No untrusted string reaches innerHTML unescaped.
import { getSessions, getSessionById } from "../lib/api.js";
import { renderBadge, renderCard, renderHeroCallout, esc } from "../lib/components.js";

function statusVariant(status) {
  if (status === "open") return "primary";
  if (status === "closed") return "success";
  return "warning"; // abandoned / unknown
}

function fmtTime(ts) {
  return ts ? String(ts).replace("T", " ").slice(0, 19) : "—";
}

export async function render(container) {
  let sessions = [];
  let errorMessage = null;
  let selected = null;
  let selectedId = null;

  try {
    const data = await getSessions();
    sessions = data?.sessions || [];
  } catch (e) {
    errorMessage = e?.message || "Failed to load sessions";
  }

  async function select(id) {
    selectedId = id;
    selected = null;
    rerender();
    try {
      selected = await getSessionById(id);
    } catch {
      selected = null;
    }
    if (selectedId === id) rerender();
  }

  function buildList() {
    if (errorMessage) {
      return `<div class="empty-state">Could not load sessions. ${esc(errorMessage)}</div>`;
    }
    if (sessions.length === 0) {
      return '<div class="empty-state">No sessions recorded yet. Open one with <span class="mono">monsthera session open --agent-id you</span> (or the session_open MCP tool).</div>';
    }
    return sessions.map((s) =>
      '<button type="button" class="card card--interactive' + (selectedId === s.id ? " card--selected" : "") + '" style="padding:12px 16px" data-session-id="' + esc(s.id) + '" aria-pressed="' + String(selectedId === s.id) + '">'
        + '<div class="flex items-center gap-8" style="flex-wrap:wrap">'
        + renderBadge(s.status || "unknown", statusVariant(s.status))
        + '<strong class="text-sm mono">' + esc(s.id) + "</strong>"
        + '<span class="text-xs text-muted">' + esc(s.agentId || "") + "</span>"
        + "</div>"
        + '<p class="text-xs text-muted mt-4">' + esc(fmtTime(s.openedAt)) + (s.closedAt ? " → " + esc(fmtTime(s.closedAt)) : " · still open")
        + (s.branch ? ' · <span class="mono">' + esc(s.branch) + "</span>" : "") + "</p>"
        + (s.intent ? '<p class="text-xs mt-4">' + esc(s.intent) + "</p>" : "")
        + "</button>"
    ).join("\n");
  }

  function buildDetail() {
    if (!selectedId) return '<p class="text-sm text-muted">Select a session to inspect it.</p>';
    if (!selected) return renderCard(null, '<p class="text-sm text-muted">Loading session…</p>');
    const rows = [
      { label: "Agent", value: selected.agentId },
      { label: "Repo", value: selected.repo },
      { label: "Branch", value: selected.branch || "—" },
      { label: "Opened", value: fmtTime(selected.openedAt) },
      { label: "Closed", value: selected.closedAt ? fmtTime(selected.closedAt) : "still open" },
      { label: "Handoff article", value: selected.handoffArticleId || "—" },
      { label: "Quality", value: selected.quality?.score != null ? `${selected.quality.score}/5` : "—" },
      { label: "Abandon reason", value: selected.abandonReason || "—" },
    ].map((r) =>
      '<div class="flex justify-between text-sm" style="padding:4px 0;gap:12px"><span class="text-muted">' + esc(r.label) + '</span><span class="mono" style="text-align:right">' + esc(String(r.value)) + "</span></div>"
    ).join("");
    return renderCard(
      null,
      '<div class="flex items-center gap-8"><h3 style="font-size:15px;font-weight:600" class="mono">' + esc(selected.id) + "</h3>"
        + renderBadge(selected.status || "unknown", statusVariant(selected.status)) + "</div>"
        + (selected.intent ? '<p class="text-sm mt-8">' + esc(selected.intent) + "</p>" : "")
        + '<div class="mt-8">' + rows + "</div>"
        + (selected.handoffArticleId ? '<p class="text-xs text-muted mt-8">Read the handoff: <a href="/knowledge" data-link>Knowledge</a> → <span class="mono">' + esc(selected.handoffArticleId) + "</span></p>" : ""),
    );
  }

  function buildDOM() {
    const temp = document.createElement("template");
    temp.innerHTML = [
      '<div class="page-header"><div><div class="page-kicker">Cognitive handoffs</div><h1 class="page-title">Sessions</h1><p class="page-subtitle">Every agent session, its lifecycle, and the handoff it left behind.</p></div></div>',
      renderHeroCallout({
        eyebrow: "How sessions work",
        title: "Open → work → close with a handoff",
        body: "session_open hands the agent its predecessor's brief; session_close distills the session into a handoff article the next agent boots from.",
        collapseKey: "sessions",
        steps: [
          { title: "Open", detail: "monsthera session open --agent-id <you> — receives the previous handoff as a brief." },
          { title: "Close", detail: "monsthera session close — extracts facts and writes the handoff knowledge article." },
          { title: "Brief", detail: "session brief re-orients a running agent mid-flight (teaser/standard/full)." },
        ],
      }),
      '<div class="layout-split" style="margin-top:16px">'
        + '<div class="col-main" style="gap:8px">' + buildList() + "</div>"
        + '<div class="col-side">' + buildDetail() + "</div></div>",
    ].join("\n");
    return temp.content;
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    container.querySelectorAll("[data-session-id]").forEach((el) => {
      el.addEventListener("click", () => select(el.getAttribute("data-session-id")));
    });
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
  }

  rerender();
}
