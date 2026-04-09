// Knowledge Graph — Cytoscape.js loaded lazily from CDN.
// Template innerHTML uses only hardcoded UI strings and escaped data via esc().
import { getKnowledge, getWork } from "../lib/api.js";
import { renderTabs, esc } from "../lib/components.js";

function loadCytoscape() {
  return new Promise((resolve, reject) => {
    if (window.cytoscape) { resolve(window.cytoscape); return; }
    const s = document.createElement("script");
    s.src = "https://unpkg.com/cytoscape@3/dist/cytoscape.min.js";
    s.onload = () => resolve(window.cytoscape);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

export async function render(container) {
  const [knowledgeArticles, workArticles, cytoscape] = await Promise.all([
    getKnowledge().catch(() => []),
    getWork().catch(() => []),
    loadCytoscape(),
  ]);

  let mode = "mixed";

  function buildElements() {
    const nodes = [];
    const edges = [];
    const codeFiles = new Set();

    for (const a of knowledgeArticles) {
      nodes.push({ data: { id: "k-" + a.id, label: a.title, type: "knowledge", article: a } });
      for (const ref of a.codeRefs || []) { codeFiles.add(ref); edges.push({ data: { source: "k-" + a.id, target: "c-" + ref } }); }
    }
    for (const w of workArticles) {
      nodes.push({ data: { id: "w-" + w.id, label: w.title, type: "work", article: w } });
      for (const ref of w.codeRefs || []) { codeFiles.add(ref); edges.push({ data: { source: "w-" + w.id, target: "c-" + ref } }); }
      for (const dep of w.dependencies || []) edges.push({ data: { source: "w-" + w.id, target: "w-" + dep } });
      for (const ref of w.references || []) {
        const k = knowledgeArticles.find(a => a.id === ref || a.slug === ref);
        if (k) edges.push({ data: { source: "w-" + w.id, target: "k-" + k.id } });
      }
    }
    for (const file of codeFiles) nodes.push({ data: { id: "c-" + file, label: file.split("/").pop(), type: "code", path: file } });

    if (mode === "articles") return { nodes: nodes.filter(n => n.data.type !== "code"), edges: edges.filter(e => !e.data.target.startsWith("c-") && !e.data.source.startsWith("c-")) };
    if (mode === "code") return { nodes: nodes.filter(n => n.data.type === "code"), edges: [] };
    return { nodes, edges };
  }

  // Hardcoded UI shell — no user input
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
    + '<div class="graph-legend-item"><div class="graph-legend-dot" style="border-color:var(--primary)"></div> Knowledge</div>'
    + '<div class="graph-legend-item"><div class="graph-legend-dot" style="border-color:var(--color-success-fg)"></div> Work</div>'
    + '<div class="graph-legend-item"><div class="graph-legend-dot" style="border-color:#6BA3E8"></div> Code</div></div>'
    + '<div class="graph-drawer" id="graph-drawer"><div class="graph-drawer-header">'
    + '<h3 id="drawer-title" style="font-size:16px;font-weight:600"></h3>'
    + '<button class="graph-drawer-close" id="close-drawer"><i data-lucide="x" style="width:16px;height:16px"></i></button></div>'
    + '<div id="drawer-body"></div></div></div></div>';
  container.appendChild(shell.content);
  if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });

  const elements = buildElements();
  const cy = cytoscape({
    container: document.getElementById("cy"),
    elements: [...elements.nodes, ...elements.edges],
    style: [
      { selector: "node[type='knowledge']", style: { "background-color": "#1A182E", "border-color": "#A89BFF", "border-width": 2, label: "data(label)", "font-size": "11px", color: "#F1F0F7", "text-valign": "center", "text-halign": "center", shape: "roundrectangle", width: "label", height: 30, padding: "8px" } },
      { selector: "node[type='work']", style: { "background-color": "#1A182E", "border-color": "#A1E5A1", "border-width": 2, label: "data(label)", "font-size": "11px", color: "#F1F0F7", "text-valign": "center", "text-halign": "center", shape: "roundrectangle", width: "label", height: 30, padding: "8px" } },
      { selector: "node[type='code']", style: { "background-color": "#1A182E", "border-color": "#6BA3E8", "border-width": 2, label: "data(label)", "font-size": "10px", "font-family": "monospace", color: "#F1F0F7", "text-valign": "center", "text-halign": "center", shape: "rectangle", width: "label", height: 26, padding: "6px" } },
      { selector: "edge", style: { "line-color": "#2B283D", width: 1, "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": "#2B283D", "arrow-scale": 0.6 } },
      { selector: ":selected", style: { "border-color": "#A89BFF", "border-width": 3 } },
    ],
    layout: { name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 120 },
    minZoom: 0.2, maxZoom: 3,
  });

  cy.on("tap", "node", (evt) => {
    const data = evt.target.data();
    const drawer = document.getElementById("graph-drawer");
    const title = document.getElementById("drawer-title");
    const body = document.getElementById("drawer-body");
    drawer.classList.add("open");
    title.textContent = data.label;
    body.textContent = "";
    if (data.article) {
      const p = document.createElement("p");
      p.className = "text-sm text-muted";
      p.textContent = (data.article.content || "").slice(0, 300);
      body.appendChild(p);
    } else if (data.path) {
      const p = document.createElement("p");
      p.className = "mono text-sm";
      p.textContent = data.path;
      body.appendChild(p);
    }
  });

  document.getElementById("close-drawer")?.addEventListener("click", () => document.getElementById("graph-drawer")?.classList.remove("open"));
  document.getElementById("zoom-in")?.addEventListener("click", () => cy.zoom(cy.zoom() * 1.2));
  document.getElementById("zoom-out")?.addEventListener("click", () => cy.zoom(cy.zoom() / 1.2));
  document.getElementById("zoom-fit")?.addEventListener("click", () => cy.fit());

  container.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab && ["articles", "mixed", "code"].includes(tab.dataset.tab)) {
      mode = tab.dataset.tab;
      const el = buildElements();
      cy.elements().remove();
      cy.add([...el.nodes, ...el.edges]);
      cy.layout({ name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 120 }).run();
      container.querySelectorAll("[data-tab]").forEach(t => t.classList.toggle("active", t.dataset.tab === mode));
    }
  });
}
