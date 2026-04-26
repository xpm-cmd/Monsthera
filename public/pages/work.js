import {
  addWorkDependency,
  advanceWork,
  assignReviewer,
  contributeEnrichment,
  createWork,
  deleteWork,
  getAgents,
  getConvoys,
  getOrchestrationWave,
  getWork,
  getWorkSnapshotDiff,
  removeWorkDependency,
  submitReview,
  updateWork,
} from "../lib/api.js";
import {
  esc,
  phaseVariant,
  priorityVariant,
  renderBadge,
  renderHeroCallout,
  renderStatCard,
  renderTable,
  renderTabs,
  timeAgo,
} from "../lib/components.js";

const PHASES = ["planning", "enrichment", "implementation", "review", "done"];
const NEXT_PHASE = {
  planning: "enrichment",
  enrichment: "implementation",
  implementation: "review",
  review: "done",
};
const FILTERS = [
  { id: "all", label: "All work" },
  { id: "ready", label: "Ready wave" },
  { id: "blocked", label: "Blocked" },
  { id: "review", label: "Needs review" },
  { id: "unassigned", label: "Unassigned impl" },
];

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderPriorityOptions(selected) {
  return ["critical", "high", "medium", "low"]
    .map((priority) => `<option value="${priority}"${priority === selected ? " selected" : ""}>${priority}</option>`)
    .join("");
}

function renderTemplateOptions(selected) {
  return ["feature", "bugfix", "refactor", "spike"]
    .map((template) => `<option value="${template}"${template === selected ? " selected" : ""}>${template}</option>`)
    .join("");
}

function collectAgentOptions(workArticles, directory) {
  const ids = new Set((directory.agents || []).map((agent) => agent.id));
  for (const article of workArticles) {
    [article.author, article.lead, article.assignee].filter(Boolean).forEach((id) => ids.add(id));
    (article.reviewers || []).forEach((reviewer) => ids.add(reviewer.agentId));
    (article.enrichmentRoles || []).forEach((role) => ids.add(role.agentId));
  }
  return [...ids].sort();
}

function buildAgentDatalist(agentOptions) {
  return `<datalist id="agent-options">${agentOptions.map((agentId) => `<option value="${esc(agentId)}"></option>`).join("")}</datalist>`;
}

function buildCreateForm() {
  return [
    '<form class="card form-stack" data-work-create>',
    '<div class="card-title">Create work article</div>',
    '<div class="form-grid form-grid--three">',
    '<label class="field"><span class="text-label">Title</span><input class="input" name="title" placeholder="Implement workspace search" required></label>',
    '<label class="field"><span class="text-label">Author</span><input class="input" name="author" list="agent-options" placeholder="planner-agent" required></label>',
    '<label class="field"><span class="text-label">Lead</span><input class="input" name="lead" list="agent-options" placeholder="lead-agent"></label>',
    `<label class="field"><span class="text-label">Template</span><select class="input" name="template">${renderTemplateOptions("feature")}</select></label>`,
    `<label class="field"><span class="text-label">Priority</span><select class="input" name="priority">${renderPriorityOptions("medium")}</select></label>`,
    '<label class="field"><span class="text-label">Assignee</span><input class="input" name="assignee" list="agent-options" placeholder="builder-agent"></label>',
    "</div>",
    '<div class="form-grid form-grid--three">',
    '<label class="field"><span class="text-label">Tags</span><input class="input" name="tags" placeholder="search, dashboard"></label>',
    '<label class="field"><span class="text-label">References</span><input class="input" name="references" placeholder="k-article-id, architecture-overview"></label>',
    '<label class="field"><span class="text-label">Code refs</span><input class="input" name="codeRefs" placeholder="src/search/service.ts, src/dashboard/index.ts"></label>',
    "</div>",
    '<label class="field"><span class="text-label">Content</span><textarea class="textarea textarea--dense" name="content" placeholder="## Objective&#10;Describe the goal&#10;&#10;## Acceptance Criteria&#10;- [ ] One clear outcome"></textarea></label>',
    '<div class="form-actions"><button class="btn btn--primary btn--sm" type="submit">Create article</button></div>',
    "</form>",
  ].join("");
}

