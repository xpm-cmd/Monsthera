import { getConvoyById } from "../lib/api.js";
import { esc, renderCard, renderPhaseChip, timeAgo } from "../lib/components.js";

function renderHeader(convoy) {
  const leadTitle = "title" in convoy.lead ? convoy.lead.title : "(deleted lead)";
  const guardLine = convoy.guard
    ? convoy.guard.passing
      ? `<span style="color:var(--color-success-fg)">✓ guard passing — lead at <strong>${esc(convoy.guard.leadPhase)}</strong>, target was <strong>${esc(convoy.guard.targetPhase)}</strong></span>`
      : `<span style="color:var(--color-warning-fg)">⊘ guard blocked — lead at <strong>${esc(convoy.guard.leadPhase)}</strong>, target is <strong>${esc(convoy.guard.targetPhase)}</strong></span>`
    : '<span class="text-muted">terminal — guard no longer applies</span>';
  const warningLine = convoy.warning
    ? `<div class="inline-notice inline-notice--error mt-8">⚠ Unresolved: ${esc(convoy.warning.reason)} · ${convoy.warning.activeMemberCount} member(s) still active</div>`
    : "";
  return `
    <div class="page-header"><div>
      <div class="page-kicker">${esc(convoy.id)}</div>
      <h1 class="page-title">${esc(convoy.goal)}</h1>
      <p class="page-subtitle">lead <strong>${esc(leadTitle)}</strong> · target <strong>${esc(convoy.targetPhase)}</strong> · status <strong>${esc(convoy.status)}</strong> · ${timeAgo(convoy.createdAt)}</p>
      <div class="mt-8">${guardLine}</div>
      ${warningLine}
    </div></div>`;
}

function renderMembers(convoy) {
  if (convoy.members.length === 0) return '<p class="text-sm text-muted">No members.</p>';
  return convoy.members.map((m) => {
    if ("deleted" in m) {
      return `<div class="guide-line"><div><div class="text-sm">(deleted)</div><div class="text-xs text-muted">${esc(m.id)}</div></div></div>`;
    }
    return `<div class="guide-line">
      <div>
        <div class="text-sm" style="font-weight:600">${esc(m.title)}</div>
        <div class="text-xs text-muted">${esc(m.id)}</div>
      </div>
      ${renderPhaseChip(m.phase)}
    </div>`;
  }).join("");
}

function renderRecentActivity(convoy) {
  if (convoy.recentLeadActivity.length === 0) {
    return '<p class="text-sm text-muted">No recent phase advances.</p>';
  }
  return convoy.recentLeadActivity.map((e) => {
    // `from` may be undefined when WorkService.advancePhase didn't carry it
    // and phaseHistory was too short for the projection to derive it.
    const arrow = e.from ? `${esc(e.from)} → ${esc(e.to)}` : `→ ${esc(e.to)}`;
    return `
      <div class="text-xs" style="font-family:'Geist Mono',monospace; padding:4px 0; border-left: 2px solid var(--border); padding-left:8px;">
        ${esc(new Date(e.createdAt).toISOString())} · advanced ${arrow}
      </div>`;
  }).join("");
}

function renderLifecycle(convoy) {
  if (convoy.lifecycle.length === 0) {
    return '<p class="text-sm text-muted">No lifecycle events.</p>';
  }
  return convoy.lifecycle.map((l) => {
    const meta = [
      l.actor ? `by @${esc(l.actor)}` : null,
      l.terminationReason ? `reason: ${esc(l.terminationReason)}` : null,
      l.warningReason ? `warning: ${esc(l.warningReason)}` : null,
      l.goal ? `goal: ${esc(l.goal)}` : null,
    ].filter(Boolean).join(" · ");
    return `
      <div class="text-xs" style="font-family:'Geist Mono',monospace; padding:4px 0; border-left: 2px solid var(--primary); padding-left:8px;">
        ${esc(new Date(l.createdAt).toISOString())} · ${esc(l.eventType)} ${meta ? `· ${meta}` : ""}
      </div>`;
  }).join("");
}

export async function render(container, params) {
  const convoy = await getConvoyById(params.id).catch((err) => ({ __error: err }));
  const wrapper = document.createElement("div");

  if (convoy.__error) {
    wrapper.innerHTML = `
      <div class="page-header"><div>
        <h1 class="page-title">Convoy not found</h1>
        <p class="page-subtitle">No convoy with id <code>${esc(params.id)}</code>.</p>
        <div class="mt-16"><a href="/convoys" data-link class="btn btn--outline btn--sm">Back to convoys</a></div>
      </div></div>`;
    while (wrapper.firstChild) container.appendChild(wrapper.firstChild);
    return;
  }

  wrapper.innerHTML = [
    renderHeader(convoy),
    '<div class="layout-split"><div class="col-main">',
    renderCard(`Members (${convoy.members.length})`, renderMembers(convoy)),
    '</div><div class="col-side">',
    renderCard("Lead recent activity", renderRecentActivity(convoy)),
    renderCard("Convoy lifecycle", renderLifecycle(convoy)),
    "</div></div>",
  ].join("\n");

  while (wrapper.firstChild) container.appendChild(wrapper.firstChild);
}
