// Knowledge Graph — Cytoscape.js loaded lazily from CDN.
// Template innerHTML uses only hardcoded UI strings and escaped data via esc().
import { getStructureGraph } from "../lib/api.js";
import { renderTabs, esc, renderBadge, renderSearchInput } from "../lib/components.js";

function loadCytoscape() {
  return new Promise((resolve, reject) => {
    if (window.cytoscape) { resolve(window.cytoscape); return; }
    const script = document.createElement("script");
    script.src = "https://unpkg.com/cytoscape@3/dist/cytoscape.min.js";
    script.onload = () => resolve(window.cytoscape);
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function badgeForKind(kind, value) {
  if (!value) return "";
  const variant = kind === "knowledge" ? "primary"
    : kind === "work" ? "success"
    : kind === "code" ? "secondary"
    : "outline";
  return renderBadge(value, variant);
}

function truncateLabel(label, limit = 42) {
  if (!label) return "";
  if (label.length <= limit) return label;
  return `${label.slice(0, limit - 1)}…`;
}

function readPalette() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  return {
    foreground: read("--foreground", "#EDF5EF"),
    muted: read("--muted-foreground", "#9CAF9F"),
    border: read("--border", "#26382D"),
    card: read("--card", "rgba(20, 31, 24, 0.88)"),
    knowledgeBorder: "#A89BFF",
    workBorder: read("--color-success-fg", "#A9E4BF"),
    codeBorder: "#6BA3E8",
    codeMissingBorder: "#E88484",
    knowledgeFill: "#1D1A35",
    workFill: "#132A1B",
    codeFill: "#162436",
    codeMissingFill: "#2A1720",
    tagLine: "#B9935A",
  };
}

export async function render(container) {
  const [graph, cytoscape] = await Promise.all([
    getStructureGraph().catch(() => null),
    loadCytoscape(),
  ]);

  if (!graph) {
    container.innerHTML = '<div class="loading">Failed to load structure graph</div>';
    return;
  }

  const palette = readPalette();
  const allNodes = graph.nodes.map((node) => ({
    data: {
      ...node,
      exists: node.exists === false ? 0 : 1,
      shortLabel: truncateLabel(node.label, node.kind === "code" ? 28 : 38),
      searchText: [
        node.label,
        node.path,
        node.slug,
        node.articleId,
        ...(node.tags ?? []),
      ].filter(Boolean).join(" ").toLowerCase(),
    },
  }));
  const allEdges = graph.edges.map((edge) => ({ data: { ...edge } }));
  const nodeById = new Map(allNodes.map((node) => [node.data.id, node]));
  const countsByKind = {
    knowledge: graph.summary.knowledgeCount,
    work: graph.summary.workCount,
    code: graph.summary.codeCount,
  };
  const presetKinds = {
    articles: new Set(["knowledge", "work"]),
    mixed: new Set(["knowledge", "work", "code"]),
    code: new Set(["code"]),
  };

  let preset = "articles";
  let visibleKinds = new Set(presetKinds[preset]);
  let showSharedTags = false;
  let showLabels = false;
  let focusNodeId = null;

  function buildElements() {
    const nodes = allNodes.filter((node) => visibleKinds.has(node.data.kind));
    const visibleNodeIds = new Set(nodes.map((node) => node.data.id));
    const edges = allEdges.filter((edge) => {
      if (!visibleNodeIds.has(edge.data.source) || !visibleNodeIds.has(edge.data.target)) return false;
      if (!showSharedTags && edge.data.kind === "shared_tag") return false;
      return true;
    });
    return { nodes, edges };
  }

  function renderSummaryCard(label, value, tone) {
    return `
      <div class="graph-summary-card">
        <div class="graph-summary-label">${esc(label)}</div>
        <div class="graph-summary-value">${esc(String(value))}</div>
        <div class="graph-summary-tone graph-summary-tone--${esc(tone)}"></div>
      </div>`;
  }

  const shell = document.createElement("template");
  shell.innerHTML = '<div class="graph-shell">'
    + '<aside class="graph-sidebar">'
    + '<section class="graph-panel">'
    + '<div class="page-kicker">Structure map</div>'
    + '<div class="graph-panel-heading">Read the system without the clutter</div>'
    + '<p class="text-sm text-muted">Start with articles, search for a node, then click it to isolate its immediate neighborhood. Drag nodes to tidy the canvas manually whenever the layout gets noisy.</p>'
    + '<div class="graph-summary-grid">'
    + renderSummaryCard("Knowledge", graph.summary.knowledgeCount, "knowledge")
    + renderSummaryCard("Work", graph.summary.workCount, "work")
    + renderSummaryCard("Code", graph.summary.codeCount, "code")
    + renderSummaryCard("Gaps", graph.summary.missingReferenceCount + graph.summary.missingDependencyCount + graph.summary.missingCodeRefCount, "warning")
    + '</div>'
    + `<div class="graph-status">Missing refs: ${esc(String(graph.summary.missingReferenceCount))} · Missing deps: ${esc(String(graph.summary.missingDependencyCount))} · Missing code: ${esc(String(graph.summary.missingCodeRefCount))}</div>`
    + '</section>'
    + '<section class="graph-panel">'
    + '<div class="graph-panel-heading graph-panel-heading--sm">Find and filter</div>'
    + renderSearchInput("Find article, work item, or file...")
    + '<datalist id="graph-node-options"></datalist>'
    + '<div class="form-actions">'
    + '<button class="btn btn--primary btn--sm" id="graph-find">Focus</button>'
    + '<button class="btn btn--outline btn--sm" id="graph-clear-focus">Clear focus</button>'
    + '</div>'
    + '<div class="graph-panel-subtitle">Presets</div>'
    + renderTabs([{ id: "articles", label: "Articles" }, { id: "mixed", label: "Mixed" }, { id: "code", label: "Code" }], preset)
    + '<div class="graph-panel-subtitle">Node types</div>'
    + '<div class="graph-chip-row">'
    + `<button class="graph-filter-chip active" type="button" data-kind-filter="knowledge">Knowledge <span>${esc(String(countsByKind.knowledge))}</span></button>`
    + `<button class="graph-filter-chip active" type="button" data-kind-filter="work">Work <span>${esc(String(countsByKind.work))}</span></button>`
    + `<button class="graph-filter-chip" type="button" data-kind-filter="code">Code <span>${esc(String(countsByKind.code))}</span></button>`
    + '</div>'
    + '<div class="graph-toggle-stack">'
    + '<label class="checkbox"><input type="checkbox" id="toggle-labels"> Show labels on visible nodes</label>'
    + '<label class="checkbox"><input type="checkbox" id="toggle-shared-tags"> Show shared-tag links</label>'
    + '</div>'
    + '<div class="graph-status" id="graph-status">Showing the full visible map. Click any node to focus nearby relationships only.</div>'
    + '</section>'
    + '<section class="graph-panel graph-panel--detail">'
    + '<div class="graph-panel-heading graph-panel-heading--sm">Node detail</div>'
    + '<div id="graph-detail-body" class="graph-detail-empty">Select a node to inspect its metadata, preview, path, tags, and direct connections.</div>'
    + '</section>'
    + '</aside>'
    + '<section class="graph-stage">'
    + '<div class="graph-controls">'
    + '<div class="graph-toolbar__left">'
    + '<h2 style="font-size:16px;font-weight:600">Knowledge Graph</h2>'
    + '<span class="badge badge--outline" id="graph-visible-summary"></span>'
    + '</div>'
    + '<div class="graph-toolbar__actions">'
    + '<button class="btn btn--outline btn--sm" id="zoom-out">-</button>'
    + '<button class="btn btn--outline btn--sm" id="zoom-fit">Fit</button>'
    + '<button class="btn btn--outline btn--sm" id="graph-organize">Organize</button>'
    + '<button class="btn btn--outline btn--sm" id="zoom-in">+</button>'
    + '</div>'
    + '</div>'
    + '<div class="graph-container"><div id="cy" class="graph-canvas"></div>'
    + '<div class="graph-floating-note" id="graph-floating-note">Drag nodes to declutter. Use search or click a node to isolate a smaller neighborhood.</div>'
    + '</div>'
    + '</section>'
    + '</div>';
  container.appendChild(shell.content);
  if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });

  const searchInput = container.querySelector(".search-input");
  const datalist = container.querySelector("#graph-node-options");
  if (searchInput && datalist) {
    searchInput.setAttribute("list", "graph-node-options");
    datalist.innerHTML = allNodes
      .slice()
      .sort((left, right) => left.data.label.localeCompare(right.data.label))
      .map((node) => `<option value="${esc(node.data.label)}">${esc(node.data.path || node.data.shortLabel)}</option>`)
      .join("");
  }

  const elements = buildElements();
  const cy = cytoscape({
    container: container.querySelector("#cy"),
    elements: [...elements.nodes, ...elements.edges],
    style: [
      { selector: "node", style: {
        label: "",
        color: palette.foreground,
        "font-size": "11px",
        "text-wrap": "wrap",
        "text-max-width": "200px",
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": -12,
        "overlay-opacity": 0,
      } },
      { selector: "node[kind='knowledge']", style: { "background-color": palette.knowledgeFill, "border-color": palette.knowledgeBorder, "border-width": 2, shape: "ellipse", width: 20, height: 20 } },
      { selector: "node[kind='work']", style: { "background-color": palette.workFill, "border-color": palette.workBorder, "border-width": 2, shape: "roundrectangle", width: 20, height: 20 } },
      { selector: "node[kind='code'][exists = 1]", style: { "background-color": palette.codeFill, "border-color": palette.codeBorder, "border-width": 2, shape: "rectangle", width: 18, height: 18 } },
      { selector: "node[kind='code'][exists = 0]", style: { "background-color": palette.codeMissingFill, "border-color": palette.codeMissingBorder, "border-width": 2, shape: "rectangle", width: 18, height: 18 } },
      { selector: "node.show-label", style: {
        label: "data(shortLabel)",
        "text-background-color": palette.card,
        "text-background-opacity": 0.94,
        "text-background-padding": "4px",
        "text-background-shape": "roundrectangle",
      } },
      { selector: "node.is-focused", style: { width: 26, height: 26, "border-width": 3, "border-color": palette.foreground } },
      { selector: "node.is-neighbor", style: { width: 22, height: 22 } },
      { selector: "node.is-dim", style: { opacity: 0.12 } },
      { selector: "node:grabbed", style: { width: 26, height: 26, "border-width": 3, "border-color": palette.foreground } },
      { selector: "edge", style: {
        opacity: 0.45,
        width: 1.1,
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.55,
      } },
      { selector: "edge[kind='dependency']", style: { "line-color": palette.workBorder, "target-arrow-color": palette.workBorder } },
      { selector: "edge[kind='reference']", style: { "line-color": palette.knowledgeBorder, "target-arrow-color": palette.knowledgeBorder } },
      { selector: "edge[kind='code_ref']", style: { "line-color": palette.codeBorder, "target-arrow-color": palette.codeBorder } },
      { selector: "edge[kind='shared_tag']", style: { "line-color": palette.tagLine, "target-arrow-shape": "none", "line-style": "dashed", opacity: 0.28 } },
      { selector: "edge.is-active", style: { opacity: 0.9, width: 2 } },
      { selector: "edge.is-dim", style: { opacity: 0.05 } },
      { selector: ":selected", style: { "border-color": palette.foreground, "border-width": 3 } },
    ],
    layout: {
      name: "cose",
      animate: false,
      nodeRepulsion: 180000,
      idealEdgeLength: 180,
      edgeElasticity: 80,
      gravity: 0.45,
      componentSpacing: 140,
      padding: 100,
    },
    autoungrabify: false,
    autounselectify: false,
    wheelSensitivity: 0.18,
    minZoom: 0.2,
    maxZoom: 3.5,
  });

  const ac = new AbortController();
  const graphCanvas = container.querySelector("#cy");
  const detailBody = container.querySelector("#graph-detail-body");
  const visibleSummary = container.querySelector("#graph-visible-summary");
  const floatingNote = container.querySelector("#graph-floating-note");
  const status = container.querySelector("#graph-status");
  const toggleLabels = container.querySelector("#toggle-labels");
  const toggleSharedTags = container.querySelector("#toggle-shared-tags");

  function syncPresetTabs() {
    container.querySelectorAll("[data-tab]").forEach((node) => {
      node.classList.toggle("active", node.dataset.tab === preset);
    });
  }

  function syncKindFilters() {
    container.querySelectorAll("[data-kind-filter]").forEach((node) => {
      node.classList.toggle("active", visibleKinds.has(node.dataset.kindFilter));
    });
  }

  function updateStatus() {
    if (!visibleSummary || !floatingNote || !status) return;
    const totalNodes = cy.nodes().length;
    const totalEdges = cy.edges().length;
    visibleSummary.textContent = `${totalNodes} nodes · ${totalEdges} links`;

    if (focusNodeId) {
      const focusedNode = cy.getElementById(focusNodeId);
      if (focusedNode.length > 0) {
        const neighborhood = focusedNode.closedNeighborhood();
        const relatedNodes = Math.max(neighborhood.nodes().length - 1, 0);
        const relatedEdges = neighborhood.edges().length;
        const label = focusedNode.data("label") || focusedNode.data("shortLabel");
        status.innerHTML = `${renderBadge("Focus mode", "primary")} ${esc(label)} · ${esc(String(relatedNodes))} nearby nodes · ${esc(String(relatedEdges))} links`;
        floatingNote.textContent = `Focused on ${label}. Click the canvas background to go back to the broader map.`;
        return;
      }
    }

    status.textContent = "Showing the full visible map. Click any node to focus nearby relationships only.";
    floatingNote.textContent = `Showing ${totalNodes} nodes and ${totalEdges} links. Drag nodes to declutter, or use search to jump straight to a specific item.`;
  }

  function renderEmptyDetail() {
    if (!detailBody) return;
    detailBody.innerHTML = '<div class="graph-detail-empty">Select a node to inspect its metadata, preview, path, tags, and direct connections.</div>';
  }

  function renderDetail(node) {
    if (!detailBody) return;
    if (!node || node.length === 0) {
      renderEmptyDetail();
      return;
    }

    const data = node.data();
    const connectionCount = node.connectedEdges().length;
    detailBody.innerHTML = ''
      + '<div class="flex gap-8">'
      + [
        badgeForKind(data.kind, data.kind),
        badgeForKind(data.kind, data.phase || data.category || data.template),
        data.priority ? renderBadge(data.priority, "outline") : "",
        data.exists === 0 ? renderBadge("missing", "error") : "",
      ].join("")
      + '</div>'
      + `<div class="graph-detail-title">${esc(data.label)}</div>`
      + `<div class="graph-detail-row"><span>Direct connections</span><strong>${esc(String(connectionCount))}</strong></div>`
      + (data.preview ? `<p class="text-sm text-muted">${esc(data.preview)}</p>` : "")
      + (data.path ? `<p class="mono text-sm">${esc(data.path)}</p>` : "")
      + (Array.isArray(data.tags) && data.tags.length > 0
        ? `<p class="text-xs text-muted">Tags: ${esc(data.tags.join(", "))}</p>`
        : "");
  }

  function runLayout(onDone) {
    if (cy.nodes().length === 0) {
      if (typeof onDone === "function") onDone();
      return;
    }
    if (typeof onDone === "function") {
      cy.one("layoutstop", onDone);
    }
    cy.layout({
      name: "cose",
      animate: false,
      nodeRepulsion: 180000,
      idealEdgeLength: 180,
      edgeElasticity: 80,
      gravity: 0.45,
      componentSpacing: 140,
      padding: 100,
    }).run();
  }

  function applyViewState({ fit = false } = {}) {
    cy.nodes().removeClass("show-label is-focused is-neighbor is-dim");
    cy.edges().removeClass("is-active is-dim");

    if (focusNodeId) {
      const focusedNode = cy.getElementById(focusNodeId);
      if (focusedNode.length > 0) {
        const neighborhood = focusedNode.closedNeighborhood();
        const neighborhoodNodes = neighborhood.nodes();
        const neighborhoodEdges = neighborhood.edges();
        cy.nodes().not(neighborhoodNodes).addClass("is-dim");
        cy.edges().not(neighborhoodEdges).addClass("is-dim");
        focusedNode.addClass("is-focused");
        neighborhoodNodes.not(focusedNode).addClass("is-neighbor");
        neighborhoodEdges.addClass("is-active");
        if (showLabels) {
          cy.nodes().addClass("show-label");
        } else {
          neighborhoodNodes.addClass("show-label");
        }
        if (fit) cy.fit(neighborhood, 120);
        renderDetail(focusedNode);
        updateStatus();
        return;
      }
      focusNodeId = null;
    }

    if (showLabels) {
      cy.nodes().addClass("show-label");
    }
    if (fit) cy.fit(cy.elements(), 90);
    renderEmptyDetail();
    updateStatus();
  }

  function refreshGraph({ fit = true } = {}) {
    const next = buildElements();
    cy.elements().remove();
    cy.add([...next.nodes, ...next.edges]);
    if (focusNodeId && cy.getElementById(focusNodeId).length === 0) {
      focusNodeId = null;
    }
    syncPresetTabs();
    syncKindFilters();
    if (toggleLabels) toggleLabels.checked = showLabels;
    if (toggleSharedTags) toggleSharedTags.checked = showSharedTags;
    runLayout(() => applyViewState({ fit }));
  }

  function setPreset(nextPreset) {
    preset = nextPreset;
    visibleKinds = new Set(presetKinds[nextPreset]);
    refreshGraph();
  }

  function toggleKind(kind) {
    if (visibleKinds.has(kind) && visibleKinds.size === 1) return;
    if (visibleKinds.has(kind)) visibleKinds.delete(kind);
    else visibleKinds.add(kind);
    preset = null;
    refreshGraph();
  }

  function focusNode(nodeId, { fit = true } = {}) {
    const entry = nodeById.get(nodeId);
    if (!entry) return;
    if (!visibleKinds.has(entry.data.kind)) {
      visibleKinds.add(entry.data.kind);
      preset = null;
      focusNodeId = nodeId;
      refreshGraph({ fit });
      return;
    }
    focusNodeId = nodeId;
    const node = cy.getElementById(nodeId);
    if (node.length > 0) {
      node.select();
      applyViewState({ fit });
    }
  }

  function findBestMatch(query) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;

    const matches = allNodes
      .map((node) => {
        const label = node.data.label.toLowerCase();
        const path = (node.data.path || "").toLowerCase();
        let score = 999;
        if (label === normalized || path === normalized) score = 0;
        else if (label.startsWith(normalized)) score = 1;
        else if (label.includes(normalized)) score = 2;
        else if (path.includes(normalized)) score = 3;
        else if (node.data.searchText.includes(normalized)) score = 4;
        return { node, score };
      })
      .filter((entry) => entry.score < 999)
      .sort((left, right) => left.score - right.score || left.node.data.label.length - right.node.data.label.length);

    return matches[0]?.node?.data?.id || null;
  }

  cy.on("tap", "node", (event) => {
    focusNode(event.target.id(), { fit: true });
  });

  cy.on("tap", (event) => {
    if (event.target !== cy) return;
    focusNodeId = null;
    cy.elements().unselect();
    applyViewState({ fit: false });
  });

  cy.on("grab", "node", () => {
    graphCanvas?.classList.add("is-grabbing");
  });

  cy.on("free", "node", () => {
    graphCanvas?.classList.remove("is-grabbing");
    updateStatus();
  });

  container.querySelector("#zoom-in")?.addEventListener("click", () => {
    cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }, { signal: ac.signal });
  container.querySelector("#zoom-out")?.addEventListener("click", () => {
    cy.zoom({ level: cy.zoom() / 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }, { signal: ac.signal });
  container.querySelector("#zoom-fit")?.addEventListener("click", () => applyViewState({ fit: true }), { signal: ac.signal });
  container.querySelector("#graph-organize")?.addEventListener("click", () => runLayout(() => applyViewState({ fit: true })), { signal: ac.signal });
  container.querySelector("#graph-clear-focus")?.addEventListener("click", () => {
    focusNodeId = null;
    cy.elements().unselect();
    applyViewState({ fit: true });
  }, { signal: ac.signal });
  container.querySelector("#graph-find")?.addEventListener("click", () => {
    const matchId = findBestMatch(searchInput?.value || "");
    if (matchId) focusNode(matchId, { fit: true });
  }, { signal: ac.signal });
  searchInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const matchId = findBestMatch(searchInput.value || "");
    if (matchId) focusNode(matchId, { fit: true });
  }, { signal: ac.signal });
  toggleLabels?.addEventListener("change", () => {
    showLabels = Boolean(toggleLabels.checked);
    applyViewState({ fit: false });
  }, { signal: ac.signal });
  toggleSharedTags?.addEventListener("change", () => {
    showSharedTags = Boolean(toggleSharedTags.checked);
    refreshGraph({ fit: Boolean(focusNodeId) });
  }, { signal: ac.signal });

  container.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab && ["articles", "mixed", "code"].includes(tab.dataset.tab)) {
      setPreset(tab.dataset.tab);
      return;
    }

    const kindButton = event.target.closest("[data-kind-filter]");
    if (kindButton) {
      toggleKind(kindButton.dataset.kindFilter);
    }
  }, { signal: ac.signal });

  syncPresetTabs();
  syncKindFilters();
  if (toggleLabels) toggleLabels.checked = showLabels;
  if (toggleSharedTags) toggleSharedTags.checked = showSharedTags;
  renderEmptyDetail();
  updateStatus();
  runLayout(() => applyViewState({ fit: true }));

  return { cleanup: () => { ac.abort(); cy.destroy(); } };
}