function buildReviewerManager(article) {
  const current = (article.reviewers || []).length > 0
    ? `<div class="form-stack mt-8">${article.reviewers.map((reviewer) =>
      `<div class="guide-line"><div><div class="text-sm" style="font-weight:600">${esc(reviewer.agentId)}</div><div class="text-xs text-muted mt-4">${esc(reviewer.status)}</div></div>${renderBadge(reviewer.status, reviewer.status === "pending" ? "warning" : reviewer.status === "approved" ? "success" : "error")}</div>`
    ).join("")}</div>`
    : '<p class="text-xs text-muted mt-8">No reviewers assigned yet.</p>';

  const pendingActions = article.phase === "review"
    ? (article.reviewers || [])
        .filter((reviewer) => reviewer.status === "pending")
        .map((reviewer) => [
          `<button class="btn btn--primary btn--sm" type="button" data-submit-review="${esc(article.id)}" data-reviewer="${esc(reviewer.agentId)}" data-status="approved">Approve ${esc(reviewer.agentId)}</button>`,
          `<button class="btn btn--outline btn--sm" type="button" data-submit-review="${esc(article.id)}" data-reviewer="${esc(reviewer.agentId)}" data-status="changes-requested">Request changes</button>`,
        ].join(" ")).join("")
    : "";

  return [
    '<div class="mt-16">',
    '<div class="text-label">Review orchestration</div>',
    current,
    `<form class="form-stack mt-8" data-reviewer-add="${esc(article.id)}">`,
    '<label class="field"><span class="text-label">Assign reviewer</span><input class="input" name="reviewerAgentId" list="agent-options" placeholder="reviewer-agent" required></label>',
    '<div class="form-actions"><button class="btn btn--outline btn--sm" type="submit">Assign reviewer</button></div>',
    "</form>",
    pendingActions ? `<div class="work-card__actions mt-8">${pendingActions}</div>` : "",
    "</div>",
  ].join("");
}

function buildDependencyManager(article, workArticles) {
  const currentBlockers = article.blockedBy || [];
  const availableBlockers = workArticles.filter((candidate) =>
    candidate.id !== article.id && !currentBlockers.includes(candidate.id)
  );

  const dependencyList = currentBlockers.length > 0
    ? `<div class="form-stack mt-8">${currentBlockers.map((blockedById) => {
        const blocker = workArticles.find((candidate) => candidate.id === blockedById);
        return `<div class="guide-line"><div><div class="text-sm" style="font-weight:600">${esc(blocker?.title || blockedById)}</div><div class="text-xs text-muted mt-4">${esc(blockedById)}</div></div><button class="btn btn--ghost btn--sm" type="button" data-remove-dependency="${esc(article.id)}" data-blocked-by="${esc(blockedById)}">Remove</button></div>`;
      }).join("")}</div>`
    : '<p class="text-xs text-muted mt-8">No blockers linked.</p>';

  const addForm = availableBlockers.length > 0
    ? [
        `<form class="form-stack mt-8" data-work-dependency-add="${esc(article.id)}">`,
        '<label class="field"><span class="text-label">Blocked by</span>',
        '<select class="input" name="blockedById">',
        availableBlockers.map((candidate) => `<option value="${esc(candidate.id)}">${esc(candidate.title)} (${esc(candidate.id)})</option>`).join(""),
        '</select></label>',
        '<div class="form-actions"><button class="btn btn--outline btn--sm" type="submit">Add blocker</button></div>',
        '</form>',
      ].join("")
    : '<p class="text-xs text-muted mt-8">No additional blockers available.</p>';

  return [
    '<div class="mt-16">',
    '<div class="text-label">Dependencies</div>',
    dependencyList,
    addForm,
    "</div>",
  ].join("");
}

const DRIFT_PHASES = new Set(["implementation", "review"]);

function buildSnapshotDriftPlaceholder(article) {
  if (!DRIFT_PHASES.has(article.phase)) return "";
  return `<div class="mt-16 snapshot-drift" data-snapshot-diff="${esc(article.id)}"></div>`;
}

