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

// ─── Page lifecycle ─────────────────────────────────────────────────────────

let currentCleanup = null;
let navigationId = 0; // Incremented on each navigation to cancel stale loads

function teardownCurrentPage() {
  if (currentCleanup) {
    try { currentCleanup(); } catch (e) { console.error("Page cleanup error:", e); }
    currentCleanup = null;
  }
  content.textContent = "";
}

// ─── Route-to-module mapping ────────────────────────────────────────────────

async function loadPage(modulePath, params = {}) {
  const thisNavId = ++navigationId;
  teardownCurrentPage();

  const currentPath = window.location.pathname;
  updateSidebar(currentPath);

  const loadingDiv = document.createElement("div");
  loadingDiv.className = "loading";
  loadingDiv.textContent = "Loading...";
  content.appendChild(loadingDiv);

  try {
    const mod = await import(modulePath);
    // If another navigation happened while we were loading, abort
    if (thisNavId !== navigationId) return;
    content.textContent = "";
    const result = await mod.render(content, params);
    // Check again after async render
    if (thisNavId !== navigationId) return;
    // Store cleanup function if the page returned one
    currentCleanup = typeof result === "function" ? result : (result?.cleanup ?? null);
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [content] });
  } catch (err) {
    if (thisNavId !== navigationId) return;
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
  .add("/guide", () => loadPage("./pages/guide.js"))
  .add("/flow", () => loadPage("./pages/flow.js"))
  .add("/work", () => loadPage("./pages/work.js"))
  .add("/events", () => loadPage("./pages/events.js"))
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
    teardownCurrentPage();
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
