// ─── Code Intelligence page ─────────────────────────────────────────────────
//
// ADR-015 Layer 1 — code-ref intelligence over Monsthera's existing
// operational corpus. This page exposes the four CodeIntelligenceService
// surfaces (`/api/code/{ref,owners,impact,changes}`) so a human can answer
// the same questions an agent answers via MCP: "what does Monsthera think
// about this path, and which active work or policy would I disturb if I
// changed it?"
//
// Two interaction modes:
//   1. **Inspect a single path** — left panel. Default view: full impact
//      analysis (existence, owners, active work, policies, risk, reasons,
//      recommended next actions). Backed by `getCodeImpact()`.
//   2. **Detect changes across a diff** — right panel. Paste paths
//      (one per line, e.g. from `git diff --name-only`), submit, and
//      surface impacts grouped by risk. Backed by `detectCodeChanges()`.
//
// Security note: every value rendered into HTML passes through `esc()` (the
// project's standard escape helper). Sourced data — owner titles, reasons,
// recommended actions — comes from the API and could in principle contain
// markup, so the discipline is non-optional. We compose HTML strings then
// hand them to `Range.createContextualFragment` to materialise as a
// DocumentFragment; that path mirrors how the rest of the dashboard pages
// hydrate, but keeps the `Element.innerHTML` setter out of any code path
// that touches API-derived data.

import { detectCodeChanges, getCodeImpact, ApiError } from "../lib/api.js";
import {
  esc,
  renderBadge,
  renderCard,
  renderPhaseChip,
} from "../lib/components.js";

const RISK_VARIANT = {
  none: "secondary",
  low: "info",
  medium: "warning",
  high: "error",
};

/**
 * Convert an HTML string into a DocumentFragment. We deliberately avoid
 * touching `.innerHTML` on a live element with API-derived strings — every
 * piece of data flowing through these helpers is `esc()`-wrapped before
 * concatenation, and `createContextualFragment` parses the resulting markup
 * inside a disconnected fragment. The fragment is then appended in one
 * pass, which also gives us atomic insertion (no half-rendered states).
 */
function fragmentFromHtml(html) {
  const range = document.createRange();
  return range.createContextualFragment(html);
}

function replaceContent(target, html) {
  while (target.firstChild) target.removeChild(target.firstChild);
  target.appendChild(fragmentFromHtml(html));
}

function appendHtml(target, html) {
  target.appendChild(fragmentFromHtml(html));
}

function renderRiskBadge(risk) {
  return renderBadge(risk, RISK_VARIANT[risk] ?? "secondary");
}

function renderOwnerRow(owner) {
  const phaseChip = owner.type === "work" && owner.phase
    ? ` ${renderPhaseChip(owner.phase, 1)}`
    : "";
  const matchHint = owner.match === "exact"
    ? ""
    : ` <span class="text-xs text-muted">(${esc(owner.match)} match)</span>`;
  const activePill = owner.type === "work" && owner.active
    ? ` ${renderBadge("active", "info")}`
    : "";
  const policyPill = owner.type === "knowledge" && owner.category === "policy"
    ? ` ${renderBadge("policy", "warning")}`
    : "";
  return `<li>
    <code>${esc(owner.id)}</code> · <strong>${esc(owner.title)}</strong>${phaseChip}${activePill}${policyPill}${matchHint}
    <div class="text-xs text-muted">via <code>${esc(owner.ref)}</code></div>
  </li>`;
}

function renderOwnersList(owners) {
  if (!owners || owners.length === 0) {
    return '<p class="text-sm text-muted">No knowledge or work articles link to this path.</p>';
  }
  return `<ul class="code-owner-list">${owners.map(renderOwnerRow).join("")}</ul>`;
}

function renderRefDetailMeta(ref) {
  const lines = [];
  lines.push(`<div><span class="text-xs text-muted">normalized</span> <code>${esc(ref.normalizedPath)}</code></div>`);
  if (ref.outOfRepo) {
    lines.push(`<div>${renderBadge("out of repo", "error")}</div>`);
  } else {
    lines.push(
      `<div><span class="text-xs text-muted">exists</span> ${ref.exists ? renderBadge("yes", "info") : renderBadge("no", "error")}</div>`,
    );
  }
  if (ref.lineAnchor) {
    lines.push(`<div><span class="text-xs text-muted">line anchor</span> <code>${esc(ref.lineAnchor)}</code></div>`);
  }
  if (ref.isDirectory) {
    lines.push(`<div>${renderBadge("directory", "secondary")}</div>`);
  }
  if (ref.modifiedAt) {
    lines.push(`<div><span class="text-xs text-muted">modified</span> ${esc(ref.modifiedAt)}</div>`);
  }
  return `<div class="code-ref-meta">${lines.join("")}</div>`;
}

function renderImpact(impact) {
  const ref = impact.ref;
  const summary = ref.summary;
  const reasons = (impact.reasons || []).map((r) => `<li><code>${esc(r)}</code></li>`).join("");
  const next = (impact.recommendedNextActions || []).map((a) => `<li>${esc(a)}</li>`).join("");
  const summaryRow = `
    <div class="code-summary-row">
      <span><strong>${summary.ownerCount}</strong> owner(s)</span>
      <span><strong>${summary.knowledgeCount}</strong> knowledge</span>
      <span><strong>${summary.workCount}</strong> work</span>
      <span><strong>${summary.activeWorkCount}</strong> active</span>
      <span><strong>${summary.policyCount}</strong> policy</span>
    </div>`;

  return [
    `<div class="code-impact-head">
      <h3 class="code-impact-title">${esc(ref.input)}</h3>
      ${renderRiskBadge(impact.risk)}
    </div>`,
    renderRefDetailMeta(ref),
    summaryRow,
    reasons ? renderCard("Reasons", `<ul class="code-reason-list">${reasons}</ul>`) : "",
    next ? renderCard("Recommended next actions", `<ul class="code-action-list">${next}</ul>`) : "",
    renderCard("Owners", renderOwnersList(ref.owners)),
  ].filter(Boolean).join("\n");
}