function renderSnapshotDriftBand(payload) {
  if (!payload) return "";
  if (!payload.baseline || !payload.diff) {
    const capturedAt = payload.current?.capturedAt
      ? ` · captured ${esc(timeAgo(payload.current.capturedAt))}`
      : "";
    return `<div class="inline-notice inline-notice--outline"><strong>Environment snapshot</strong><div class="text-xs text-muted mt-4">Only one snapshot on record for this work article; nothing to diff against${capturedAt}.</div></div>`;
  }
  const diff = payload.diff;
  const changes = [];
  if (diff.cwdChanged) changes.push("cwd");
  if (diff.branchChanged) changes.push("branch");
  if (diff.shaChanged) changes.push("sha");
  if (diff.dirtyChanged) changes.push("dirty");
  if (diff.packageManagersChanged) changes.push("package managers");
  if (diff.runtimesChanged?.length) changes.push(`runtimes (${diff.runtimesChanged.map(esc).join(", ")})`);
  if (diff.lockfilesChanged?.length) changes.push(`lockfiles (${diff.lockfilesChanged.map(esc).join(", ")})`);
  if (changes.length === 0) {
    return `<div class="inline-notice inline-notice--success"><strong>Environment snapshot</strong><div class="text-xs text-muted mt-4">Current sandbox matches the baseline recorded for this work article.</div></div>`;
  }
  const ageDelta = typeof diff.ageDeltaSeconds === "number"
    ? `Baseline → current: ${Math.max(0, Math.round(diff.ageDeltaSeconds / 60))} min`
    : "";
  return [
    '<div class="inline-notice inline-notice--warning">',
    '<strong>Sandbox drift detected</strong>',
    `<div class="text-xs mt-4">Changed: ${changes.join(" · ")}</div>`,
    ageDelta ? `<div class="text-xs text-muted mt-4">${esc(ageDelta)}</div>` : "",
    '</div>',
  ].filter(Boolean).join("");
}

function buildEnrichmentPanel(article) {
  const rows = (article.enrichmentRoles || []).length > 0
    ? article.enrichmentRoles.map((role) => {
        const actions = article.phase === "enrichment" && role.status === "pending"
          ? [
              `<button class="btn btn--outline btn--sm" type="button" data-enrich-work="${esc(article.id)}" data-role="${esc(role.role)}" data-status="contributed">Contributed</button>`,
              `<button class="btn btn--ghost btn--sm" type="button" data-enrich-work="${esc(article.id)}" data-role="${esc(role.role)}" data-status="skipped">Skip</button>`,
            ].join("")
          : "";
        return `<div class="guide-line"><div><div class="text-sm" style="font-weight:600">${esc(role.role)}</div><div class="text-xs text-muted mt-4">${esc(role.agentId)} · ${esc(role.status)}</div></div>${actions || renderBadge(role.status, role.status === "contributed" ? "success" : role.status === "skipped" ? "outline" : "warning")}</div>`;
      }).join("")
    : '<p class="text-xs text-muted mt-8">No enrichment roles on this article.</p>';

  return [
    '<div class="mt-16">',
    '<div class="text-label">Enrichment</div>',
    `<div class="form-stack mt-8">${rows}</div>`,
    "</div>",
  ].join("");
}

function buildConvoyLeadMap(convoys) {
  const map = new Map();
  const all = [...(convoys.active || []), ...(convoys.terminal || [])];
  for (const c of all) {
    const list = map.get(c.leadWorkId) || [];
    list.push(c);
    map.set(c.leadWorkId, list);
  }
  return map;
}

function renderConvoyRibbon(convoys) {
  if (!convoys || convoys.length === 0) return "";
  const pills = convoys.map((c) => {
    const cls = c.status === "active" ? "convoy-pill convoy-pill--active"
      : c.status === "completed" ? "convoy-pill convoy-pill--completed"
      : "convoy-pill convoy-pill--cancelled";
    const meta = c.status === "active"
      ? ` · ${c.members.length} member${c.members.length === 1 ? "" : "s"}`
      : "";
    return `<a href="/convoys/${esc(c.id)}" data-link class="${cls}">${esc(c.id)} · ${esc(c.status)}${meta}</a>`;
  }).join(" ");
  return `<div class="convoy-ribbon"><span class="text-label">lead of</span> ${pills}</div>`;
}

function buildExpandedActions(article, readySet) {
  const actions = [];
  const nextPhase = NEXT_PHASE[article.phase];
  const terminal = article.phase === "done" || article.phase === "cancelled";
  if (nextPhase) {
    actions.push(
      `<button class="btn btn--outline btn--sm" type="button" data-advance-work="${esc(article.id)}" data-phase="${nextPhase}">Move to ${esc(nextPhase)}</button>`,
    );
    actions.push(
      `<button class="btn btn--ghost btn--sm" type="button" data-override-guard="${esc(article.id)}" data-phase="${nextPhase}" title="Bypass failing guards with an auditable reason">Override guards</button>`,
    );
  }
  if (readySet.has(article.id) && nextPhase) {
    actions.push(renderBadge("ready to advance", "success"));
  }
  if (!terminal) {
    actions.push(
      `<button class="btn btn--ghost btn--sm" type="button" data-cancel-work="${esc(article.id)}" title="Cancel this work article (requires reason)">Cancel</button>`,
    );
  }
  actions.push(
    `<button class="btn btn--ghost btn--sm" type="button" data-delete-work="${esc(article.id)}">Delete</button>`,
  );
  return actions.join("");
}

