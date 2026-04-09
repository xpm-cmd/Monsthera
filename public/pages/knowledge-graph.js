// Knowledge Graph — Cytoscape.js loaded lazily from CDN.
// Template innerHTML uses only hardcoded UI strings and escaped data via esc().
import { getStructureGraph } from "../lib/api.js";
import { renderTabs, esc, renderBadge } from "../lib/components.js";

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

export async function render(container) {
  const [graph, cytoscape] = await Promise.all([
    getStructureGraph().catch(() => null),
    loadCytoscape(),
  ]);

  if (!graph) {
    container.innerHTML = '<div class="loading">Failed to load structure graph</div>';
    return;
  }

  let mode = "mixed";

  function buildElements() {
    const nodes = graph.nodes.map((node) => ({ data: { ...node, exists: node.exists === false ? 0 : 1 } }));
    const edges = graph.edges.map((edge) => ({ data: { ...edge } }));

    if (mode === "articles") {
      return {
        nodes: nodes.filter((node) => node.data.kind !== "code"),
        edges: edges.filter((edge) => {
          const sourceIsCode = String(edge.data.source).startsWith("c:");
          const targetIsCode = String(edge.data.target).startsWith("c:");
          return !sourceIsCode && !targetIsCode;
        }),
      };
    }

    if (mode === "code") {
      return {
        nodes: nodes.filter((node) => node.data.kind === "code"),
        edges: [],
      };
    }

    return { nodes, edges };
  }

  const shell = document.createElement("template");
  shell.innerHTML = '<div style="display:flex;flex-direction:column;height:calc(100vh - 56px)">'
    + '<div class="graph-controls"><h2 style="font-size:16px;font-weight:600;margin-right:auto">Knowledge Graph</h2>'
    + renderTabs([{ id: "articles", label: "Articles" }, { id: "mixed", label: "Mixed" }, { id: "code", label: "Code" }], mode)
    + '<div class="flex gap-4" style="margin-left:12px">'
    + '<button class="btn btn--outline btn--sm" id="zoom-out"><i data-lucide="minus" style="width:14px;height:14px"></i></button>'
    + '<button class="btn btn--outline btn--sm" id="zoom-fit">Fit</button>'
    + '<button class="btn btn--outline btn--sm" id="zoom-in"><i data-lucide="plus" style="width:14px;height:14px"></i></button></div></div>'
    + '<div style="flex:1;position:relative"><div id="cy" style="width:100%;height:100%;background:var(--tile)"></div>'
    + '<div class="graph-legend">'
    + `<div class="text-xs text-muted" style="margin-bottom:8px">${esc(String(graph.summary.knowledgeCount))} knowledge · ${esc(String(graph.summary.workCount))} work · ${esc(String(graph.summary.codeCount))} code</div>`
    + '<div class="graph-legend-item"><div class="graph-legend-dot" style="border-color:var(--primary)"></div> Knowledge</div>'
    + '<div class="graph-legend-item"><div class="graph-legend-dot" style="border-color:var(--color-success-fg)"></div> Work</div>'
    + '<div class="graph-legend-item"><div class="graph-legend-dot" style="border-color:#6BA3E8"></div> Code</div>'
    + `<div class="text-xs text-muted mt-8">Missing refs: ${esc(String(graph.summary.missingReferenceCount))} · Missing deps: ${esc(String(graph.summary.missingDependencyCount))} · Missing code: ${esc(String(graph.summary.missingCodeRefCount))}</div>`
    + '</div>'
    + '<div class="graph-drawer" id="graph-drawer"><div class="graph-drawer-header">'
    + '<h3 id="drawer-title" style="font-size:16px;font-weight:600"></h3>'
    + '<button class="graph-drawer-close" id="close-drawer"><i data-lucide="x" style="width:16px;height:16px"></i></button></div>'
    + '<div id="drawer-body"></div></div></div></div>';
  container.appendChild(shell.content);
  if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });

  const elements = buildElements();
  const cy = cytoscape({
    container: container.querySelector("#cy"),
    elements: [...elements.nodes, ...elements.edges],
    style: [
      { selector: "node[kind='knowledge']", style: { "background-color": "#1A182E", "border-color": "#A89BFF", "border-width": 2, label: "data(label)", "font-size": "11px", color: "#F1F0F7", "text-valign": "center", "text-halign": "center", shape: "roundrectangle", width: "label", height: 30, padding: "8px" } },
      { selector: "node[kind='work']", style: { "background-color": "#1A182E", "border-color": "#A1E5A1", "border-width": 2, label: "data(label)", "font-size": "11px", color: "#F1F0F7", "text-valign": "center", "text-halign": "center", shape: "roundrectangle", width: "label", height: 30, padding: "8px" } },
      { selector: "node[kind='code'][exists = 1]", style: { "background-color": "#1A182E", "border-color": "#6BA3E8", "border-width": 2, label: "data(label)", "font-size": "10px", "font-family": "monospace", color: "#F1F0F7", "text-valign": "center", "text-halign": "center", shape: "rectangle", width: "label", height: 26, padding: "6px" } },
      { selector: "node[kind='code'][exists = 0]", style: { "background-color": "#2A1720", "border-color": "#E88484", "border-width": 2, label: "data(label)", "font-size": "10px", "font-family": "monospace", color: "#F8E9E9", "text-valign": "center", "text-halign": "center", shape: "rectangle", width: "label", height: 26, padding: "6px" } },
      { selector: "edge[kind='dependency']", style: { "line-color": "#A1E5A1", width: 1.3, "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": "#A1E5A1", "arrow-scale": 0.6 } },
      { selector: "edge[kind='reference']", style: { "line-color": "#A89BFF", width: 1.2, "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": "#A89BFF", "arrow-scale": 0.6 } },
      { selector: "edge[kind='code_ref']", style: { "line-color": "#6BA3E8", width: 1, "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": "#6BA3E8", "arrow-scale": 0.6 } },
      { selector: "edge[kind='shared_tag']", style: { "line-color": "#B9935A", width: 0.8, "curve-style": "bezier", "line-style": "dashed", opacity: 0.75 } },
      { selector: ":selected", style: { "border-color": "#F3F1FF", "border-width": 3 } },
    ],
    layout: { name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 120 },
    minZoom: 0.2,
    maxZoom: 3,
  });

  cy.on("tap", "node", (event) => {
    const data = event.target.data();
    const drawer = container.querySelector("#graph-drawer");
    const title = container.querySelector("#drawer-title");
    const body = container.querySelector("#drawer-body");
    if (!drawer || !title || !body) return;

    drawer.classList.add("open");
    title.textContent = data.label;
    body.textContent = "";

    const meta = document.createElement("div");
    meta.className = "flex gap-8";
    meta.innerHTML = [
      badgeForKind(data.kind, data.kind),
      badgeForKind(data.kind, data.phase || data.category || data.template),
      data.priority ? renderBadge(data.priority, "outline") : "",
      data.exists === false ? renderBadge("missing", "error") : "",
    ].join("");
    body.appendChild(meta);

    if (data.preview) {
      const preview = document.createElement("p");
      preview.className = "text-sm text-muted mt-8";
      preview.textContent = data.preview;
      body.appendChild(preview);
    }

    if (data.path) {
      const codePath = document.createElement("p");
      codePath.className = "mono text-sm mt-8";
      codePath.textContent = data.path;
      body.appendChild(codePath);
    }

    if (Array.isArray(data.tags) && data.tags.length > 0) {
      const tagLine = document.createElement("p");
      tagLine.className = "text-xs text-muted mt-8";
      tagLine.textContent = `Tags: ${data.tags.join(", ")}`;
      body.appendChild(tagLine);
    }
  });

  const ac = new AbortController();
  container.querySelector("#close-drawer")?.addEventListener("click", () => container.querySelector("#graph-drawer")?.classList.remove("open"), { signal: ac.signal });
  container.querySelector("#zoom-in")?.addEventListener("click", () => cy.zoom(cy.zoom() * 1.2), { signal: ac.signal });
  container.querySelector("#zoom-out")?.addEventListener("click", () => cy.zoom(cy.zoom() / 1.2), { signal: ac.signal });
  container.querySelector("#zoom-fit")?.addEventListener("click", () => cy.fit(), { signal: ac.signal });

  container.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab && ["articles", "mixed", "code"].includes(tab.dataset.tab)) {
      mode = tab.dataset.tab;
      const next = buildElements();
      cy.elements().remove();
      cy.add([...next.nodes, ...next.edges]);
      cy.layout({ name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 120 }).run();
      container.querySelectorAll("[data-tab]").forEach((node) => node.classList.toggle("active", node.dataset.tab === mode));
    }
  }, { signal: ac.signal });

  return { cleanup: () => { ac.abort(); cy.destroy(); } };
}
