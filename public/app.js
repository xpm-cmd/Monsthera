// ─── Monsthera Dashboard SPA ────────────────────────────────────────────────
//
// Security note: innerHTML assignments in this file use either hardcoded
// static strings ("Loading...", "Page not found", "Failed to load page") or
// delegate to page modules that escape all API data via the esc() helper in
// components.js. No raw user input is interpolated into HTML.

import { router } from "./lib/router.js";
import { initSidebar, updateSidebar } from "./lib/sidebar.js";

// Restore persisted theme
const savedTheme = localStorage.getItem("monsthera-theme");
if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);

const content = document.getElementById("content");

// ─── Route-to-module mapping ────────────────────────────────────────────────

async function loadPage(modulePath, params = {}) {
  const currentPath = window.location.pathname;
  updateSidebar(currentPath);
  content.textContent = "";
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "loading";
  loadingDiv.textContent = "Loading...";
  content.appendChild(loadingDiv);
  try {
    const mod = await import(modulePath);
    content.textContent = "";
    await mod.render(content, params);
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [content] });
  } catch (err) {
    console.error("Page load error:", err);
    content.textContent = "";
    const errDiv = document.createElement("div");
    errDiv.className = "loading";
    errDiv.textContent = "Failed to load page";
    content.appendChild(errDiv);
  }
}

router
  .add("/", () => loadPage("./pages/overview.js"))
  .add("/flow", () => loadPage("./pages/flow.js"))
  .add("/work", () => loadPage("./pages/work.js"))
  .add("/knowledge", () => loadPage("./pages/knowledge.js"))
  .add("/knowledge/graph", () => loadPage("./pages/knowledge-graph.js"))
  .add("/search", () => loadPage("./pages/search.js"))
  .add("/system", () => loadPage("./pages/system/health.js"))
  .add("/system/models", () => loadPage("./pages/system/models.js"))
  .add("/system/agents", () => loadPage("./pages/system/agents.js"))
  .add("/system/integrations", () => loadPage("./pages/system/integrations.js"))
  .add("/system/storage", () => loadPage("./pages/system/storage.js"))
  .add("/security", () => loadPage("./pages/security.js"))
  .onNotFound(() => {
    content.textContent = "";
    const nf = document.createElement("div");
    nf.className = "loading";
    nf.textContent = "Page not found";
    content.appendChild(nf);
    updateSidebar(window.location.pathname);
  });

// ─── Intercept in-page link clicks ─────────────────────────────────────────

document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-link]");
  if (link && link.getAttribute("href")) {
    e.preventDefault();
    router.navigate(link.getAttribute("href"));
  }
});

// ─── Boot ───────────────────────────────────────────────────────────────────

initSidebar();
router.start();