function renderInspectPanel() {
  return renderCard(
    "Inspect a path",
    `
    <form id="code-inspect-form" class="code-form">
      <label for="code-inspect-input" class="code-label">
        Path inside the repo (line anchors like <code>#L42</code> are preserved)
      </label>
      <div class="code-form-row">
        <input id="code-inspect-input" name="path" class="code-input" type="text" placeholder="src/auth/session.ts" autocomplete="off" required>
        <button type="submit" class="btn btn-primary">Analyze impact</button>
      </div>
    </form>
    <div id="code-inspect-result" class="code-inspect-result"></div>
    `,
  );
}

function renderChangesPanel() {
  return renderCard(
    "Detect changes across a diff",
    `
    <form id="code-changes-form" class="code-form">
      <label for="code-changes-input" class="code-label">
        Paths, one per line — typically the output of <code>git diff --name-only</code>
      </label>
      <textarea id="code-changes-input" class="code-textarea" rows="6" placeholder="src/dashboard/index.ts&#10;src/code-intelligence/service.ts" autocomplete="off"></textarea>
      <div class="code-form-row code-form-row--right">
        <button type="submit" class="btn btn-primary">Detect</button>
      </div>
    </form>
    <div id="code-changes-result" class="code-changes-result"></div>
    `,
  );
}

function renderImpactsList(payload) {
  const summary = payload.summary;
  const summaryHtml = `
    <div class="code-summary-row">
      <span><strong>${payload.changedPathCount}</strong> path(s) considered</span>
      <span>highest risk ${renderRiskBadge(summary.highestRisk)}</span>
      <span><strong>${summary.impactedActiveWorkCount}</strong> active work</span>
      <span><strong>${summary.impactedPolicyCount}</strong> policy</span>
      <span><strong>${summary.impactedOwnerCount}</strong> total owner(s)</span>
    </div>`;
  const next = (payload.recommendedNextActions || [])
    .map((a) => `<li>${esc(a)}</li>`)
    .join("");
  const sorted = [...(payload.impacts || [])].sort((a, b) => riskRank(b.risk) - riskRank(a.risk));
  const items = sorted.length === 0
    ? '<p class="text-sm text-muted">None of the supplied paths intersect any code refs in this corpus.</p>'
    : sorted.map((impact) => `<div class="code-impact-block">${renderImpact(impact)}</div>`).join("");
  return [
    summaryHtml,
    next ? renderCard("Recommended next actions", `<ul class="code-action-list">${next}</ul>`) : "",
    items,
  ].join("\n");
}

function riskRank(risk) {
  return { none: 0, low: 1, medium: 2, high: 3 }[risk] ?? 0;
}

function renderError(err) {
  if (err instanceof ApiError) {
    return `<div class="inline-notice inline-notice--error"><strong>${esc(err.code)}</strong> · ${esc(err.message)}</div>`;
  }
  return `<div class="inline-notice inline-notice--error"><strong>Error</strong> · ${esc(err?.message ?? String(err))}</div>`;
}

export async function render(container) {
  const pageHtml = [
    `<div class="page-header">
      <div>
        <div class="page-kicker">Operational</div>
        <h1 class="page-title">Code intelligence</h1>
        <p class="page-subtitle">
          ADR-015 Layer 1 — inspect a path's Monsthera footprint, find its owners and active work,
          and analyze the impact of a git diff. No AST or call graph; just code refs over the
          existing knowledge/work corpus.
        </p>
      </div>
    </div>`,
    `<div class="layout-split">
      <div class="layout-split__left">${renderInspectPanel()}</div>
      <div class="layout-split__right">${renderChangesPanel()}</div>
    </div>`,
  ].join("\n");
  appendHtml(container, pageHtml);

  const inspectForm = container.querySelector("#code-inspect-form");
  const inspectInput = container.querySelector("#code-inspect-input");
  const inspectResult = container.querySelector("#code-inspect-result");
  inspectForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const path = (inspectInput?.value ?? "").trim();
    if (!path) return;
    replaceContent(inspectResult, '<p class="text-sm text-muted">Analyzing…</p>');
    try {
      const impact = await getCodeImpact(path);
      replaceContent(inspectResult, renderImpact(impact));
    } catch (err) {
      replaceContent(inspectResult, renderError(err));
    }
  });

  const changesForm = container.querySelector("#code-changes-form");
  const changesInput = container.querySelector("#code-changes-input");
  const changesResult = container.querySelector("#code-changes-result");
  changesForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const paths = (changesInput?.value ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (paths.length === 0) {
      replaceContent(changesResult, renderError({ message: "Provide at least one path" }));
      return;
    }
    replaceContent(changesResult, '<p class="text-sm text-muted">Detecting…</p>');
    try {
      const payload = await detectCodeChanges(paths);
      replaceContent(changesResult, renderImpactsList(payload));
    } catch (err) {
      replaceContent(changesResult, renderError(err));
    }
  });
}