function buildQueueCard(article, expandedId, workArticles, readySet, convoyLeadMap) {
  const expanded = article.id === expandedId;
  const tagsValue = (article.tags || []).join(", ");
  const referencesValue = (article.references || []).join(", ");
  const codeRefsValue = (article.codeRefs || []).join(", ");
  const statusBadges = [
    renderBadge(article.phase, phaseVariant(article.phase)),
    renderBadge(article.priority, priorityVariant(article.priority)),
    readySet.has(article.id) ? renderBadge("ready", "success") : "",
    article.blockedBy?.length > 0 ? renderBadge("blocked", "warning") : "",
  ].filter(Boolean).join(" ");

  return [
    `<div class="card work-card${expanded ? " is-expanded" : ""}" data-work-id="${esc(article.id)}">`,
    `<button class="work-card__toggle" type="button" data-toggle-work="${esc(article.id)}" aria-expanded="${String(expanded)}" aria-controls="work-detail-${esc(article.id)}">`,
    '<div class="flex items-center justify-between gap-12">',
    '<div class="flex items-center gap-8">',
    `<strong class="text-sm">${esc(article.title)}</strong>`,
    statusBadges,
    '</div>',
    `<span class="text-xs text-muted">${timeAgo(article.updatedAt)}</span>`,
    '</div>',
    '</button>',
    `<p class="text-xs text-muted mt-4">Template: ${esc(article.template)} · Author: ${esc(article.author)} · ${article.assignee ? `Assigned to ${esc(article.assignee)}` : "Unassigned"}</p>`,
    article.content ? `<p class="text-sm mt-8">${esc(article.content.slice(0, 220))}</p>` : "",
    expanded
      ? [
          `<div class="work-card__expanded" id="work-detail-${esc(article.id)}">`,
          `<div class="work-card__actions">${buildExpandedActions(article, readySet)}</div>`,
          renderConvoyRibbon(convoyLeadMap ? convoyLeadMap.get(article.id) : null),
          '<form class="form-stack mt-8" data-work-edit="' + esc(article.id) + '">',
          '<div class="form-grid form-grid--three">',
          `<label class="field"><span class="text-label">Title</span><input class="input" name="title" value="${esc(article.title)}" required></label>`,
          `<label class="field"><span class="text-label">Lead</span><input class="input" name="lead" list="agent-options" value="${esc(article.lead || "")}" placeholder="lead-agent"></label>`,
          `<label class="field"><span class="text-label">Assignee</span><input class="input" name="assignee" list="agent-options" value="${esc(article.assignee || "")}" placeholder="builder-agent"></label>`,
          `<label class="field"><span class="text-label">Priority</span><select class="input" name="priority">${renderPriorityOptions(article.priority)}</select></label>`,
          `<label class="field"><span class="text-label">Tags</span><input class="input" name="tags" value="${esc(tagsValue)}" placeholder="frontend, search"></label>`,
          `<label class="field"><span class="text-label">References</span><input class="input" name="references" value="${esc(referencesValue)}" placeholder="k-article-id, architecture-overview"></label>`,
          "</div>",
          `<label class="field"><span class="text-label">Code refs</span><input class="input" name="codeRefs" value="${esc(codeRefsValue)}" placeholder="src/work/service.ts"></label>`,
          `<label class="field"><span class="text-label">Content</span><textarea class="textarea" name="content">${esc(article.content || "")}</textarea></label>`,
          '<div class="form-actions"><button class="btn btn--primary btn--sm" type="submit">Save changes</button></div>',
          '</form>',
          buildSnapshotDriftPlaceholder(article),
          buildEnrichmentPanel(article),
          buildReviewerManager(article),
          buildDependencyManager(article, workArticles),
          article.phaseHistory?.length
            ? `<p class="text-xs text-muted mt-16">Phases: ${article.phaseHistory.map((entry) => esc(entry.phase)).join(" → ")}</p>`
            : "",
          '</div>',
        ].join("")
      : "",
      '</div>',
  ].join("");
}

