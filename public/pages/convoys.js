import { getConvoys } from "../lib/api.js";
import { esc, renderBadge, renderCard, renderPhaseChip, timeAgo } from "../lib/components.js";

function renderWarningSection(warnings) {
  if (warnings.length === 0) return "";
  const rows = warnings.map((w) => `
    <div class="inline-notice inline-notice--error">
      <strong>⚠ ${esc(w.leadTitle)}</strong>
      <span class="text-xs text-muted" style="margin-left:8px">cv: <a href="/convoys/${esc(w.convoyId)}" data-link><code>${esc(w.convoyId)}</code></a> · ${w.activeMemberCount} active member(s) · reason: ${esc(w.reason)}</span>
    </div>`).join("");
  return renderCard(`Unresolved warnings (${warnings.length})`, rows);
}

function renderConvoyCard(convoy) {
  const counts = {};
  for (const m of convoy.members) {
    if ("deleted" in m) continue;
    counts[m.phase] = (counts[m.phase] || 0) + 1;
  }
  const distribution = Object.entries(counts)
    .map(([phase, n]) => renderPhaseChip(phase, n)).join(" ");
  const leadTitle = "title" in convoy.lead ? convoy.lead.title : "(deleted lead)";
  const leadPhase = "phase" in convoy.lead ? convoy.lead.phase : "—";
  const warnPill = convoy.hasUnresolvedWarning ? `<span style="margin-left:8px">${renderBadge("warning", "error")}</span>` : "";
  return `
    <a href="/convoys/${esc(convoy.id)}" data-link class="convoy-card">
      <div class="convoy-card__head">
        <strong>${esc(convoy.id)}</strong>
        <span class="text-xs text-muted">${timeAgo(convoy.createdAt)}</span>
      </div>
      <div class="convoy-card__lead">lead <strong>${esc(leadTitle)}</strong> · ${esc(leadPhase)} · ${convoy.members.length} member(s) ${warnPill}</div>
      <div class="convoy-card__goal">${esc(convoy.goal)}</div>
      <div class="convoy-card__distrib">${distribution || '<span class="text-xs text-muted">no members</span>'}</div>
    </a>`;
}

export async function render(container) {
  const data = await getConvoys().catch(() => ({ active: [], terminal: [], warnings: [] }));
  const wrapper = document.createElement("div");
  wrapper.innerHTML = [
    '<div class="page-header"><div><div class="page-kicker">Coordination</div><h1 class="page-title">Convoys</h1><p class="page-subtitle">Read-only view of grouped work articles, their lead state, and any unresolved lead-cancellation warnings.</p></div></div>',
    renderWarningSection(data.warnings),
    data.active.length > 0
      ? `<div class="convoy-stream">${data.active.map(renderConvoyCard).join("")}</div>`
      : renderCard("No active convoys", '<p class="text-sm text-muted">A convoy groups work articles around a lead. Create one with <code>monsthera convoy create</code>.</p>'),
    data.terminal.length > 0
      ? renderCard(`Recent terminal (${data.terminal.length})`, `<div class="convoy-stream convoy-stream--muted">${data.terminal.map(renderConvoyCard).join("")}</div>`)
      : "",
  ].join("\n");
  while (wrapper.firstChild) container.appendChild(wrapper.firstChild);
}
