// Models & Runtime — placeholder (no API data). Template for safe DOM.
import { renderCard } from "../../lib/components.js";

export async function render(container) {
  const temp = document.createElement("template");
  temp.innerHTML = [
    '<div class="page-header"><div><h1 class="page-title">Models &amp; Runtime</h1>',
    '<p class="page-subtitle">Provider, model, and routing configuration.</p></div></div>',
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">',
    renderCard("Provider", '<p class="text-sm text-muted">Configuration not exposed via dashboard API.</p>'),
    renderCard("Primary model", '<p class="text-sm text-muted">Configuration not exposed via dashboard API.</p>'),
    renderCard("Routing policy", '<p class="text-sm text-muted">Configuration not exposed via dashboard API.</p>'),
    "</div>",
  ].join("\n");
  container.appendChild(temp.content);
}
