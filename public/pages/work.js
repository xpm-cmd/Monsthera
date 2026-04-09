// Work page — all API data escaped via esc() before template interpolation.
// Uses <template> element for DOM construction from trusted template strings.
import { getWork } from "../lib/api.js";
import { renderBadge, renderTable, renderTabs, timeAgo, esc, phaseVariant, priorityVariant } from "../lib/components.js";

const PHASES = ["planning", "enrichment", "implementation", "review", "done"];

export async function render(container) {
  const workArticles = await getWork().catch(() => []);
  let viewMode = "queue";
  let expandedId = null;

  function buildDOM() {
    const viewTabs = [
      { id: "queue", label: "Queue" },
      { id: "board", label: "Board" },
      { id: "list", label: "List" },
    ];

    let bodyHtml = "";
    if (viewMode === "queue") {
      bodyHtml = workArticles.length > 0
        ? workArticles.map(w => {
            const expanded = w.id === expandedId;
            return '<div class="card" style="padding:14px 16px;cursor:pointer" data-work-id="' + esc(w.id) + '">'
              + '<div class="flex items-center justify-between">'
              + '<div class="flex items-center gap-8"><strong class="text-sm">' + esc(w.title) + "</strong> "
              + renderBadge(w.phase, phaseVariant(w.phase)) + " "
              + renderBadge(w.priority, priorityVariant(w.priority)) + "</div>"
              + '<span class="text-xs text-muted">' + timeAgo(w.updatedAt) + "</span></div>"
              + (w.assignee ? '<p class="text-xs text-muted mt-4">Assigned to ' + esc(w.assignee) + "</p>" : "")
              + (expanded ? '<div class="mt-8" style="border-top:1px solid var(--border);padding-top:12px">'
                + '<p class="text-xs text-muted">Template: ' + esc(w.template) + " | Author: " + esc(w.author) + "</p>"
                + (w.phaseHistory?.length ? '<p class="text-xs text-muted mt-4">Phases: '
                  + w.phaseHistory.map(p => esc(p.phase)).join(" &rarr; ") + "</p>" : "")
                + (w.content ? '<p class="text-sm mt-8">' + esc(w.content.slice(0, 300)) + "</p>" : "")
                + "</div>" : "")
              + "</div>";
          }).join("\n")
        : '<p class="text-sm text-muted" style="padding:20px">No work articles.</p>';

    } else if (viewMode === "board") {
      bodyHtml = '<div class="board">';
      for (const phase of PHASES) {
        const items = workArticles.filter(w => w.phase === phase);
        bodyHtml += '<div class="board-column"><div class="board-column-header">' + esc(phase) + " (" + items.length + ")</div>";
        for (const w of items) {
          bodyHtml += '<div class="board-card"><strong class="text-sm">' + esc(w.title) + "</strong>"
            + '<p class="text-xs text-muted mt-4">' + (w.assignee ? esc(w.assignee) : "Unassigned") + "</p></div>";
        }
        bodyHtml += "</div>";
      }
      bodyHtml += "</div>";

    } else {
      bodyHtml = renderTable(
        [
          { key: "id", label: "ID", width: "80px" },
          { key: "title", label: "Title" },
          { key: "phase", label: "Phase", width: "120px", render: row => renderBadge(row.phase, phaseVariant(row.phase)) },
          { key: "priority", label: "Priority", width: "100px", render: row => renderBadge(row.priority, priorityVariant(row.priority)) },
          { key: "assignee", label: "Assignee", width: "120px", render: row => esc(row.assignee || "\u2014") },
          { key: "updatedAt", label: "Updated", width: "100px", align: "right", render: row => '<span class="text-xs text-muted">' + timeAgo(row.updatedAt) + "</span>" },
        ],
        workArticles,
      );
    }

    const temp = document.createElement("template");
    temp.innerHTML = [
      '<div class="page-header"><div><h1 class="page-title">Work</h1><p class="page-subtitle">Work articles across all phases.</p></div></div>',
      renderTabs(viewTabs, viewMode),
      '<div style="margin-top:16px">' + bodyHtml + "</div>",
    ].join("\n");
    return temp.content;
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
  }

  rerender();

  container.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { viewMode = tab.dataset.tab; expandedId = null; rerender(); return; }
    const workCard = e.target.closest("[data-work-id]");
    if (workCard) { expandedId = expandedId === workCard.dataset.workId ? null : workCard.dataset.workId; rerender(); }
  });
}