export async function render(container) {
  let [workArticles, directory, wave, convoys] = await Promise.all([
    getWork().catch(() => []),
    getAgents().catch(() => ({ agents: [], summary: {} })),
    getOrchestrationWave().catch(() => null),
    getConvoys().catch(() => ({ active: [], terminal: [], warnings: [] })),
  ]);
  let convoyLeadMap = buildConvoyLeadMap(convoys);
  let viewMode = "queue";
  let expandedId = null;
  let showCreate = true;
  let flash = null;
  let filters = {
    query: "",
    phase: "all",
    priority: "all",
    state: "all",
  };

  const snapshotDiffCache = new Map();

  async function refresh(preferredId = expandedId) {
    [workArticles, directory, wave, convoys] = await Promise.all([
      getWork().catch(() => []),
      getAgents().catch(() => ({ agents: [], summary: {} })),
      getOrchestrationWave().catch(() => null),
      getConvoys().catch(() => ({ active: [], terminal: [], warnings: [] })),
    ]);
    convoyLeadMap = buildConvoyLeadMap(convoys);
    if (preferredId && workArticles.some((article) => article.id === preferredId)) {
      expandedId = preferredId;
    } else {
      expandedId = null;
    }
  }

  async function runMutation(action, successMessage, preferredId = expandedId) {
    try {
      const result = await action();
      flash = { kind: "success", message: successMessage };
      await refresh(result?.id || preferredId || null);
      snapshotDiffCache.clear();
      rerender();
    } catch (error) {
      flash = { kind: "error", message: error?.message || "Request failed" };
      rerender();
    }
  }

  function getAgentOptions() {
    return collectAgentOptions(workArticles, directory);
  }

  function openArticleInQueue(id) {
    viewMode = "queue";
    expandedId = id;
    rerender();
  }

  function getFilteredArticles() {
    const readySet = new Set((wave?.ready ?? []).map((item) => item.workId));
    return workArticles.filter((article) => {
      if (filters.phase !== "all" && article.phase !== filters.phase) return false;
      if (filters.priority !== "all" && article.priority !== filters.priority) return false;
      if (filters.state === "ready" && !readySet.has(article.id)) return false;
      if (filters.state === "blocked" && !(article.blockedBy?.length > 0)) return false;
      if (filters.state === "review" && !article.reviewers?.some((reviewer) => reviewer.status === "pending")) return false;
      if (filters.state === "unassigned" && !(article.phase === "implementation" && !article.assignee)) return false;

      if (!filters.query) return true;
      const haystack = [
        article.id,
        article.title,
        article.template,
        article.phase,
        article.priority,
        article.author,
        article.lead,
        article.assignee,
        ...(article.tags || []),
        ...(article.references || []),
        ...(article.codeRefs || []),
        article.content || "",
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(filters.query.toLowerCase());
    });
  }

  function buildFlash() {
    if (!flash) return "";
    const variant = flash.kind === "error" ? "error" : "success";
    return `<div class="inline-notice inline-notice--${variant}">${esc(flash.message)}</div>`;
  }

  function buildToolbar() {
    return [
      '<div class="toolbar-panel">',
      '<div class="toolbar-grid">',
      '<label class="field"><span class="text-label">Search</span><input class="input" name="query" data-filter-input value="' + esc(filters.query) + '" placeholder="Search title, refs, code, tags"></label>',
      '<label class="field"><span class="text-label">Phase</span><select class="input" name="phase" data-filter-select>',
      '<option value="all">All phases</option>',
      PHASES.map((phase) => `<option value="${phase}"${filters.phase === phase ? " selected" : ""}>${phase}</option>`).join(""),
      '</select></label>',
      '<label class="field"><span class="text-label">Priority</span><select class="input" name="priority" data-filter-select>',
      '<option value="all">All priorities</option>',
      ["critical", "high", "medium", "low"].map((priority) => `<option value="${priority}"${filters.priority === priority ? " selected" : ""}>${priority}</option>`).join(""),
      '</select></label>',
      '<label class="field"><span class="text-label">State</span><select class="input" name="state" data-filter-select>',
      FILTERS.map((filter) => `<option value="${filter.id}"${filters.state === filter.id ? " selected" : ""}>${filter.label}</option>`).join(""),
      '</select></label>',
      "</div>",
      "</div>",
    ].join("");
  }

  function buildBody() {
    const filteredArticles = getFilteredArticles();
    const readySet = new Set((wave?.ready ?? []).map((item) => item.workId));
    if (viewMode === "queue") {
      if (filteredArticles.length === 0) {
        return '<p class="text-sm text-muted" style="padding:20px">No work articles match the current filters.</p>';
      }
      return filteredArticles.map((article) => buildQueueCard(article, expandedId, workArticles, readySet, convoyLeadMap)).join("\n");
    }

    if (viewMode === "board") {
      let bodyHtml = '<div class="board">';
      for (const phase of PHASES) {
        const items = filteredArticles.filter((article) => article.phase === phase);
        bodyHtml += `<div class="board-column"><div class="board-column-header">${esc(phase)} (${items.length})</div>`;
        for (const article of items) {
          bodyHtml += `<button type="button" class="board-card" data-open-work="${esc(article.id)}">`
            + `<strong class="text-sm">${esc(article.title)}</strong>`
            + `<p class="text-xs text-muted mt-4">${article.assignee ? esc(article.assignee) : "Unassigned"}</p>`
            + `<div class="mt-8">${renderBadge(article.priority, priorityVariant(article.priority))}${readySet.has(article.id) ? ` ${renderBadge("ready", "success")}` : ""}</div>`
            + "</button>";
        }
        bodyHtml += "</div>";
      }
      bodyHtml += "</div>";
      return bodyHtml;
    }

    return renderTable(
      [
        { key: "id", label: "ID", width: "84px" },
        {
          key: "title",
          label: "Title",
          render: (row) => `<button type="button" class="table-link" data-open-work="${esc(row.id)}">${esc(row.title)}</button>`,
        },
        { key: "phase", label: "Phase", width: "120px", render: (row) => renderBadge(row.phase, phaseVariant(row.phase)) },
        { key: "priority", label: "Priority", width: "100px", render: (row) => renderBadge(row.priority, priorityVariant(row.priority)) },
        { key: "assignee", label: "Assignee", width: "140px", render: (row) => esc(row.assignee || "—") },
        { key: "updatedAt", label: "Updated", width: "100px", align: "right", render: (row) => `<span class="text-xs text-muted">${timeAgo(row.updatedAt)}</span>` },
      ],
      filteredArticles,
    );
  }

  function buildDOM() {
    const filteredArticles = getFilteredArticles();
    const readyCount = wave?.summary?.readyCount ?? 0;
    const blockedCount = workArticles.filter((article) => article.blockedBy?.length > 0).length;
    const pendingReviewCount = workArticles.filter((article) => article.reviewers?.some((reviewer) => reviewer.status === "pending")).length;
    const unassignedImplCount = workArticles.filter((article) => article.phase === "implementation" && !article.assignee).length;
    const viewTabs = [
      { id: "queue", label: "Queue" },
      { id: "board", label: "Board" },
      { id: "list", label: "List" },
    ];
    const workPrimer = renderHeroCallout({
      eyebrow: "Execution contract",
      title: showCreate ? "Capture the work clearly before it spreads across agents" : "Use Work to tighten contracts and move execution safely",
      body: "This page is the source of truth for objective, ownership, references, blockers, and review. If a handoff matters, it should be visible here.",
      meta: [
        renderBadge(`${workArticles.length} articles`, "secondary"),
        renderBadge(`${readyCount} ready`, readyCount > 0 ? "success" : "outline"),
        renderBadge(`${pendingReviewCount} pending review`, pendingReviewCount > 0 ? "warning" : "secondary"),
      ],
      steps: [
        { title: "Shape", detail: "Create or edit the article until the objective and acceptance criteria are explicit." },
        { title: "Ground", detail: "Attach references and code refs so the next agent reads less and better." },
        { title: "Gate", detail: "Keep blockers and reviewers explicit before calling the work done." },
      ],
    });

    const temp = document.createElement("template");
    temp.innerHTML = [
      '<div class="page-header"><div><div class="page-kicker">Run the queue</div><h1 class="page-title">Work</h1><p class="page-subtitle">Operate the canonical work article with owners, context, blockers, and reviews connected.</p></div><div class="page-actions">',
      '<button class="btn btn--outline btn--sm" type="button" data-toggle-create>' + (showCreate ? "Hide create form" : "New article") + "</button>",
      '<a href="/guide" data-link class="btn btn--outline btn--sm">How to operate work</a>',
      '</div></div>',
      buildFlash(),
      workPrimer,
      '<div class="guide-hero">',
      renderStatCard("Ready wave", readyCount, renderBadge(readyCount > 0 ? "advance now" : "waiting", readyCount > 0 ? "success" : "outline")),
      renderStatCard("Blocked", blockedCount, renderBadge(blockedCount > 0 ? "dependency action" : "clear", blockedCount > 0 ? "warning" : "success")),
      renderStatCard("Pending reviews", pendingReviewCount, renderBadge(pendingReviewCount > 0 ? "review queue" : "clear", pendingReviewCount > 0 ? "warning" : "success")),
      renderStatCard("Unassigned impl", unassignedImplCount, renderBadge(unassignedImplCount > 0 ? "assign owners" : "covered", unassignedImplCount > 0 ? "error" : "success")),
      '</div>',
      showCreate ? buildCreateForm() : "",
      buildToolbar(),
      renderTabs(viewTabs, viewMode),
      `<div class="text-xs text-muted">Showing ${esc(String(filteredArticles.length))} of ${esc(String(workArticles.length))} article(s).</div>`,
      `<div style="margin-top:8px">${buildBody()}</div>`,
      buildAgentDatalist(getAgentOptions()),
    ].join("\n");
    return temp.content;
  }

  async function hydrateSnapshotDrift() {
    const placeholders = container.querySelectorAll("[data-snapshot-diff]");
    for (const node of placeholders) {
      const id = node.getAttribute("data-snapshot-diff");
      if (!id) continue;
      if (snapshotDiffCache.has(id)) {
        node.innerHTML = renderSnapshotDriftBand(snapshotDiffCache.get(id));
        continue;
      }
      node.innerHTML = '<div class="text-xs text-muted">Checking snapshot drift…</div>';
      try {
        const payload = await getWorkSnapshotDiff(id);
        snapshotDiffCache.set(id, payload);
        node.innerHTML = renderSnapshotDriftBand(payload);
      } catch (error) {
        if (error?.status === 404) {
          snapshotDiffCache.set(id, null);
          node.innerHTML = "";
        } else {
          node.innerHTML = '<div class="text-xs text-muted">Snapshot drift unavailable.</div>';
        }
      }
    }
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
    hydrateSnapshotDrift();
  }

  rerender();

  const ac = new AbortController();

  container.addEventListener("click", async (event) => {
    const target = event.target;

    const toggleCreate = target.closest("[data-toggle-create]");
    if (toggleCreate) {
      showCreate = !showCreate;
      rerender();
      return;
    }

    const tab = target.closest("[data-tab]");
    if (tab) {
      viewMode = tab.dataset.tab;
      expandedId = null;
      rerender();
      return;
    }

    const toggleCardButton = target.closest("[data-toggle-work]");
    if (toggleCardButton) {
      expandedId = expandedId === toggleCardButton.dataset.toggleWork ? null : toggleCardButton.dataset.toggleWork;
      rerender();
      return;
    }

    const openWorkButton = target.closest("[data-open-work]");
    if (openWorkButton) {
      openArticleInQueue(openWorkButton.dataset.openWork);
      return;
    }

    const advanceButton = target.closest("[data-advance-work]");
    if (advanceButton) {
      const id = advanceButton.dataset.advanceWork;
      const phase = advanceButton.dataset.phase;
      await runMutation(
        async () => {
          try {
            return await advanceWork(id, phase);
          } catch (error) {
            if (error?.code === "GUARD_FAILED") {
              const reason = window.prompt(
                `Guards failed: ${error.message}\n\nProvide a justification to bypass (logged in phase history), or Cancel:`,
              );
              if (!reason || !reason.trim()) throw error;
              return advanceWork(id, phase, { skipGuard: { reason: reason.trim() } });
            }
            throw error;
          }
        },
        `Moved article to ${phase}.`,
        id,
      );
      return;
    }

    const overrideButton = target.closest("[data-override-guard]");
    if (overrideButton) {
      const id = overrideButton.dataset.overrideGuard;
      const phase = overrideButton.dataset.phase;
      const reason = window.prompt(
        `Override guards and advance to "${phase}". Provide a justification (recorded in phase history):`,
      );
      if (!reason || !reason.trim()) return;
      await runMutation(
        () => advanceWork(id, phase, { skipGuard: { reason: reason.trim() } }),
        `Advanced to ${phase} with guard override.`,
        id,
      );
      return;
    }

    const cancelButton = target.closest("[data-cancel-work]");
    if (cancelButton) {
      const id = cancelButton.dataset.cancelWork;
      const reason = window.prompt("Cancel this work article. Provide a reason (recorded in phase history):");
      if (!reason || !reason.trim()) return;
      await runMutation(
        () => advanceWork(id, "cancelled", { reason: reason.trim() }),
        "Cancelled work article.",
        id,
      );
      return;
    }

    const enrichButton = target.closest("[data-enrich-work]");
    if (enrichButton) {
      await runMutation(
        () => contributeEnrichment(enrichButton.dataset.enrichWork, enrichButton.dataset.role, enrichButton.dataset.status),
        `Recorded enrichment for ${enrichButton.dataset.role}.`,
        enrichButton.dataset.enrichWork,
      );
      return;
    }

    const reviewButton = target.closest("[data-submit-review]");
    if (reviewButton) {
      await runMutation(
        () => submitReview(reviewButton.dataset.submitReview, reviewButton.dataset.reviewer, reviewButton.dataset.status),
        `Recorded review from ${reviewButton.dataset.reviewer}.`,
        reviewButton.dataset.submitReview,
      );
      return;
    }

    const removeDependencyButton = target.closest("[data-remove-dependency]");
    if (removeDependencyButton) {
      await runMutation(
        () => removeWorkDependency(removeDependencyButton.dataset.removeDependency, removeDependencyButton.dataset.blockedBy),
        "Removed blocker relationship.",
        removeDependencyButton.dataset.removeDependency,
      );
      return;
    }

    const deleteButton = target.closest("[data-delete-work]");
    if (deleteButton) {
      if (!window.confirm(`Delete work article ${deleteButton.dataset.deleteWork}?`)) return;
      await runMutation(
        async () => {
          await deleteWork(deleteButton.dataset.deleteWork);
          return { id: null };
        },
        "Deleted work article.",
        null,
      );
      return;
    }

    const card = target.closest("[data-work-id]");
    if (!card) return;
    if (target.closest("button, input, textarea, select, label, form, a, option")) return;
    expandedId = expandedId === card.dataset.workId ? null : card.dataset.workId;
    rerender();
  }, { signal: ac.signal });

  container.addEventListener("input", (event) => {
    const input = event.target.closest("[data-filter-input]");
    if (input) {
      filters.query = input.value;
      const cursor = input.selectionStart ?? filters.query.length;
      rerender();
      const nextInput = container.querySelector("[data-filter-input]");
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(cursor, cursor);
      }
    }
  }, { signal: ac.signal });

  container.addEventListener("change", (event) => {
    const select = event.target.closest("[data-filter-select]");
    if (select) {
      filters[select.name] = select.value;
      rerender();
    }
  }, { signal: ac.signal });

  container.addEventListener("submit", async (event) => {
    const form = event.target.closest("form");
    if (!form) return;
    event.preventDefault();

    if (form.matches("[data-work-create]")) {
      const data = new FormData(form);
      await runMutation(
        () => createWork({
          title: String(data.get("title") || "").trim(),
          template: String(data.get("template") || "feature"),
          author: String(data.get("author") || "").trim(),
          lead: String(data.get("lead") || "").trim() || undefined,
          assignee: String(data.get("assignee") || "").trim() || undefined,
          priority: String(data.get("priority") || "medium"),
          tags: parseCsv(data.get("tags")),
          references: parseCsv(data.get("references")),
          codeRefs: parseCsv(data.get("codeRefs")),
          content: String(data.get("content") || "").trim() || undefined,
        }),
        "Created work article.",
      );
      form.reset();
      return;
    }

    if (form.matches("[data-work-edit]")) {
      const id = form.dataset.workEdit;
      const data = new FormData(form);
      await runMutation(
        () => updateWork(id, {
          title: String(data.get("title") || "").trim(),
          lead: String(data.get("lead") || "").trim() || undefined,
          assignee: String(data.get("assignee") || "").trim() || undefined,
          priority: String(data.get("priority") || "medium"),
          tags: parseCsv(data.get("tags")),
          references: parseCsv(data.get("references")),
          codeRefs: parseCsv(data.get("codeRefs")),
          content: String(data.get("content") || ""),
        }),
        "Saved work article changes.",
        id,
      );
      return;
    }

    if (form.matches("[data-reviewer-add]")) {
      const id = form.dataset.reviewerAdd;
      const data = new FormData(form);
      await runMutation(
        () => assignReviewer(id, String(data.get("reviewerAgentId") || "").trim()),
        "Assigned reviewer.",
        id,
      );
      return;
    }

    if (form.matches("[data-work-dependency-add]")) {
      const id = form.dataset.workDependencyAdd;
      const data = new FormData(form);
      await runMutation(
        () => addWorkDependency(id, String(data.get("blockedById") || "")),
        "Linked blocker to work article.",
        id,
      );
    }
  }, { signal: ac.signal });

  return { cleanup: () => ac.abort() };
}
