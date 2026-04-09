import {
  executeOrchestrationWave,
  getAgents,
  getOrchestrationWave,
  getSystemRuntime,
  getWork,
} from "../lib/api.js";
import { phasePlaybooks } from "../lib/guide-data.js";
import {
  esc,
  phaseVariant,
  renderBadge,
  renderCard,
  renderChips,
  renderHeroCallout,
  renderStatCard,
  renderTable,
  timeAgo,
} from "../lib/components.js";

const PHASES = ["planning", "enrichment", "implementation", "review", "done"];

export async function render(container) {
  let [directory, workArticles, wave, runtime] = await Promise.all([
    getAgents().catch(() => ({ agents: [], summary: { currentPhaseCounts: {} } })),
    getWork().catch(() => []),
    getOrchestrationWave().catch(() => null),
    getSystemRuntime().catch(() => null),
  ]);
  let activePhase = "all";
  let flash = null;

  async function refresh() {
    [directory, workArticles, wave, runtime] = await Promise.all([
      getAgents().catch(() => ({ agents: [], summary: { currentPhaseCounts: {} } })),
      getWork().catch(() => []),
      getOrchestrationWave().catch(() => null),
      getSystemRuntime().catch(() => null),
    ]);
  }

  async function handleRunWave() {
    try {
      const result = await executeOrchestrationWave();
      flash = {
        kind: "success",
        message: `Advanced ${result.summary.advancedCount} ready article(s).`,
      };
      await refresh();
      rerender();
    } catch (error) {
      flash = { kind: "error", message: error?.message || "Wave execution failed" };
      rerender();
    }
  }

  function buildFlash() {
    if (!flash) return "";
    const variant = flash.kind === "error" ? "error" : "success";
    return `<div class="inline-notice inline-notice--${variant}">${esc(flash.message)}</div>`;
  }

  function getRows() {
    return (directory.agents || []).map((agent) => ({
      agent: agent.id,
      action: agent.current?.actionLabel ?? "Idle",
      phase: agent.current?.phase ?? "idle",
      article: agent.current?.title ?? "No active article",
      articleId: agent.current?.workId,
      lastActivity: agent.lastActivityAt,
      pendingReviews: agent.pendingReviewCount,
      blockedWorkCount: agent.blockedWorkCount,
      status: agent.status,
    }));
  }

  function getFilteredAgents() {
    const agents = getRows();
    if (activePhase === "all") return agents;
    return agents.filter((agent) => agent.phase === activePhase);
  }

  function getPhaseCounts() {
    const counts = { all: workArticles.length };
    for (const phase of PHASES) {
      counts[phase] = workArticles.filter((article) => article.phase === phase).length;
    }
    return counts;
  }

  function buildReadyItems() {
    const items = wave?.ready ?? [];
    if (items.length === 0) {
      return '<p class="text-sm text-muted">No articles are ready to advance right now. Improve the work article, enrichment, or review state first.</p>';
    }
    return items.slice(0, 6).map((item) =>
      `<div class="guide-line"><div><div class="text-sm" style="font-weight:600">${esc(item.title)}</div><div class="text-xs text-muted mt-4">${esc(item.workId)} · ${esc(item.from)} → ${esc(item.to)}</div></div>${renderBadge(item.priority || "ready", item.priority === "critical" || item.priority === "high" ? "warning" : "success")}</div>`
    ).join("");
  }

  function buildBlockedItems() {
    const items = wave?.blocked ?? [];
    if (items.length === 0) {
      return '<p class="text-sm text-muted">No dependency blockers are active right now.</p>';
    }
    return items.slice(0, 6).map((item) =>
      `<div class="guide-line"><div><div class="text-sm" style="font-weight:600">${esc(item.title)}</div><div class="text-xs text-muted mt-4">${esc(item.reason)}</div></div>${renderBadge(item.phase || "blocked", "warning")}</div>`
    ).join("");
  }

  function buildDOM() {
    const counts = getPhaseCounts();
    const agents = getFilteredAgents();
    const autoAdvance = runtime?.orchestration?.autoAdvance;
    const activePlaybook = phasePlaybooks.find((playbook) => playbook.phase === activePhase) ?? null;
    const phaseChips = [{ id: "all", label: "All phases", count: counts.all }]
      .concat(PHASES.map((phase) => ({
        id: phase,
        label: phase.charAt(0).toUpperCase() + phase.slice(1),
        count: counts[phase],
      })));

    const tableHtml = renderTable(
      [
        { key: "agent", label: "Agent", width: "160px" },
        {
          key: "action",
          label: "Current action",
          width: "180px",
          render: (row) => renderBadge(row.action, row.phase === "idle" ? "outline" : phaseVariant(row.phase)),
        },
        {
          key: "article",
          label: "Article",
          render: (row) => row.articleId
            ? `<a href="/work" data-link style="color:var(--primary)">${esc(row.article)}</a>`
            : `<span class="text-muted">${esc(row.article)}</span>`,
        },
        {
          key: "status",
          label: "Signals",
          width: "200px",
          render: (row) => [
            row.pendingReviews > 0 ? renderBadge(`${row.pendingReviews} review`, "warning") : "",
            row.blockedWorkCount > 0 ? renderBadge(`${row.blockedWorkCount} blocked`, "error") : "",
            row.status === "idle" ? renderBadge("Idle", "outline") : "",
          ].filter(Boolean).join(" "),
        },
        {
          key: "lastActivity",
          label: "Last activity",
          width: "100px",
          align: "right",
          render: (row) => `<span class="text-muted text-xs">${timeAgo(row.lastActivity)}</span>`,
        },
      ],
      agents,
    );

    const playbookHtml = activePlaybook
      ? `<p class="text-sm" style="font-weight:600">${esc(activePlaybook.intent)}</p><ul class="guide-list">${activePlaybook.actions.map((action) => `<li>${esc(action)}</li>`).join("")}</ul>`
      : '<p class="text-sm text-muted">Select a phase to see a recommended playbook for that handoff.</p>';
    const flowPrimer = renderHeroCallout({
      eyebrow: "Control surface",
      title: activePhase === "all" ? "Use Flow to supervise automation and handoffs" : `Use Flow to supervise ${activePhase} handoffs`,
      body: activePhase === "all"
        ? "This page is for deciding what should move now, what should wait, and which agent or review gate owns the next safe transition."
        : "Filter by phase when you want to inspect a specific bottleneck, then use the playbook and wave state to decide the next safe move.",
      meta: [
        renderBadge(`${wave?.summary?.readyCount ?? 0} ready`, (wave?.summary?.readyCount ?? 0) > 0 ? "success" : "outline"),
        renderBadge(`${wave?.summary?.blockedCount ?? 0} blocked`, (wave?.summary?.blockedCount ?? 0) > 0 ? "warning" : "secondary"),
      ],
      steps: [
        { title: "Read the wave", detail: "Ready items are safe to advance. Blocked items explain why they should wait." },
        { title: "Inspect owners", detail: "The agent table shows who is active, idle, blocked, or carrying review work." },
        { title: "Advance deliberately", detail: "Run the wave only when the next handoff and review gate are explicit." },
      ],
    });

    const parts = [
      '<div class="page-header"><div><div class="page-kicker">Supervise execution</div><h1 class="page-title">Flow</h1><p class="page-subtitle">Coordinate phases, owners, ready waves, and safe automation.</p></div><div class="page-actions">',
      '<a href="/guide" data-link class="btn btn--outline btn--sm">Open guide</a>',
      wave?.summary?.readyCount > 0
        ? '<button class="btn btn--primary btn--sm" type="button" data-run-wave>Advance ready wave</button>'
        : '<a href="/work" data-link class="btn btn--primary btn--sm">Open work queue</a>',
      "</div></div>",
      buildFlash(),
      flowPrimer,
      '<div class="guide-hero">',
      renderStatCard("Ready wave", wave?.summary?.readyCount ?? 0, renderBadge((wave?.summary?.readyCount ?? 0) > 0 ? "ready now" : "waiting", (wave?.summary?.readyCount ?? 0) > 0 ? "success" : "outline")),
      renderStatCard("Blocked", wave?.summary?.blockedCount ?? 0, renderBadge((wave?.summary?.blockedCount ?? 0) > 0 ? "unblock needed" : "clear", (wave?.summary?.blockedCount ?? 0) > 0 ? "warning" : "success")),
      renderStatCard("Active agents", directory.summary?.activeAgents ?? 0, renderBadge(`${directory.summary?.totalAgents ?? 0} total`, "secondary")),
      renderStatCard("Automation", autoAdvance ? "Auto" : "Manual", renderBadge(autoAdvance ? "loop enabled" : "supervised", autoAdvance ? "success" : "secondary")),
      "</div>",
      renderChips(phaseChips, activePhase),
      '<div class="layout-split">',
      `<div class="col-main">${agents.length > 0 ? tableHtml : '<p class="text-sm text-muted" style="padding:20px">No agent activity for this phase.</p>'}</div>`,
      '<div class="col-side">',
      renderCard("Ready to advance", buildReadyItems(), wave?.summary?.readyCount > 0 ? '<button class="btn btn--outline btn--sm" type="button" data-run-wave>Run ready wave</button>' : ""),
      renderCard("Blocked work", buildBlockedItems()),
      renderCard("Phase playbook", playbookHtml, '<a href="/guide" data-link class="btn btn--ghost btn--sm">See full guide</a>'),
      "</div></div>",
    ];

    const temp = document.createElement("template");
    temp.innerHTML = parts.join("\n");
    return temp.content;
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
  }

  rerender();

  const ac = new AbortController();
  container.addEventListener("click", async (event) => {
    const chip = event.target.closest("[data-chip]");
    if (chip) {
      activePhase = chip.dataset.chip;
      rerender();
      return;
    }

    const button = event.target.closest("[data-run-wave]");
    if (button) {
      await handleRunWave();
    }
  }, { signal: ac.signal });

  return { cleanup: () => ac.abort() };
}
