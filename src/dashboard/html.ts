import { VERSION } from "../core/constants.js";
import { MAX_TICKET_LONG_TEXT_LENGTH } from "../core/input-hardening.js";

export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monsthera Command Center</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0C0C0C;--surface:#111111;--surface-hover:#1a1a1a;--sidebar:#080808;--border:#2f2f2f;
  --text:#ffffff;--text2:#8a8a8a;--text3:#6a6a6a;
  --accent:#00FF88;--blue:#4488FF;--green:#00FF88;--orange:#FF8800;--red:#FF4444;--purple:#8844FF;--cyan:#06b6d4;
  --radius:8px;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'JetBrains Mono',monospace;background:var(--bg);color:var(--text);min-height:100vh;display:flex}
code,pre,.mono{font-family:'JetBrains Mono',monospace}

/* ── App Layout: Sidebar + Main ─────────────── */
.app-layout{display:flex;min-height:100vh;width:100%}
.sidebar{width:240px;min-width:240px;background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:10}
.sidebar-header{padding:1.25rem 1rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.65rem}
.sidebar-logo{font-size:1rem;font-weight:700;color:var(--accent);letter-spacing:.05em}
.sidebar-version{font-size:.6rem;color:var(--text3);background:rgba(255,255,255,.05);padding:2px 6px;border-radius:4px}
.sidebar-pulse{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:pulse 2s infinite;margin-left:auto}
.sidebar-pulse.disconnected{background:var(--red);box-shadow:0 0 6px var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

.sidebar-nav{flex:1;padding:.75rem 0;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:.65rem;padding:.65rem 1rem;color:var(--text2);cursor:pointer;font-size:.72rem;font-weight:500;letter-spacing:.04em;text-transform:uppercase;transition:all .15s;border-left:2px solid transparent}
.nav-item:hover{color:var(--text);background:rgba(255,255,255,.03)}
.nav-item.active{color:var(--accent);border-left-color:var(--accent);background:rgba(0,255,136,.05)}
.nav-item svg{width:16px;height:16px;opacity:.6;flex-shrink:0}
.nav-item.active svg{opacity:1}
.nav-item .nav-count{margin-left:auto;font-size:.6rem;color:var(--text3);background:rgba(255,255,255,.05);padding:1px 5px;border-radius:4px}
.nav-item.active .nav-count{color:var(--accent);background:rgba(0,255,136,.1)}

.sidebar-separator{height:1px;background:var(--border);margin:.5rem 1rem}

.sidebar-feed{border-top:1px solid var(--border);padding:.75rem;max-height:220px;overflow-y:auto}
.feed-title{font-size:.6rem;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.5rem;font-weight:600}
.feed-item{font-size:.65rem;color:var(--text2);padding:.35rem 0;border-bottom:1px solid rgba(255,255,255,.03);line-height:1.4}
.feed-item:last-child{border-bottom:none}
.feed-item .feed-time{color:var(--text3);font-size:.58rem}
.feed-item .feed-dot{display:inline-block;width:5px;height:5px;border-radius:50%;margin-right:.35rem}

.main-content{margin-left:240px;flex:1;padding:1.5rem 2rem;overflow-y:auto;min-height:100vh}
.main-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:.75rem}
.main-title{font-size:1.1rem;font-weight:700;color:var(--text);letter-spacing:.02em;text-transform:uppercase}
.main-subtitle{font-size:.68rem;color:var(--text3);margin-top:.2rem}
.header-actions{display:flex;align-items:center;gap:.5rem}
.btn{background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--text2);padding:.4rem .75rem;border-radius:6px;cursor:pointer;font-size:.72rem;font-family:'JetBrains Mono',monospace;transition:all .15s}
.btn:hover{color:var(--text);border-color:var(--accent);background:rgba(0,255,136,.05)}
.btn-accent{background:rgba(0,255,136,.1);border-color:rgba(0,255,136,.3);color:var(--accent)}
.btn-accent:hover{background:rgba(0,255,136,.18)}
.btn-export{background:rgba(136,68,255,.08);border:1px solid rgba(136,68,255,.25);color:var(--purple)}
.btn-export:hover{border-color:var(--purple);background:rgba(136,68,255,.15);color:var(--text)}

/* ── Stat cards ─────────────────────────────── */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;margin-bottom:1.25rem}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem;border-left:3px solid var(--accent);transition:all .2s;position:relative;overflow:hidden}
.stat:hover{border-color:var(--accent);background:var(--surface-hover);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.3)}
.stat:nth-child(2){border-left-color:var(--blue)}
.stat:nth-child(3){border-left-color:var(--purple)}
.stat:nth-child(4){border-left-color:var(--orange)}
.stat:nth-child(5){border-left-color:var(--red)}
.stat:nth-child(6){border-left-color:var(--cyan)}
.stat .icon{font-size:1.1rem;margin-bottom:.3rem}
.stat .label{font-size:.62rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;font-weight:500}
.stat .value{font-size:1.5rem;font-weight:700;margin-top:.15rem;letter-spacing:-.02em}

/* ── Charts row ─────────────────────────────── */
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:.75rem;margin-bottom:1.25rem}
.chart-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem;transition:all .2s}
.chart-panel:hover{border-color:rgba(0,255,136,.2)}
.chart-title{font-size:.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem}
.chart-title .dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.chart-body{display:flex;align-items:center;gap:1rem;min-height:100px}
.chart-body svg{flex-shrink:0}
.chart-stack{display:flex;flex-direction:column;gap:.85rem;width:100%}
.chart-indicators{display:grid;grid-template-columns:repeat(auto-fit,minmax(86px,1fr));gap:.55rem}
.chart-indicator{border:1px solid rgba(255,255,255,.05);background:rgba(255,255,255,.02);border-radius:8px;padding:.55rem .65rem}
.chart-indicator-value{display:block;color:var(--text);font-size:1rem;font-weight:700}
.chart-indicator-label{display:block;color:var(--text3);font-size:.6rem;text-transform:uppercase;letter-spacing:.06em;margin-top:.2rem}
.chart-legend{font-size:.72rem;color:var(--text2);line-height:1.7}
.chart-legend .item{display:flex;align-items:center;gap:.4rem}
.chart-legend .swatch{width:8px;height:8px;border-radius:2px;display:inline-block;flex-shrink:0}
.chart-legend .count{color:var(--text);font-weight:600;margin-left:auto;padding-left:.5rem}
.chart-empty{color:var(--text3);font-size:.76rem;font-style:italic;padding:1rem 0}

/* ── Sub-tab bar (Activity Log, etc) ────────── */
.tab-bar{display:flex;gap:.25rem;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:0;flex-wrap:wrap}
.tab{padding:.5rem .85rem;border:none;border-bottom:2px solid transparent;background:none;color:var(--text2);cursor:pointer;font-size:.72rem;font-weight:500;transition:all .15s;border-radius:6px 6px 0 0;font-family:'JetBrains Mono',monospace}
.tab:hover{color:var(--text);background:rgba(255,255,255,.03)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent);background:rgba(0,255,136,.05)}
.tab .count{background:rgba(255,255,255,.05);color:var(--text3);font-size:.6rem;padding:1px 5px;border-radius:4px;margin-left:.3rem}
.tab.active .count{color:var(--accent);background:rgba(0,255,136,.1)}

/* ── Activity Timeline ────────────────────── */
.atl-table{width:100%;border-collapse:collapse;font-size:.72rem}
.atl-table th{text-align:left;padding:.5rem .6rem;color:var(--text3);font-size:.6rem;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface);z-index:1}
.atl-table td{padding:.45rem .6rem;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:top;line-height:1.5}
.atl-table tr:hover td{background:rgba(255,255,255,.02)}
.atl-wrap{max-height:600px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius)}
.atl-icon{display:inline-block;width:18px;text-align:center;margin-right:.3rem;font-size:.8rem}
.atl-role{display:inline-block;font-size:.58rem;padding:1px 5px;border-radius:3px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-left:.35rem}
.atl-role.facilitator{background:rgba(0,255,136,.12);color:var(--green)}
.atl-role.developer{background:rgba(68,136,255,.12);color:var(--blue)}
.atl-role.reviewer{background:rgba(136,68,255,.12);color:var(--purple)}
.atl-role.planner{background:rgba(255,136,0,.12);color:var(--orange)}
.atl-role.observer{background:rgba(255,255,255,.06);color:var(--text3)}
.atl-role.admin{background:rgba(255,68,68,.12);color:var(--red)}
.atl-status{display:inline-block;font-size:.58rem;padding:1px 5px;border-radius:3px;font-weight:500}
.atl-status.backlog{background:rgba(255,255,255,.06);color:var(--text3)}
.atl-status.technical_analysis{background:rgba(255,136,0,.12);color:var(--orange)}
.atl-status.approved{background:rgba(0,255,136,.12);color:var(--green)}
.atl-status.in_progress{background:rgba(68,136,255,.12);color:var(--blue)}
.atl-status.in_review{background:rgba(136,68,255,.12);color:var(--purple)}
.atl-status.ready_for_commit{background:rgba(6,182,212,.12);color:var(--cyan)}
.atl-status.resolved{background:rgba(0,255,136,.2);color:var(--green)}
.atl-status.blocked{background:rgba(255,68,68,.12);color:var(--red)}
.atl-verdict{display:inline-block;font-size:.62rem;padding:1px 6px;border-radius:3px;font-weight:700;letter-spacing:.03em}
.atl-verdict.pass{background:rgba(0,255,136,.15);color:var(--green)}
.atl-verdict.fail{background:rgba(255,68,68,.15);color:var(--red)}
.atl-detail{color:var(--text2);font-size:.65rem;margin-top:.15rem;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atl-detail:hover{white-space:normal;overflow:visible}
.atl-cat{display:inline-block;width:3px;height:16px;border-radius:2px;margin-right:.4rem;vertical-align:middle}
.atl-cat.governance{background:var(--purple)}
.atl-cat.development{background:var(--blue)}
.atl-cat.planning{background:var(--orange)}
.atl-cat.system{background:var(--text3)}
.atl-cat.jobs{background:var(--cyan)}
.atl-time-sep{text-align:center;padding:.6rem 0;color:var(--text3);font-size:.6rem;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid var(--border)}
.atl-time-sep span{background:var(--surface);padding:0 .8rem}
.atl-ticket-link{color:var(--blue);cursor:pointer;text-decoration:none}
.atl-ticket-link:hover{text-decoration:underline}
.atl-agent-name{color:var(--text);font-weight:500}

/* ── Sections & tables ──────────────────────── */
.section{display:none}.section.active{display:block}
.table-wrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;max-height:500px;overflow-y:auto}
.table-wrap::-webkit-scrollbar{width:6px}
.table-wrap::-webkit-scrollbar-track{background:var(--surface)}
.table-wrap::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
table{width:100%;border-collapse:collapse;font-size:.76rem}
thead{position:sticky;top:0;z-index:1}
th{background:var(--surface-hover);color:var(--text2);font-weight:500;font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;padding:.6rem .75rem;text-align:left;border-bottom:1px solid var(--border)}
td{padding:.55rem .75rem;border-bottom:1px solid rgba(47,47,47,.5);color:var(--text2);vertical-align:middle}
tr:hover td{background:rgba(255,255,255,.02);color:var(--text)}
tr:nth-child(even) td{background:rgba(0,0,0,.15)}
td.mono{font-family:monospace;font-size:.72rem;color:var(--text3)}
tr.clickable{cursor:pointer}
tr.clickable.active td{background:rgba(0,255,136,.06);color:var(--text)}

/* ── Badges ─────────────────────────────────── */
.badge{display:inline-block;padding:2px 9px;border-radius:4px;font-size:.65rem;font-weight:600;letter-spacing:.03em;text-transform:uppercase}
.badge-success,.badge-active,.badge-applied{background:rgba(0,255,136,.1);color:var(--green)}
.badge-blue,.badge-validated,.badge-a,.badge-decision,.badge-pattern{background:rgba(68,136,255,.1);color:var(--blue)}
.badge-orange,.badge-b,.badge-proposed,.badge-gotcha{background:rgba(255,136,0,.1);color:var(--orange)}
.badge-red,.badge-stale,.badge-failed{background:rgba(255,68,68,.1);color:var(--red)}
.badge-purple,.badge-context,.badge-plan{background:rgba(136,68,255,.1);color:var(--purple)}
.badge-cyan,.badge-solution,.badge-preference{background:rgba(6,182,212,.1);color:var(--cyan)}
.badge-global{background:rgba(255,136,0,.1);color:var(--orange)}
.badge-repo{background:rgba(0,255,136,.1);color:var(--green)}

/* ── Empty state ────────────────────────────── */
.empty{color:var(--text3);font-size:.82rem;padding:2rem;text-align:center;font-style:italic}

/* ── Toast notifications ───────────────────── */
.toast{position:fixed;bottom:1.5rem;right:1.5rem;padding:.75rem 1.25rem;border-radius:6px;font-size:.76rem;color:var(--text);z-index:200;opacity:0;transform:translateY(10px);transition:all .3s ease;pointer-events:none;max-width:380px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.toast.show{opacity:1;transform:translateY(0);pointer-events:auto}
.toast.success{background:rgba(0,255,136,.12);border:1px solid rgba(0,255,136,.3)}
.toast.error{background:rgba(255,68,68,.12);border:1px solid rgba(255,68,68,.3)}

/* ── Export button ─────────────────────────── */
.btn-export{background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.25);color:var(--purple)}
.btn-export:hover{border-color:var(--purple);background:rgba(168,85,247,.15);color:var(--text)}

/* ── Presence panel ────────────────────────── */
.presence-title{font-size:.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-bottom:.6rem;display:flex;align-items:center;gap:.5rem}
.presence-title .dot{width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block}
.presence{display:flex;flex-wrap:wrap;gap:.6rem;margin-bottom:1.25rem}
.agent-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:.85rem 1rem;min-width:220px;flex:1 1 220px;max-width:320px;transition:all .2s;display:flex;align-items:flex-start;gap:.65rem;cursor:pointer}
.agent-card:hover{border-color:rgba(0,255,136,.3);background:var(--surface-hover);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.3)}
.agent-card.selected{border-color:var(--accent);background:rgba(0,255,136,.05)}
.status-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;margin-top:4px;box-shadow:0 0 6px currentColor}
.status-dot.online{background:var(--green);color:var(--green)}
.status-dot.idle{background:var(--orange);color:var(--orange)}
.status-dot.offline{background:var(--text3);color:var(--text3);box-shadow:none}
.agent-info{flex:1;min-width:0}
.agent-name{font-size:.85rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-meta{font-size:.7rem;color:var(--text2);margin-top:2px;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.agent-meta .badge{font-size:.6rem;padding:1px 6px}
.agent-time{font-size:.65rem;color:var(--text3);margin-top:4px;font-family:monospace}
.agent-files{font-size:.65rem;color:var(--text3);margin-top:2px}

/* ── Agent timeline ─────────────────────────── */
.timeline-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:.75rem}
.timeline-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.05rem}
.timeline-head{display:flex;justify-content:space-between;gap:.75rem;align-items:flex-start;margin-bottom:.8rem}
.timeline-title{font-size:.86rem;font-weight:700;color:var(--text)}
.timeline-meta{font-size:.68rem;color:var(--text3);display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.25rem}
.timeline-events{display:flex;flex-direction:column;gap:.55rem}
.timeline-event{border:1px solid rgba(255,255,255,.05);border-radius:8px;background:rgba(255,255,255,.02);padding:.65rem .75rem}
.timeline-event-head{display:flex;justify-content:space-between;gap:.6rem;flex-wrap:wrap;font-size:.67rem;color:var(--text3);margin-bottom:.3rem}
.timeline-event-tool{color:var(--blue);font-weight:600}
.timeline-event-summary{font-size:.76rem;color:var(--text2);line-height:1.45;white-space:pre-wrap}

/* ── Search debugger ────────────────────────── */
.search-debug-wrap{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:.75rem}
.search-debug-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.05rem}
.search-debug-panel h4{font-size:.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.75rem}
.search-debug-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.55rem;margin-bottom:.8rem}
.search-debug-results{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem}
.search-debug-column{border:1px solid rgba(255,255,255,.05);border-radius:8px;background:rgba(255,255,255,.02);padding:.8rem}
.search-debug-column h5{font-size:.7rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.65rem}
.search-debug-list{display:flex;flex-direction:column;gap:.5rem}
.search-debug-item{border:1px solid rgba(255,255,255,.05);border-radius:8px;padding:.55rem .6rem;background:rgba(255,255,255,.02)}
.search-debug-path{font-size:.74rem;color:var(--text);font-family:monospace;word-break:break-word}
.search-debug-score{font-size:.66rem;color:var(--text3);display:flex;justify-content:space-between;gap:.5rem;margin-top:.25rem}
.search-debug-hint{font-size:.74rem;color:var(--text3);line-height:1.5}
.template-hint{font-size:.68rem;color:var(--text3);line-height:1.45}

/* ── Ticket detail ──────────────────────────── */
.detail-card{margin-top:.9rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem}
.detail-head{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;margin-bottom:.85rem}
.detail-title{font-size:1rem;font-weight:700;color:var(--text)}
.detail-sub{font-size:.72rem;color:var(--text2);margin-top:.25rem;display:flex;gap:.45rem;flex-wrap:wrap}
.detail-controls{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;justify-content:flex-end}
.ticket-block-toggle{display:inline-flex;align-items:center;gap:.4rem;padding:.3rem .55rem;border-radius:999px;border:1px solid rgba(239,68,68,.24);background:rgba(239,68,68,.08);color:var(--text2);font-size:.72rem;cursor:pointer}
.ticket-block-toggle input[type="checkbox"]{width:15px;height:15px;accent-color:var(--red);cursor:pointer}
.ticket-block-toggle.disabled{opacity:.55;cursor:not-allowed}
.ticket-block-toggle.disabled input[type="checkbox"]{cursor:not-allowed}
.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;margin-bottom:.9rem}
.detail-block{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.04);border-radius:8px;padding:.75rem}
.detail-label{font-size:.64rem;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.35rem}
.detail-value{font-size:.8rem;color:var(--text2);line-height:1.5}
.edge-meta-list{display:flex;flex-direction:column;gap:.5rem}
.edge-meta-item{border:1px solid rgba(255,255,255,.05);border-radius:8px;background:rgba(255,255,255,.02);padding:.6rem .7rem}
.edge-meta-top{display:flex;justify-content:space-between;gap:.6rem;flex-wrap:wrap;font-size:.74rem;color:var(--text)}
.edge-meta-score{font-family:monospace;color:var(--text2)}
.edge-meta-note{font-size:.68rem;color:var(--text3);line-height:1.45;margin-top:.28rem}
.dep-link{color:#3b82f6;text-decoration:none;font-weight:500}.dep-link:hover{text-decoration:underline;color:#60a5fa}
.detail-section{margin-top:1rem}
.detail-section h4{font-size:.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.55rem}
.quorum-banner{border:1px solid rgba(239,68,68,.22);border-left:3px solid var(--red);border-radius:8px;background:rgba(239,68,68,.08);padding:.8rem .9rem;margin-bottom:.75rem}
.quorum-banner strong{color:var(--red)}
.quorum-banner-list{display:flex;flex-direction:column;gap:.4rem;margin-top:.45rem}
.comment-list,.history-list,.patch-list{display:flex;flex-direction:column;gap:.55rem}
.comment-item,.history-item,.patch-item{border:1px solid rgba(255,255,255,.05);border-radius:8px;background:rgba(255,255,255,.02);padding:.7rem .8rem}
.comment-meta,.history-meta,.patch-meta{font-size:.67rem;color:var(--text3);display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.35rem}
.comment-item{border-left:3px solid var(--comment-accent,#3b82f6);background:linear-gradient(90deg,var(--comment-bg,rgba(59,130,246,.07)),rgba(255,255,255,.02) 42%)}
.comment-meta{justify-content:space-between;align-items:center;gap:.75rem}
.comment-author{display:inline-flex;align-items:center;gap:.45rem;color:var(--comment-accent,#3b82f6);font-weight:600}
.comment-author-swatch{width:10px;height:10px;border-radius:50%;display:inline-block;box-shadow:0 0 8px var(--comment-accent,#3b82f6);background:var(--comment-accent,#3b82f6)}
.comment-author-id{color:var(--text3);font-weight:500;font-size:.92em}
.comment-time{color:var(--text3);font-family:monospace}
.comment-content,.history-content,.patch-content{font-size:.78rem;color:var(--text2);line-height:1.5;white-space:pre-wrap}
.ticket-help{font-size:.78rem;color:var(--text3);padding:1rem 0}
.ticket-toolbar{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.75rem;margin-bottom:.9rem}
.action-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem}
.action-card h4{font-size:.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.75rem}
.ticket-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem;margin-bottom:.9rem}
.metric-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.05rem}
.metric-card h4{font-size:.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.75rem}
.metric-list{display:flex;flex-direction:column;gap:.45rem}
.metric-row{display:flex;align-items:center;justify-content:space-between;gap:.75rem;font-size:.78rem;color:var(--text2)}
.metric-row strong{color:var(--text);font-weight:600}
.metric-row .badge{font-size:.62rem}
.metric-empty{font-size:.76rem;color:var(--text3)}
.ticket-toolbar-top{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap;margin-bottom:.8rem}
.ticket-toolbar-meta{font-size:.72rem;color:var(--text3)}
.view-toggle{display:inline-flex;gap:.35rem;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);padding:.25rem;border-radius:999px}
.view-btn{border:none;background:transparent;color:var(--text2);padding:.4rem .8rem;border-radius:999px;cursor:pointer;font-size:.75rem}
.view-btn.active{background:rgba(59,130,246,.14);color:var(--text)}
.view-btn:hover{color:var(--text)}
.filters-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.65rem}
.board-wrap{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:.75rem}
.board-column{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:.85rem;display:flex;flex-direction:column;gap:.65rem;min-height:220px}
.board-column-head{display:flex;flex-direction:column;gap:.5rem}
.board-column-headline{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.board-column-title{font-size:.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em}
.board-column-count{font-family:monospace;font-size:.72rem;color:var(--text3)}
.board-column-summary{display:flex;gap:.35rem;flex-wrap:wrap}
.board-column-stat{display:inline-flex;align-items:center;gap:.25rem;padding:.18rem .42rem;border-radius:999px;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.03);font-size:.65rem;color:var(--text3)}
.board-column-stat.alert{color:var(--orange);border-color:rgba(245,158,11,.22);background:rgba(245,158,11,.08)}
.board-list{display:flex;flex-direction:column;gap:.6rem}
.board-card{border:1px solid rgba(255,255,255,.05);border-left:3px solid rgba(59,130,246,.45);border-radius:8px;background:rgba(255,255,255,.02);padding:.7rem;cursor:pointer;transition:all .15s}
.board-card:hover{background:rgba(255,255,255,.04);border-color:rgba(0,255,136,.25)}
.board-card.active{background:rgba(0,255,136,.06);border-color:rgba(0,255,136,.35)}
.board-card-title{font-size:.8rem;color:var(--text);font-weight:600;line-height:1.35;margin:.35rem 0}
.board-card-flags{display:flex;gap:.35rem;flex-wrap:wrap;margin-bottom:.35rem}
.board-card-meta{display:flex;gap:.4rem;flex-wrap:wrap;font-size:.68rem;color:var(--text3)}
.board-card-sub{font-size:.68rem;color:var(--text3);font-family:monospace}
.board-card-agents{display:flex;flex-direction:column;gap:.3rem;margin-top:.45rem;padding-top:.4rem;border-top:1px solid rgba(255,255,255,.05)}
.agent-badge{display:flex;align-items:center;gap:.35rem;font-size:.65rem;color:var(--text2)}
.agent-badge .agent-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.agent-dot.online{background:#22c55e;animation:heartbeat 1.5s ease-in-out infinite}
.agent-dot.idle{background:#f59e0b;opacity:.5}
.agent-dot.offline{background:#ef4444;opacity:.3}
.agent-dot.open{background:#4a5567;opacity:.3}
.agent-badge .agent-note{color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}
@keyframes heartbeat{0%,100%{transform:scale(1);opacity:.7}50%{transform:scale(1.5);opacity:1}}
@keyframes agent-pulse{0%,100%{box-shadow:0 0 0 0 rgba(0,255,136,.3)}50%{box-shadow:0 0 14px 5px rgba(0,255,136,.12)}}
.board-card.has-active-agent{animation:agent-pulse 2.5s ease-in-out infinite}
@keyframes card-enter{from{opacity:0;transform:translateY(20px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}
.board-card.entering{animation:card-enter .4s cubic-bezier(.16,1,.3,1)}
@keyframes abandoned-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}
.agent-badge.abandoned{animation:abandoned-shake .5s ease-in-out}
@keyframes note-update{from{background:rgba(0,255,136,.1)}to{background:transparent}}
.agent-note.updated{animation:note-update 1s ease-out}
.role-badge{display:inline-block;padding:.1rem .35rem;border-radius:4px;font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.role-badge.developer{background:rgba(59,130,246,.15);color:#6ba3f7}
.role-badge.reviewer{background:rgba(168,85,247,.15);color:#c084fc}
.role-badge.facilitator{background:rgba(245,158,11,.15);color:#fbbf24}
.role-badge.planner{background:rgba(6,182,212,.15);color:#22d3ee}
.agent-summary-panel{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.5rem;padding:.75rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:1rem}
.agent-pill{display:flex;flex-direction:column;gap:.2rem;padding:.5rem;border-radius:6px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);transition:all .2s}
.agent-pill:hover{border-color:rgba(0,255,136,.25)}
.agent-pill.open-slot{opacity:.4;border-style:dashed}
.agent-pill .pill-role{font-size:.65rem;font-weight:600}
.agent-pill .pill-name{font-size:.72rem;color:var(--text)}
.agent-pill .pill-ticket{font-size:.6rem;color:var(--blue);cursor:pointer}
.agent-pill .pill-note{font-size:.58rem;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-summary-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem}
.agent-summary-title{font-size:.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em}
.agent-summary-stats{font-size:.65rem;color:var(--text3)}
.field{display:flex;flex-direction:column;gap:.35rem;margin-bottom:.7rem}
.field label{font-size:.68rem;color:var(--text3);text-transform:uppercase;letter-spacing:.05em}
.field input,.field textarea,.field select{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:.6rem .7rem;font-size:.8rem}
.field textarea{min-height:88px;resize:vertical}
.field-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.65rem}
.field-toggle .toggle-row{display:flex;align-items:center;gap:.55rem;min-height:38px;padding:.2rem 0;color:var(--text2);font-size:.78rem;line-height:1.4}
.field-toggle input[type="checkbox"]{width:16px;height:16px;accent-color:var(--blue);flex-shrink:0}
.action-submit{background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.3);color:var(--text);padding:.55rem .9rem;border-radius:8px;cursor:pointer;font-size:.78rem}
.action-submit:hover{background:rgba(59,130,246,.18)}
.action-submit:disabled{opacity:.55;cursor:not-allowed}
.action-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem}
.actor-chip{display:inline-flex;align-items:center;gap:.35rem;font-size:.72rem;color:var(--text2);padding:.25rem .55rem;border-radius:20px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05)}
.governance-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem;margin-bottom:1.25rem}
.governance-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.55rem}
.governance-panel-title{font-size:.75rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;font-weight:500}
.governance-panel-meta{font-size:.72rem;color:var(--text3);line-height:1.5}
.governance-panel .toggle-row{display:flex;align-items:flex-start;gap:.65rem;color:var(--text2);font-size:.8rem;line-height:1.5}
.governance-panel input[type="checkbox"]{width:16px;height:16px;margin-top:2px;accent-color:var(--blue);flex-shrink:0}
.governance-panel-actions{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;margin-top:.75rem}

/* ── Dependency graph ──────────────────────── */
.dep-graph-toolbar{display:flex;gap:.6rem;align-items:center;margin-bottom:.75rem;flex-wrap:wrap}
.dep-graph-toolbar input,.dep-graph-toolbar select{background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:.45rem .6rem;font-size:.78rem}
.dep-graph-toolbar input{flex:1;min-width:180px;max-width:300px}
.dep-graph-toolbar .dep-graph-info{margin-left:auto;font-size:.72rem;color:var(--text3)}
.dep-graph-wrap{position:relative;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--bg)}
.dep-graph-wrap canvas{display:block;width:100%;cursor:grab}
.dep-graph-wrap canvas:active{cursor:grabbing}
.dep-graph-legend{display:flex;gap:1rem;padding:.55rem .8rem;font-size:.68rem;color:var(--text3);border-top:1px solid var(--border)}
.dep-graph-legend span{display:inline-flex;align-items:center;gap:.3rem}
.dep-graph-legend .swatch{width:8px;height:8px;border-radius:50%;display:inline-block}
.dep-graph-tooltip{position:absolute;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.5rem .7rem;font-size:.74rem;color:var(--text2);pointer-events:none;display:none;z-index:10;max-width:280px}
.dep-graph-tooltip .mono{font-family:monospace;font-size:.72rem;color:var(--text)}
.dep-graph-empty{padding:3rem;text-align:center;color:var(--text3);font-size:.82rem}

/* ── Modal overlay ──────────────────────────── */
.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;display:none;align-items:center;justify-content:center;backdrop-filter:blur(2px)}
.modal-backdrop.active{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);width:90%;max-width:780px;max-height:85vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,.5)}
.modal-header{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface);z-index:1}
.modal-header h2{font-size:.85rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.modal-close{background:none;border:none;color:var(--text3);cursor:pointer;font-size:1.2rem;padding:.25rem;line-height:1}
.modal-close:hover{color:var(--text)}
.modal-body{padding:1.25rem}
.modal-footer{padding:.75rem 1.25rem;border-top:1px solid var(--border);display:flex;gap:.5rem;justify-content:flex-end}

/* ── Footer ─────────────────────────────────── */
footer{text-align:center;font-size:.65rem;color:var(--text3);padding:1rem;border-top:1px solid var(--border);margin-top:1rem}
footer a{color:var(--accent);text-decoration:none}
</style>
</head>
<body>

<div class="app-layout">
  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-logo">&#9670; MONSTHERA</span>
      <span class="sidebar-version">v${VERSION}</span>
      <div class="sidebar-pulse" id="pulse" title="SSE connected"></div>
    </div>
    <div class="sidebar-nav" id="sidebar-nav">
      <div class="nav-item active" data-route="mission" onclick="navigate('mission')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        MISSION CONTROL
      </div>
      <div class="nav-item" data-route="agents" onclick="navigate('agents')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        AGENTS <span class="nav-count" id="nav-count-agents">0</span>
      </div>
      <div class="nav-item" data-route="tickets" onclick="navigate('tickets')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 0 0-2 2v3a2 2 0 1 1 0 4v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3a2 2 0 1 1 0-4V7a2 2 0 0 0-2-2H5z"/></svg>
        TICKETS <span class="nav-count" id="nav-count-tickets">0</span>
      </div>
      <div class="nav-item" data-route="convoys" onclick="navigate('convoys')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
        CONVOYS <span class="nav-count" id="nav-count-convoys">0</span>
      </div>
      <div class="nav-item" data-route="knowledge" onclick="navigate('knowledge')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a8 8 0 0 0-8 8c0 3.4 2.1 6.3 5 7.5V20h6v-2.5c2.9-1.2 5-4.1 5-7.5a8 8 0 0 0-8-8z"/><path d="M9 22h6"/></svg>
        KNOWLEDGE <span class="nav-count" id="nav-count-knowledge">0</span>
      </div>
      <div class="nav-item" data-route="workflows" onclick="navigate('workflows')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        WORKFLOWS
      </div>
      <div class="nav-item" data-route="improvement" onclick="navigate('improvement')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
        IMPROVEMENT
      </div>
      <div class="nav-item" data-route="jobboard" onclick="navigate('jobboard')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="8" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="16" y2="21"/></svg>
        JOB BOARD <span class="nav-count" id="nav-count-jobs">0</span>
      </div>
      <div class="sidebar-separator"></div>
      <div class="nav-item" data-route="activity" onclick="navigate('activity')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        ACTIVITY LOG <span class="nav-count" id="nav-count-logs">0</span>
      </div>
      <div class="nav-item" data-route="settings" onclick="navigate('settings')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        SETTINGS
      </div>
    </div>
    <div class="sidebar-feed" id="live-feed">
      <div class="feed-title">LIVE FEED</div>
      <div class="feed-item" style="color:var(--text3)">Connecting...</div>
    </div>
  </nav>

  <!-- Main Content -->
  <div class="main-content">
    <div id="route-content">
      <!-- Populated by router -->
    </div>
    <footer>Monsthera &mdash; Multi-agent shared context &amp; coordination server · <span id="last-updated"></span></footer>
  </div>
</div>

<!-- Modal root -->
<div class="modal-backdrop" id="modal-backdrop" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modal-content"></div>
</div>

<div class="toast" id="toast"></div>

<script>
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const api=p=>fetch('/api/'+p).then(r=>r.json());
const ROUTES=['mission','agents','tickets','knowledge','workflows','activity','settings'];
const PALETTE=['#00FF88','#4488FF','#FF8800','#8844FF','#06b6d4','#ec4899','#FF4444','#14b8a6','#f97316','#6366f1'];
const COMMENT_TONES=[
  {accent:'#4488FF',bg:'rgba(68,136,255,.10)'},
  {accent:'#00FF88',bg:'rgba(0,255,136,.10)'},
  {accent:'#FF8800',bg:'rgba(255,136,0,.10)'},
  {accent:'#8844FF',bg:'rgba(136,68,255,.10)'},
  {accent:'#06b6d4',bg:'rgba(6,182,212,.10)'},
  {accent:'#FF4444',bg:'rgba(255,68,68,.10)'},
  {accent:'#ec4899',bg:'rgba(236,72,153,.10)'},
  {accent:'#14b8a6',bg:'rgba(20,184,166,.10)'}
];
const COMMENT_EMOJIS=['🤖','🧠','🧪','🛠️','📡','🛰️','🔎','⚙️','🧭','📝'];
const TYPE_COLORS={decision:'#4488FF',gotcha:'#FF8800',pattern:'#8844FF',context:'#06b6d4',plan:'#ec4899',solution:'#00FF88',preference:'#6366f1',runbook:'#14b8a6'};
const STATE_COLORS={proposed:'#FF8800',validated:'#4488FF',applied:'#00FF88',committed:'#00FF88',stale:'#FF4444',failed:'#FF4444'};
const KNOWLEDGE_TYPES=['decision','gotcha','pattern','context','plan','solution','preference'];
const TICKET_STATUS_CLS={resolved:'success',closed:'success',technical_analysis:'purple',approved:'success',in_progress:'blue',in_review:'blue',ready_for_commit:'cyan',backlog:'orange',blocked:'red',wont_fix:'red'};
const TICKET_TRANSITIONS={backlog:['technical_analysis','wont_fix'],technical_analysis:['backlog','approved','blocked','resolved','wont_fix'],approved:['technical_analysis','in_progress','in_review','blocked','backlog','wont_fix'],in_progress:['approved','in_review','blocked','wont_fix'],in_review:['in_progress','ready_for_commit','blocked'],ready_for_commit:['in_progress','blocked','resolved'],blocked:['backlog','technical_analysis','approved','in_progress','in_review','ready_for_commit','wont_fix'],resolved:['in_progress','closed'],closed:['backlog'],wont_fix:['backlog']};
const DONE_TICKET_STATUSES=['resolved','closed','wont_fix'];
const TICKET_BOARD_WIP_THRESHOLDS={backlog:8,technical_analysis:4,approved:6,in_progress:4,in_review:3,ready_for_commit:4,blocked:2,done:99};
const TICKET_BOARD_COLUMNS=[
  {id:'backlog',label:'Backlog',statuses:['backlog']},
  {id:'technical_analysis',label:'Technical Analysis',statuses:['technical_analysis']},
  {id:'approved',label:'Approved',statuses:['approved']},
  {id:'in_progress',label:'In Progress',statuses:['in_progress']},
  {id:'in_review',label:'In Review',statuses:['in_review']},
  {id:'ready_for_commit',label:'Ready for Commit',statuses:['ready_for_commit']},
  {id:'blocked',label:'Blocked',statuses:['blocked']},
  {id:'done',label:'Done',statuses:['resolved','closed','wont_fix']}
];
let currentRoute='mission';
let liveFeedEvents=[];
let selectedAgentId=null;
let navCounts={agents:0,tickets:0,knowledge:0,logs:0};
let tabCounts={agents:0,timeline:0,'activity-timeline':0,'search-debug':0,dependencies:0,logs:0,patches:0,notes:0,knowledge:0,tickets:0};
let selectedTicketId=null;
let selectedTicketDetail=null;
let selectedActorSessionId=null;
let ticketActors=[];
let dashboardAgents=[];
let ticketViewMode='table';
let ticketCreateMode='agent';
let ticketFilters={search:'',status:'all',severity:'all',assignee:'all',hideDone:true};
let selectedTicketTemplateId='';
let governanceSettings={loading:true,saving:false,data:null};
let searchDebugState={query:'',scope:'',limit:10,loading:false,error:'',data:null};
let knowledgeCatalog=[];
let knowledgeViewState={query:'',scope:'all',type:'',limit:20,loading:false,error:'',results:[]};
let knowledgeGraphState={loaded:false,loading:false,error:'',nodes:[],edges:[],defaultThreshold:.65,selectedId:''};
const DASHBOARD_LOCALE='en-US';
const COMMENT_RELATIVE_TIME_FORMATTER=typeof Intl!=='undefined'&&Intl.RelativeTimeFormat
  ?new Intl.RelativeTimeFormat(DASHBOARD_LOCALE,{numeric:'auto'})
  :null;
const COMMENT_TIME_FORMATTER=typeof Intl!=='undefined'
  ?new Intl.DateTimeFormat(DASHBOARD_LOCALE,{hour:'2-digit',minute:'2-digit'})
  :null;
const COMMENT_DATE_TIME_FORMATTER=typeof Intl!=='undefined'
  ?new Intl.DateTimeFormat(DASHBOARD_LOCALE,{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})
  :null;
const COMMENT_FULL_TIME_FORMATTER=typeof Intl!=='undefined'
  ?new Intl.DateTimeFormat(DASHBOARD_LOCALE,{dateStyle:'medium',timeStyle:'short'})
  :null;

function repoBasename(repoPath){
  if(!repoPath) return 'unknown repo';
  var clean=String(repoPath).replace(/[\\\\/]+$/,'');
  var parts=clean.split(/[\\\\/]/);
  return parts[parts.length-1]||clean;
}

function parseDashboardDate(value){
  if(!value) return null;
  var raw=String(value).trim();
  if(!raw) return null;
  var parsed=new Date(raw);
  if(!Number.isNaN(parsed.getTime())) return parsed;
  var localMatch=raw.match(/^(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2})(?::(\\d{2}))?$/);
  if(localMatch){
    parsed=new Date(
      Number(localMatch[1]),
      Number(localMatch[2])-1,
      Number(localMatch[3]),
      Number(localMatch[4]),
      Number(localMatch[5]),
      Number(localMatch[6]||0)
    );
    if(!Number.isNaN(parsed.getTime())) return parsed;
  }
  parsed=new Date(raw.replace(' ','T'));
  return Number.isNaN(parsed.getTime())?null:parsed;
}

function sameCalendarDay(a,b){
  return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
}

function previousCalendarDay(a,b){
  var yesterday=new Date(b.getFullYear(),b.getMonth(),b.getDate()-1);
  return sameCalendarDay(a,yesterday);
}

function formatRelativeTime(value,unit){
  if(COMMENT_RELATIVE_TIME_FORMATTER) return COMMENT_RELATIVE_TIME_FORMATTER.format(value,unit);
  if(unit==='day'&&value===-1) return 'yesterday';
  if(unit==='minute'&&value===0) return 'now';
  var abs=Math.abs(value);
  var suffix=value<0?' ago':'';
  var prefix=value>0?'in ':'';
  var label=abs+' '+unit+(abs===1?'':'s');
  return prefix+label+suffix;
}

function formatClockTime(date){
  return COMMENT_TIME_FORMATTER?COMMENT_TIME_FORMATTER.format(date):date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

function formatDayShort(days){
  if(days===null||days===undefined||Number.isNaN(days)) return '-';
  if(days<=0) return 'today';
  if(days===1) return '1d';
  return days+'d';
}

function formatIdleLabel(days,hours){
  if(hours===null||hours===undefined||Number.isNaN(hours)) return '';
  if(hours<24) return 'idle '+Math.max(1,hours)+'h';
  return 'idle '+formatDayShort(days);
}

function ticketStatusLabel(status){
  return String(status||'').replace(/_/g,' ');
}

function formatStatusAge(days,hours){
  if(hours===null||hours===undefined||Number.isNaN(hours)) return '-';
  if(hours<24) return Math.max(1,hours)+'h';
  return formatDayShort(days);
}

function ticketAgeCell(ticket){
  var statusLabel=ticketStatusLabel(ticket.status)+' '+formatStatusAge(ticket.statusAgeDays,ticket.statusAgeHours);
  if(!ticket.inReviewStale){
    return statusLabel;
  }
  var idleLabel=formatIdleLabel(ticket.inReviewIdleDays,ticket.inReviewIdleHours);
  return {
    badge:'Review stale',
    cls:'red',
    text: idleLabel?statusLabel+' · '+idleLabel:statusLabel,
    title: ticket.lastReviewActivityAt
      ?'Last review activity '+formatTicketConversationTime(ticket.lastReviewActivityAt).title
      :'No recent review activity',
  };
}

function formatTicketConversationTime(value){
  var date=parseDashboardDate(value);
  if(!date){
    return {label:String(value||'-'),title:String(value||'-')};
  }
  var title=COMMENT_FULL_TIME_FORMATTER?COMMENT_FULL_TIME_FORMATTER.format(date):date.toLocaleString();
  var now=new Date();
  var deltaMs=date.getTime()-now.getTime();
  var absMs=Math.abs(deltaMs);
  if(absMs<60*1000){
    return {label:formatRelativeTime(0,'minute'),title:title};
  }
  if(absMs<60*60*1000){
    var minutes=Math.max(1,Math.floor(absMs/(60*1000)));
    return {label:formatRelativeTime(deltaMs<0?-minutes:minutes,'minute'),title:title};
  }
  if(absMs<6*60*60*1000){
    var hours=Math.max(1,Math.floor(absMs/(60*60*1000)));
    return {label:formatRelativeTime(deltaMs<0?-hours:hours,'hour'),title:title};
  }
  if(sameCalendarDay(date,now)){
    return {label:formatClockTime(date),title:title};
  }
  if(previousCalendarDay(date,now)){
    return {label:formatRelativeTime(-1,'day')+' '+formatClockTime(date),title:title};
  }
  return {
    label:COMMENT_DATE_TIME_FORMATTER?COMMENT_DATE_TIME_FORMATTER.format(date):date.toLocaleString(),
    title:title,
  };
}

function actorLabel(actor){
  return actor.name+' ('+actor.role+') · '+actor.sessionId.slice(0,12);
}

function buildBoardColumnSummary(column,columnTickets){
  if(!columnTickets.length) return '';
  var parts=[];
  var limit=TICKET_BOARD_WIP_THRESHOLDS[column.id];
  if(limit!==undefined&&columnTickets.length>=limit&&column.id!=='done'){
    parts.push('<span class="badge badge-orange" title="WIP limit '+esc(String(limit))+'">WIP '+esc(String(columnTickets.length))+'/'+esc(String(limit))+'</span>');
  }
  var unassignedCount=columnTickets.filter(function(ticket){return !ticket.assignee}).length;
  if(unassignedCount){
    parts.push('<span class="board-column-stat'+(column.id==='in_progress'||column.id==='in_review'?' alert':'')+'">'+esc(String(unassignedCount))+' unassigned</span>');
  }
  var staleReviews=columnTickets.filter(function(ticket){return ticket.inReviewStale}).length;
  if(staleReviews){
    parts.push('<span class="board-column-stat alert">'+esc(String(staleReviews))+' stale review'+(staleReviews===1?'':'s')+'</span>');
  }
  var highPriorityCount=columnTickets.filter(function(ticket){return ticket.isHighPriority}).length;
  if(highPriorityCount){
    parts.push('<span class="board-column-stat">'+esc(String(highPriorityCount))+' P7+</span>');
  }
  var oldestAge=columnTickets.reduce(function(maxAge,ticket){
    return Math.max(maxAge,Number(ticket.statusAgeDays)||0);
  },0);
  parts.push('<span class="board-column-stat">longest '+esc(formatDayShort(oldestAge))+' in state</span>');
  return '<div class="board-column-summary">'+parts.join('')+'</div>';
}

function getTicketTemplatesData(){
  return window.__monstheraTicketTemplates||{templates:[],exists:false,path:'',error:''};
}

function getTicketTemplateById(templateId){
  if(!templateId) return null;
  return (getTicketTemplatesData().templates||[]).find(function(template){return template.id===templateId})||null;
}

function getSelectedActor(){
  if(!ticketActors.length) return null;
  var found=ticketActors.find(function(actor){return actor.sessionId===selectedActorSessionId});
  if(found) return found;
  selectedActorSessionId=ticketActors[0].sessionId;
  return ticketActors[0];
}

function getBlockedRestoreStatus(ticket){
  if(!ticket||ticket.status!=='blocked'||!Array.isArray(ticket.history)) return null;
  for(var i=ticket.history.length-1;i>=0;i-=1){
    var entry=ticket.history[i];
    if(entry&&entry.toStatus==='blocked'&&entry.fromStatus&&entry.fromStatus!=='blocked'){
      return entry.fromStatus;
    }
  }
  return null;
}

function applyTemplateToCreateForm(template){
  if(!template) return;
  var setValue=function(id,value){
    var el=document.getElementById(id);
    if(el) el.value=value;
  };
  setValue('create-ticket-title',template.title||'');
  setValue('create-ticket-description',template.description||'');
  setValue('create-ticket-severity',template.severity||'medium');
  setValue('create-ticket-priority',String(template.priority!=null?template.priority:5));
  setValue('create-ticket-tags',(template.tags||[]).join(', '));
  setValue('create-ticket-paths',(template.affectedPaths||[]).join(', '));
  setValue('create-ticket-criteria',template.acceptanceCriteria||'');
}

async function apiPost(path,body){
  var res=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  var data=await res.json().catch(function(){return {}});
  if(!res.ok){
    throw new Error(data.error||'Request failed');
  }
  return data;
}

/* ── SVG Chart: Donut ────────────────────────── */
function makeDonut(data,size,thickness){
  size=size||110;thickness=thickness||18;
  if(!data.length) return mkEmpty();
  const total=data.reduce(function(s,d){return s+d.value},0);
  if(!total) return mkEmpty();
  const cx=size/2,cy=size/2,r=(size-thickness)/2;
  let angle=-90;
  let paths='';
  data.forEach(function(d){
    var pct=d.value/total;
    var a1=angle*Math.PI/180;
    var sweep=pct*360;
    var a2=(angle+sweep)*Math.PI/180;
    var large=sweep>180?1:0;
    var x1=cx+r*Math.cos(a1),y1=cy+r*Math.sin(a1);
    var x2=cx+r*Math.cos(a2),y2=cy+r*Math.sin(a2);
    if(sweep>0.5){
      paths+='<path d="M'+x1.toFixed(2)+' '+y1.toFixed(2)+' A'+r+' '+r+' 0 '+large+' 1 '+x2.toFixed(2)+' '+y2.toFixed(2)+'" fill="none" stroke="'+d.color+'" stroke-width="'+thickness+'" stroke-linecap="round" opacity="0.85"/>';
    }
    angle+=sweep;
  });
  var center='<text x="'+cx+'" y="'+cy+'" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size="'+(size*.18).toFixed(0)+'" font-weight="700" font-family="monospace">'+total+'</text>';
  return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'">'+paths+center+'</svg>';
}

/* ── SVG Chart: Horizontal Bars ──────────────── */
function makeBarChart(data,width,barH,gap){
  width=width||220;barH=barH||20;gap=gap||6;
  if(!data.length) return mkEmpty();
  var max=Math.max.apply(null,data.map(function(d){return d.value}));
  if(!max) max=1;
  var h=data.length*(barH+gap)-gap+4;
  var bars='';
  data.forEach(function(d,i){
    var y=i*(barH+gap);
    var w=Math.max((d.value/max)*(width-80),2);
    bars+='<rect x="0" y="'+y+'" width="'+w.toFixed(1)+'" height="'+barH+'" rx="4" fill="'+d.color+'" opacity="0.75"/>';
    bars+='<text x="'+(w+6).toFixed(1)+'" y="'+(y+barH/2)+'" dominant-baseline="central" fill="#8a8a8a" font-size="11" font-family="monospace">'+d.value+'</text>';
    bars+='<text x="'+width+'" y="'+(y+barH/2)+'" text-anchor="end" dominant-baseline="central" fill="#6a6a6a" font-size="10">'+d.label+'</text>';
  });
  return '<svg width="'+width+'" height="'+h+'" viewBox="0 0 '+width+' '+h+'">'+bars+'</svg>';
}

/* ── SVG Chart: Sparkline ────────────────────── */
function makeSparkline(values,width,height){
  width=width||320;height=height||60;
  if(!values.length||values.every(function(v){return v===0})) return mkEmpty();
  var max=Math.max.apply(null,values);
  if(!max) max=1;
  var step=width/(values.length-1||1);
  var pts=values.map(function(v,i){return (i*step).toFixed(1)+','+(height-2-(v/max)*(height-8)).toFixed(1)}).join(' ');
  var area='M0,'+height+' L'+pts+' L'+((values.length-1)*step).toFixed(1)+','+height+' Z';
  var gradient='<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4488FF" stop-opacity="0.3"/><stop offset="100%" stop-color="#4488FF" stop-opacity="0.02"/></linearGradient></defs>';
  return '<svg width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'">'+gradient+'<path d="'+area+'" fill="url(#sg)"/><polyline points="'+pts+'" fill="none" stroke="#4488FF" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/></svg>';
}

function mkEmpty(message){return '<div class="chart-empty">'+esc(message||'No data')+'</div>';}

function makeLegend(data){
  return data.map(function(d){return '<div class="item"><span class="swatch" style="background:'+d.color+'"></span>'+esc(d.label)+'<span class="count">'+d.value+'</span></div>'}).join('');
}

function makeIndicators(items){
  return '<div class="chart-indicators">'+items.map(function(item){
    return '<div class="chart-indicator"><span class="chart-indicator-value">'+esc(String(item.value))+'</span><span class="chart-indicator-label">'+esc(item.label)+'</span></div>';
  }).join('')+'</div>';
}

function hashString(value){
  var hash=0;
  String(value||'').split('').forEach(function(ch){
    hash=((hash<<5)-hash)+ch.charCodeAt(0);
    hash|=0;
  });
  return Math.abs(hash);
}

function commentTone(agentId){
  return COMMENT_TONES[hashString(agentId)%COMMENT_TONES.length];
}

function commentEmoji(agentId){
  return COMMENT_EMOJIS[hashString(agentId)%COMMENT_EMOJIS.length];
}

function commentPersona(comment){
  var identity=((comment.agentName||'')+' '+(comment.agentType||'')+' '+(comment.agentId||'')).toLowerCase();
  if(identity.includes('claude')){
    return {emoji:'👨‍🦰',name:comment.agentName||comment.agentId||'-'};
  }
  if(identity.includes('codex')||identity.includes('vapire')){
    return {emoji:'🧛',name:comment.agentName||comment.agentId||'-'};
  }
  return {
    emoji:commentEmoji(comment.agentName||comment.agentId||'-'),
    name:comment.agentName||comment.agentId||'-'
  };
}

function quorumVerdictBadgeClass(verdict){
  if(verdict==='pass') return 'success';
  if(verdict==='fail') return 'red';
  if(verdict==='abstain') return 'orange';
  return 'blue';
}

function truncateTicketText(value,maxLength){
  var text=String(value||'').trim();
  if(text.length<=maxLength) return text;
  return text.slice(0,Math.max(0,maxLength-3)).trimEnd()+'...';
}

function renderTicketQuorumDetail(quorum){
  if(!quorum) return '';
  var progressTitle=quorum.progress&&quorum.progress.title?quorum.progress.title:(quorum.progress&&quorum.progress.label?quorum.progress.label:'Quorum progress');
  var summary='<div class="detail-grid">'
    +'<div class="detail-block"><div class="detail-label">Quorum Progress</div><div class="detail-value"><span class="badge badge-'+esc(quorum.progress&&quorum.progress.state||'blue')+'" title="'+esc(progressTitle)+'">'+esc(quorum.progress&&quorum.progress.label||'-')+'</span><br>'+esc(String((quorum.progress&&quorum.progress.responded)||0))+' / '+esc(String((quorum.progress&&quorum.progress.total)||0))+' verdicts received</div></div>'
    +'<div class="detail-block"><div class="detail-label">Consensus</div><div class="detail-value">Pass: '+esc(String(quorum.counts&&quorum.counts.pass||0))+'<br>Fail: '+esc(String(quorum.counts&&quorum.counts.fail||0))+'<br>Abstain: '+esc(String(quorum.counts&&quorum.counts.abstain||0))+'<br>Missing: '+esc(String(quorum.counts&&quorum.counts.missing||0))+'</div></div>'
    +'<div class="detail-block"><div class="detail-label">Gate</div><div class="detail-value">Transition: '+esc(quorum.transition||'-')+'<br>Required passes: '+esc(String(quorum.requiredPasses||0))+'<br>Ready: '+esc(quorum.advisoryReady?'yes':'no')+'</div></div>'
    +'</div>';
  var vetoBanner=!quorum.blockedByVeto?'':'<div class="quorum-banner"><strong>Blocked by veto.</strong><div class="quorum-banner-list">'+(quorum.vetoes||[]).map(function(veto){
    var author=veto.agentName||veto.agentId||veto.specialization;
    var reason=truncateTicketText(veto.reasoning||'No reasoning provided.',160);
    return '<div>'+esc(veto.specialization)+' · '+esc(author)+' · '+esc(reason)+'</div>';
  }).join('')+'</div></div>';
  var verdictRows=(quorum.verdicts||[]).map(function(entry){
    var who=entry.agentName||entry.agentId||'Awaiting verdict';
    var when=entry.createdAt?new Date(entry.createdAt).toLocaleString():'Pending';
    var note=entry.reasoning||'Waiting for a verdict from this specialization.';
    var badge='<span class="badge badge-'+quorumVerdictBadgeClass(entry.verdict)+'">'+esc(entry.verdict)+'</span>';
    var vetoNote=entry.isVeto?' <span class="badge badge-red">veto</span>':'';
    return '<div class="history-item"><div class="history-meta"><span>'+esc(entry.specialization)+'</span><span>'+badge+vetoNote+'</span><span>'+esc(who)+'</span><span>'+esc(when)+'</span></div><div class="history-content">'+esc(note)+'</div></div>';
  }).join('')||'<div class="ticket-help">No verdicts recorded yet.</div>';
  return '<div class="detail-section"><h4>Council Verdicts</h4>'+summary+vetoBanner+'<div class="history-list">'+verdictRows+'</div></div>';
}

function agentShortLabel(agentId){
  var parts=String(agentId||'-').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if(parts.length>1){
    return parts.slice(0,2).map(function(part){return part.charAt(0).toUpperCase()}).join('');
  }
  var compact=String(agentId||'-').replace(/[^a-zA-Z0-9]/g,'').toUpperCase();
  return compact.slice(0,2)||'--';
}

/* ── Router ──────────────────────────────────── */
function navigate(route){
  currentRoute=route;
  updateSidebarActive();
  renderRoute();
}

function updateSidebarActive(){
  document.querySelectorAll('.nav-item').forEach(function(item){
    item.classList.toggle('active',item.getAttribute('data-route')===currentRoute);
  });
}

function updateNavCounts(){
  Object.keys(navCounts).forEach(function(k){
    var el=document.getElementById('nav-count-'+k);
    if(el) el.textContent=navCounts[k];
  });
  /* legacy compat for internal functions */
  Object.keys(tabCounts).forEach(function(k){
    var el=document.getElementById('count-'+k);
    if(el) el.textContent=tabCounts[k];
  });
}

function renderRoute(){
  var host=document.getElementById('route-content');
  if(!host) return;
  switch(currentRoute){
    case 'mission': renderMissionControl(host); break;
    case 'agents': renderAgentsScreen(host); break;
    case 'tickets': renderTicketsScreen2(host); break;
    case 'knowledge': renderKnowledgeScreen(host); break;
    case 'workflows': renderWorkflowsScreen(host); break;
    case 'improvement': renderImprovementScreen(host); break;
    case 'jobboard': renderJobBoardScreen(host); break;
    case 'activity': renderActivityScreen(host); break;
    case 'settings': renderSettingsScreen(host); break;
    case 'convoys': renderConvoysScreen(host); break;
    default: renderMissionControl(host);
  }
}

function addLiveFeedEvent(type,detail){
  liveFeedEvents.unshift({type:type,detail:detail,time:new Date()});
  if(liveFeedEvents.length>4) liveFeedEvents=liveFeedEvents.slice(0,4);
  renderLiveFeed();
}

function renderLiveFeed(){
  var feed=document.getElementById('live-feed');
  if(!feed) return;
  var feedDotColor=function(type){
    if(type.startsWith('ticket')) return 'var(--blue)';
    if(type.startsWith('agent')||type.startsWith('session')) return 'var(--green)';
    if(type.startsWith('knowledge')) return 'var(--purple)';
    return 'var(--text3)';
  };
  feed.innerHTML='<div class="feed-title">LIVE FEED</div>'
    +(liveFeedEvents.length?liveFeedEvents.map(function(ev){
      return '<div class="feed-item"><span class="feed-dot" style="background:'+feedDotColor(ev.type)+'"></span>'+esc(ev.type.replace(/_/g,' '))+' <span class="feed-time">'+ev.time.toLocaleTimeString()+'</span></div>';
    }).join(''):'<div class="feed-item" style="color:var(--text3)">No events yet</div>');
}

/* ── Screen: Mission Control ────────────────── */
function renderMissionControl(host){
  host.innerHTML=''
    +'<div class="main-header"><div><div class="main-title">Mission Control</div><div class="main-subtitle" id="repo-name">loading…</div></div>'
    +'<div class="header-actions"><span style="font-size:.65rem;color:var(--text3)" id="last-updated"></span>'
    +'<button class="btn btn-export" id="export-btn" title="Export knowledge to Obsidian">Export Obsidian</button>'
    +'<button class="btn" id="refresh-btn" onclick="refresh()">Refresh</button></div></div>'
    +'<div class="stats" id="overview"></div>'
    +'<div class="governance-panel" id="governance-panel"><div class="empty">Loading governance policy…</div></div>'
    +'<div class="presence-title"><span class="dot"></span> Live Agents</div>'
    +'<div class="presence" id="presence"><div class="empty" style="width:100%">No agents registered yet</div></div>'
    +'<div class="charts" id="charts"></div>';
  var exportBtn=document.getElementById('export-btn');
  if(exportBtn){
    exportBtn.addEventListener('click',async function(){
      exportBtn.disabled=true;exportBtn.textContent='Exporting...';
      try{
        var res=await fetch('/api/export/obsidian',{method:'POST'});
        var data=await res.json();
        if(res.ok){showToast('Exported '+data.exported+' entries → '+data.path,'success');}
        else{showToast('Export failed: '+(data.error||'Unknown error'),'error');}
      }catch(e){showToast('Export failed: '+e.message,'error');}
      finally{exportBtn.disabled=false;exportBtn.textContent='Export Obsidian';}
    });
  }
  refresh();
}

/* ── Screen: Agents ─────────────────────────── */
function renderAgentsScreen(host){
  host.innerHTML=''
    +'<div class="main-header"><div><div class="main-title">Agents</div><div class="main-subtitle">Agent registry &amp; timeline</div></div>'
    +'<div class="header-actions"><button class="btn" onclick="refresh()">Refresh</button></div></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem" id="agents-layout">'
    +'<div><div class="presence-title"><span class="dot"></span> Agent Registry</div><div id="agents-grid" class="presence"></div></div>'
    +'<div><div class="presence-title">Agent Timeline</div><div id="agent-timeline-panel"></div></div>'
    +'</div>';
  refresh();
}

/* ── Screen: Tickets (routed) ───────────────── */
function renderTicketsScreen2(host){
  host.innerHTML=''
    +'<div class="main-header"><div><div class="main-title">Tickets</div><div class="main-subtitle">Kanban board &amp; management</div></div>'
    +'<div class="header-actions"><button class="btn btn-accent" onclick="openCreateTicketModal()">+ CREATE</button><button class="btn" onclick="refresh()">Refresh</button></div></div>'
    +'<div id="tickets" class="section active"></div>';
  refresh();
}

/* ── Screen: Knowledge ──────────────────────── */
function renderKnowledgeScreen(host){
  host.innerHTML=''
    +'<div class="main-header"><div><div class="main-title">Knowledge</div><div class="main-subtitle">Search &amp; knowledge graph</div></div>'
    +'<div class="header-actions"><button class="btn" onclick="refresh()">Refresh</button></div></div>'
    +'<div id="knowledge" class="section active"></div>';
  refresh();
}

/* ── Screen: Workflows ──────────────────────── */
function renderWorkflowsScreen(host){
  host.innerHTML=''
    +'<div class="main-header"><div><div class="main-title">Workflows</div><div class="main-subtitle">Pipeline visualization</div></div></div>'
    +'<div id="workflows-content"><div class="empty">Workflows view coming soon — pipeline visualization from .monsthera/workflows/*.yaml</div></div>';
}

/* ── Screen: Improvement (autoresearch) ─────── */
function renderImprovementScreen(host){
  host.innerHTML=''
    +'<div class="main-header"><div><div class="main-title">Improvement Loop</div><div class="main-subtitle">Autoresearch KPI scorecard &amp; trends</div></div>'
    +'<div class="header-actions"><button class="btn" onclick="refreshImprovement()">Refresh</button></div></div>'
    +'<div class="stats" id="sim-overview"></div>'
    +'<div class="charts" id="sim-charts"></div>'
    +'<div id="sim-runs"></div>';
  refreshImprovement();
}

async function refreshImprovement(){
  try{
    var results=await Promise.all([api('simulation/latest'),api('simulation/runs'),api('simulation/trends')]);
    var latest=results[0],runsData=results[1],trends=results[2];
    var runs=runsData?runsData.runs:[];

    /* Overview stats from latest run */
    var ov=document.getElementById('sim-overview');
    if(ov){
      if(latest){
        ov.replaceChildren(
          makeCard('&#9889;','Composite Score',(latest.compositeScore*100).toFixed(1)+'%'),
          makeCard('&#128640;','Velocity',latest.velocity.avgTimeToResolveMs>0?(latest.velocity.avgTimeToResolveMs/1000).toFixed(0)+'s':'—'),
          makeCard('&#127919;','Autonomy',(((latest.autonomy.firstPassSuccessRate+latest.autonomy.councilApprovalRate+latest.autonomy.mergeSuccessRate)/3)*100).toFixed(0)+'%'),
          makeCard('&#128154;','Quality',((latest.quality.testPassRate)*100).toFixed(0)+'%'),
          makeCard('&#128176;','Avg Payload',latest.cost.avgPayloadCharsPerTicket>0?(latest.cost.avgPayloadCharsPerTicket/1000).toFixed(1)+'k':'—'),
          makeCard('&#128202;','Total Runs',String(runs.length))
        );
      }else{
        ov.innerHTML='<div class="empty" style="width:100%">No simulation runs yet. Run the simulation-loop workflow to generate data.</div>';
      }
    }

    /* Trend sparklines */
    var chartsEl=document.getElementById('sim-charts');
    if(chartsEl&&trends&&trends.composite&&trends.composite.length>1){
      /* Note: all data is server-generated, not user input — safe for innerHTML */
      chartsEl.innerHTML=''
        +'<div class="chart-panel"><div class="chart-title"><span class="dot" style="background:var(--accent)"></span> Composite Score Trend</div>'
        +'<div class="chart-body"><svg id="sim-sparkline" width="100%" height="120" viewBox="0 0 400 120"></svg></div></div>'
        +'<div class="chart-panel"><div class="chart-title"><span class="dot" style="background:var(--blue)"></span> Dimension Breakdown</div>'
        +'<div class="chart-body"><div class="chart-stack"><div class="chart-indicators" id="sim-dim-indicators"></div></div></div></div>';
      /* Draw composite sparkline */
      var svg=document.getElementById('sim-sparkline');
      if(svg){
        var vals=trends.composite;
        var maxV=Math.max.apply(null,vals)||1;
        var minV=Math.min.apply(null,vals);
        var range=maxV-minV||1;
        var pts=vals.map(function(v,i){
          var x=vals.length>1?i/(vals.length-1)*380+10:200;
          var y=110-(v-minV)/range*100;
          return x+','+y;
        }).join(' ');
        svg.innerHTML='<polyline points="'+pts+'" fill="none" stroke="var(--accent)" stroke-width="2"/>'
          +vals.map(function(v,i){
            var x=vals.length>1?i/(vals.length-1)*380+10:200;
            var y=110-(v-minV)/range*100;
            return '<circle cx="'+x+'" cy="'+y+'" r="3" fill="var(--accent)"><title>'+esc(trends.labels[i])+': '+(v*100).toFixed(1)+'%</title></circle>';
          }).join('');
      }
      /* Dimension indicators from latest */
      var dimEl=document.getElementById('sim-dim-indicators');
      if(dimEl&&latest){
        var autoScore=((latest.autonomy.firstPassSuccessRate+latest.autonomy.councilApprovalRate+latest.autonomy.mergeSuccessRate)/3*100).toFixed(0);
        var qualScore=((latest.quality.testPassRate+1-latest.quality.regressionRate+latest.quality.ticketRetrievalPrecision5+latest.quality.codeRetrievalPrecision5)/4*100).toFixed(0);
        dimEl.innerHTML=''
          +'<div class="chart-indicator"><span class="chart-indicator-value" style="color:var(--accent)">'+(latest.velocity.avgTimeToResolveMs>0?(latest.velocity.avgTimeToResolveMs/1000).toFixed(0)+'s':'—')+'</span><span class="chart-indicator-label">Avg Resolve</span></div>'
          +'<div class="chart-indicator"><span class="chart-indicator-value" style="color:var(--blue)">'+autoScore+'%</span><span class="chart-indicator-label">Autonomy</span></div>'
          +'<div class="chart-indicator"><span class="chart-indicator-value" style="color:var(--green)">'+qualScore+'%</span><span class="chart-indicator-label">Quality</span></div>'
          +'<div class="chart-indicator"><span class="chart-indicator-value" style="color:var(--orange)">'+(latest.cost.escalationCount)+'</span><span class="chart-indicator-label">Escalations</span></div>';
      }
    }else if(chartsEl){
      chartsEl.innerHTML='';
    }

    /* Run history table */
    var runsEl=document.getElementById('sim-runs');
    if(runsEl){
      if(runs.length>0){
        var rows=runs.slice().reverse().map(function(r){
          var d=r.deltas;
          var deltaStr=d?((d.composite>=0?'+':'')+(d.composite*100).toFixed(1)+'%'):'—';
          var deltaClass=d?(d.composite>=0?'badge-success':'badge-red'):'';
          return '<tr>'
            +'<td class="mono">'+esc(r.runId)+'</td>'
            +'<td>'+new Date(r.timestamp).toLocaleString()+'</td>'
            +'<td>'+r.corpusSize+'</td>'
            +'<td>'+esc(r.phasesRun.join(', '))+'</td>'
            +'<td><span class="badge badge-blue">'+(r.compositeScore*100).toFixed(1)+'%</span></td>'
            +'<td><span class="badge '+deltaClass+'">'+deltaStr+'</span></td>'
            +'<td class="mono">'+(r.durationMs/1000).toFixed(1)+'s</td>'
            +'</tr>';
        }).join('');
        runsEl.innerHTML='<div style="margin-top:1rem"><div class="presence-title">Run History</div>'
          +'<div class="table-wrap"><table><thead><tr><th>Run ID</th><th>Timestamp</th><th>Corpus</th><th>Phases</th><th>Score</th><th>Delta</th><th>Duration</th></tr></thead>'
          +'<tbody>'+rows+'</tbody></table></div></div>';
      }else{
        runsEl.innerHTML='';
      }
    }
  }catch(e){
    console.error('Improvement refresh failed',e);
  }
}

/* ── Screen: Activity Log ───────────────────── */
function renderActivityScreen(host){
  host.innerHTML=''
    +'<div class="main-header"><div><div class="main-title">Activity Log</div><div class="main-subtitle">Events, patches &amp; notes</div></div>'
    +'<div class="header-actions"><button class="btn" onclick="refresh()">Refresh</button></div></div>'
    +'<div style="margin-bottom:1rem"><div class="tab-bar" id="tab-bar"></div></div>'
    +'<div id="activity-timeline" class="section active"></div>'
    +'<div id="logs" class="section"></div>'
    +'<div id="patches" class="section"></div>'
    +'<div id="notes" class="section"></div>'
    +'<div id="timeline" class="section"></div>'
    +'<div id="search-debug" class="section"></div>'
    +'<div id="dependencies" class="section"></div>';
  /* build sub-tabs for activity view */
  var bar=document.getElementById('tab-bar');
  if(bar){
    var activityTabs=[['activity-timeline','Timeline'],['logs','Activity Log'],['patches','Patches'],['notes','Notes'],['timeline','Agent Timeline'],['search-debug','Search Debug'],['dependencies','Dependencies']];
    activityTabs.forEach(function(t,i){
      var id=t[0],label=t[1];
      var btn=document.createElement('button');
      btn.className='tab'+(i===0?' active':'');
      btn.id='tab-'+id;
      btn.innerHTML=esc(label)+'<span class="count" id="count-'+id+'">0</span>';
      btn.addEventListener('click',function(){showActivityTab(id,btn)});
      bar.appendChild(btn);
    });
  }
  refresh();
}

function showActivityTab(id,btn){
  document.querySelectorAll('#route-content .section').forEach(function(s){s.classList.remove('active')});
  document.querySelectorAll('#tab-bar .tab').forEach(function(t){t.classList.remove('active')});
  var el=document.getElementById(id);
  if(el) el.classList.add('active');
  btn.classList.add('active');
  refresh();
}

/* ── Screen: Settings ───────────────────────── */
function renderSettingsScreen(host){
  host.innerHTML=''
    +'<div class="main-header"><div><div class="main-title">Settings</div><div class="main-subtitle">Governance &amp; configuration</div></div></div>'
    +'<div class="governance-panel" id="governance-panel"><div class="empty">Loading governance policy…</div></div>'
    +'<div class="governance-panel" id="convoy-settings-panel" style="margin-top:1.5rem"><div class="empty">Loading convoy settings…</div></div>';
  refreshGovernance();
  refreshConvoySettings();
}

var convoySettingsState={data:null,loading:true,saving:false};

async function refreshConvoySettings(){
  try{
    convoySettingsState.data=await api('settings/convoy');
    convoySettingsState.loading=false;
    convoySettingsState.saving=false;
    renderConvoySettingsPanel();
  }catch(e){console.error('Convoy settings refresh failed:',e);}
}

function renderConvoySettingsPanel(){
  var host=document.getElementById('convoy-settings-panel');
  if(!host) return;
  if(convoySettingsState.loading && !convoySettingsState.data){
    host.innerHTML='<div class="empty">Loading convoy settings…</div>';
    return;
  }
  var s=convoySettingsState.data;
  if(!s){
    host.innerHTML='<div class="empty">Convoy settings unavailable</div>';
    return;
  }
  var autoRefresh=!!s.autoRefresh;
  var maxTPW=s.maxTicketsPerWave||5;
  var disabled=convoySettingsState.saving?' disabled':'';
  host.innerHTML=''
    +'<div class="governance-panel-head">'
      +'<div><div class="governance-panel-title">Convoy Settings</div><div class="governance-panel-meta">Configure wave auto-refresh and concurrency limits for convoy execution.</div></div>'
      +'<span class="badge badge-'+(autoRefresh?'success':'orange')+'">'+(autoRefresh?'Auto-refresh on':'Auto-refresh off')+'</span>'
    +'</div>'
    +'<label class="toggle-row" for="convoy-auto-refresh-toggle">'
      +'<input id="convoy-auto-refresh-toggle" type="checkbox"'+(autoRefresh?' checked':'')+disabled+'>'
      +'<span>Automatically absorb new approved tickets into active convoys when advancing waves.</span>'
    +'</label>'
    +'<div style="margin-top:1rem;display:flex;align-items:center;gap:1rem">'
      +'<label style="white-space:nowrap">Max tickets per wave:</label>'
      +'<input id="convoy-max-tpw" type="range" min="1" max="50" value="'+maxTPW+'"'+disabled+' style="flex:1">'
      +'<span id="convoy-max-tpw-val" style="min-width:2ch;text-align:right;font-weight:bold">'+maxTPW+'</span>'
    +'</div>'
    +'<div class="governance-panel-actions" style="margin-top:1rem">'
      +'<button class="btn btn-accent" id="convoy-save-btn"'+disabled+'>Save convoy settings</button>'
    +'</div>';

  var slider=document.getElementById('convoy-max-tpw');
  var valSpan=document.getElementById('convoy-max-tpw-val');
  if(slider) slider.addEventListener('input',function(){if(valSpan) valSpan.textContent=slider.value;});

  var saveBtn=document.getElementById('convoy-save-btn');
  if(saveBtn) saveBtn.addEventListener('click',async function(){
    var ar=document.getElementById('convoy-auto-refresh-toggle');
    var sl=document.getElementById('convoy-max-tpw');
    convoySettingsState.saving=true;
    renderConvoySettingsPanel();
    try{
      convoySettingsState.data=await apiPost('settings/convoy',{autoRefresh:!!ar.checked,maxTicketsPerWave:parseInt(sl.value)||5});
      showToast('Convoy settings saved','success');
    }catch(err){
      showToast('Convoy save failed: '+String(err.message||err),'error');
    }
    convoySettingsState.saving=false;
    renderConvoySettingsPanel();
  });
}

/* ── Modal helpers ──────────────────────────── */
function openModal(html){
  var backdrop=document.getElementById('modal-backdrop');
  var content=document.getElementById('modal-content');
  if(content) content.innerHTML=html;
  if(backdrop) backdrop.classList.add('active');
}

function closeModal(){
  var backdrop=document.getElementById('modal-backdrop');
  if(backdrop) backdrop.classList.remove('active');
  selectedTicketId=null;
  selectedTicketDetail=null;
}

async function openCreateTicketModal(){
  var templateData=getTicketTemplatesData();
  var templates=templateData.templates||[];
  var actor=getSelectedActor();
  var actorOptions=ticketActors.map(function(a){
    return '<option value="'+esc(a.sessionId)+'"'+(a.sessionId===selectedActorSessionId?' selected':'')+'>'+esc(actorLabel(a))+'</option>';
  }).join('');
  var templateOptions='<option value="">— No template —</option>'+templates.map(function(t){
    return '<option value="'+esc(t.id)+'">'+esc(t.title||t.id)+'</option>';
  }).join('');

  openModal(''
    +'<div class="modal-header"><h2>Create Ticket</h2><button class="modal-close" onclick="closeModal()">&times;</button></div>'
    +'<div class="modal-body">'
    +'<div class="field-row" style="margin-bottom:1rem">'
    +'<div class="field"><label>Template</label><select id="create-ticket-template" onchange="var t=getTicketTemplateById(this.value);if(t)applyTemplateToCreateForm(t)">'+templateOptions+'</select></div>'
    +'<div class="field"><label>Acting as</label><select id="create-ticket-actor" onchange="selectedActorSessionId=this.value">'+actorOptions+'</select></div>'
    +'</div>'
    +'<div class="field"><label>Title</label><input id="create-ticket-title" maxlength="200" placeholder="Ticket title"></div>'
    +'<div class="field"><label>Description</label><textarea id="create-ticket-description" maxlength="'+${MAX_TICKET_LONG_TEXT_LENGTH}+'" placeholder="Describe the issue or task"></textarea></div>'
    +'<div class="field-row">'
    +'<div class="field"><label>Severity</label><select id="create-ticket-severity"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="critical">Critical</option></select></div>'
    +'<div class="field"><label>Priority (0-10)</label><input id="create-ticket-priority" type="number" min="0" max="10" value="5"></div>'
    +'</div>'
    +'<div class="field"><label>Tags (comma-separated)</label><input id="create-ticket-tags" placeholder="e.g. bug, api, urgent"></div>'
    +'<div class="field"><label>Affected Paths</label><input id="create-ticket-paths" placeholder="e.g. src/api/, tests/"></div>'
    +'<div class="field"><label>Acceptance Criteria</label><textarea id="create-ticket-criteria" maxlength="'+${MAX_TICKET_LONG_TEXT_LENGTH}+'" placeholder="What must be true for this ticket to be resolved?"></textarea></div>'
    +'</div>'
    +'<div class="modal-footer"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-accent" onclick="submitCreateTicket()">Create Ticket</button></div>');
}

async function submitCreateTicket(){
  var actor=getSelectedActor();
  if(!actor){showToast('No active session to act as','error');return;}
  var title=document.getElementById('create-ticket-title');
  if(!title||!title.value.trim()){showToast('Title is required','error');return;}
  try{
    var tags=(document.getElementById('create-ticket-tags').value||'').split(',').map(function(t){return t.trim()}).filter(Boolean);
    var paths=(document.getElementById('create-ticket-paths').value||'').split(',').map(function(t){return t.trim()}).filter(Boolean);
    await apiPost('tickets/create',{
      sessionId:selectedActorSessionId,
      title:title.value.trim(),
      description:(document.getElementById('create-ticket-description').value||'').trim(),
      severity:document.getElementById('create-ticket-severity').value,
      priority:parseInt(document.getElementById('create-ticket-priority').value)||5,
      tags:tags,affectedPaths:paths,
      acceptanceCriteria:(document.getElementById('create-ticket-criteria').value||'').trim()
    });
    showToast('Ticket created','success');
    closeModal();
    refresh();
  }catch(e){showToast('Create failed: '+e.message,'error');}
}

/* ── Init ────────────────────────────────────── */
function init(){
  navigate('mission');
}

function updateCounts(){
  updateNavCounts();
}

/* ── Cards ───────────────────────────────────── */
function makeCard(icon,label,value){
  var d=document.createElement('div');d.className='stat';
  d.innerHTML='<div class="icon">'+icon+'</div><div class="label">'+esc(label)+'</div><div class="value">'+esc(String(value))+'</div>';
  return d;
}

/* ── Tables ──────────────────────────────────── */
function makeTable(headers,rows){
  if(!rows.length){var p=document.createElement('div');p.className='empty';p.textContent='No data yet';return p;}
  var wrap=document.createElement('div');wrap.className='table-wrap';
  var t=document.createElement('table');
  var thead=document.createElement('thead');var hr=document.createElement('tr');
  headers.forEach(function(h){var th=document.createElement('th');th.textContent=h;hr.appendChild(th)});
  thead.appendChild(hr);t.appendChild(thead);
  var tbody=document.createElement('tbody');
  rows.forEach(function(row){var tr=document.createElement('tr');
    row.forEach(function(cell){var td=document.createElement('td');
      if(typeof cell==='object'&&cell&&cell.badge){var s=document.createElement('span');s.className='badge badge-'+cell.cls;s.textContent=cell.badge;td.appendChild(s);}
      else if(typeof cell==='object'&&cell&&cell.mono){td.className='mono';td.textContent=cell.mono;}
      else{td.textContent=String(cell);}
      tr.appendChild(td)});
    tbody.appendChild(tr)});
  t.appendChild(tbody);wrap.appendChild(t);return wrap;
}

function b(v,c){return{badge:v,cls:c}}
function m(v){return{mono:v}}
function eventStatusClass(status){
  if(status==='success') return 'success';
  if(status==='denied') return 'orange';
  if(status==='stale') return 'blue';
  return 'red';
}

function isDoneTicketStatus(status){
  return DONE_TICKET_STATUSES.includes(status);
}

function hideDoneTicketsActive(){
  return ticketFilters.hideDone && ticketFilters.status==='all';
}

function filterTicketList(tickets){
  return tickets.filter(function(ticket){
    var search=String(ticketFilters.search||'').trim().toLowerCase();
    if(search){
      var haystack=[
        ticket.ticketId,
        ticket.title,
        ticket.status,
        ticket.severity,
        ticket.assignee||'',
        ticket.creator||''
      ].join(' ').toLowerCase();
      if(!haystack.includes(search)) return false;
    }
    if(hideDoneTicketsActive() && isDoneTicketStatus(ticket.status)) return false;
    if(ticketFilters.status!=='all' && ticket.status!==ticketFilters.status) return false;
    if(ticketFilters.severity!=='all' && ticket.severity!==ticketFilters.severity) return false;
    if(ticketFilters.assignee!=='all' && (ticket.assignee||'unassigned')!==ticketFilters.assignee) return false;
    return true;
  });
}

function ticketAssigneeOptions(tickets){
  var seen={};
  var options=[{value:'all',label:'All assignees'},{value:'unassigned',label:'Unassigned'}];
  tickets.forEach(function(ticket){
    if(ticket.assignee && !seen[ticket.assignee]){
      seen[ticket.assignee]=true;
      var agent=dashboardAgents.find(function(entry){return entry.id===ticket.assignee});
      options.push({value:ticket.assignee,label:agent?agent.name:ticket.assignee});
    }
  });
  return options;
}

function renderGovernancePanel(){
  var host=document.getElementById('governance-panel');
  if(!host) return;
  if(governanceSettings.loading && !governanceSettings.data){
    host.innerHTML='<div class="empty">Loading governance policy…</div>';
    return;
  }
  var settings=governanceSettings.data;
  if(!settings||!settings.modelDiversity){
    host.innerHTML='<div class="empty">Governance policy unavailable</div>';
    return;
  }
  var modelDiversity=settings.modelDiversity;
  var enabled=!!modelDiversity.enabled;
  var backlogLabel=modelDiversity.backlogPlanning&&modelDiversity.backlogPlanning.enforce
    ?String(modelDiversity.backlogPlanning.requiredDistinctModels)+' models in backlog review'
    :'backlog distinct-model gate disabled';
  host.innerHTML=''
    +'<div class="governance-panel-head">'
      +'<div><div class="governance-panel-title">Governance Controls</div><div class="governance-panel-meta">Toggle the strict model-diversity policy used by council quorum and backlog planning review. Reviewer independence stays enabled.</div></div>'
      +'<span class="badge badge-'+(enabled?'success':'orange')+'">'+(enabled?'Strict model diversity on':'Strict model diversity off')+'</span>'
    +'</div>'
    +'<label class="toggle-row" for="governance-model-diversity-toggle">'
      +'<input id="governance-model-diversity-toggle" type="checkbox"'+(enabled?' checked':'')+(governanceSettings.saving?' disabled':'')+'>'
      +'<span>Require multi-model council quorum for non-critical tickets, cap each model at '+esc(String(modelDiversity.council.maxVotersPerModel))+' active voters, and keep backlog planning review at '+esc(backlogLabel)+'.</span>'
    +'</label>'
    +'<div class="governance-panel-actions">'
      +'<span class="actor-chip">Council strict: '+esc(modelDiversity.council.strict?'on':'off')+'</span>'
      +'<span class="actor-chip">Max voters/model: '+esc(String(modelDiversity.council.maxVotersPerModel))+'</span>'
      +'<span class="actor-chip">Backlog distinct models: '+esc(String(modelDiversity.backlogPlanning.requiredDistinctModels))+'</span>'
    +'</div>';

  var toggle=document.getElementById('governance-model-diversity-toggle');
  if(toggle){
    toggle.addEventListener('change',async function(e){
      var next=!!e.target.checked;
      governanceSettings.saving=true;
      renderGovernancePanel();
      try{
        governanceSettings.data=await apiPost('settings/governance/model-diversity',{enabled:next});
        showToast(next?'Strict model diversity enabled':'Strict model diversity disabled','success');
        await refresh();
      }catch(err){
        showToast('Governance update failed: '+String(err.message||err),'error');
        governanceSettings.saving=false;
        renderGovernancePanel();
      }
    });
  }
}

function renderTicketToolbar(tickets,filteredTickets){
  var actor=getSelectedActor();
  var templateData=getTicketTemplatesData();
  var templateOptions=['<option value="">Custom ticket</option>'].concat((templateData.templates||[]).map(function(template){
    return '<option value="'+esc(template.id)+'"'+(selectedTicketTemplateId===template.id?' selected':'')+'>'+esc(template.name)+'</option>';
  })).join('');
  var templateHint=templateData.error
    ?'Template file is invalid: '+templateData.error
    :templateData.exists
      ?'Loaded '+String((templateData.templates||[]).length)+' templates from '+templateData.path
      :'No template file yet. Create '+templateData.path+' to enable presets.';
  var actorOptions=ticketActors.map(function(option){
    return '<option value="'+esc(option.sessionId)+'"'+(actor&&actor.sessionId===option.sessionId?' selected':'')+'>'+esc(actorLabel(option))+'</option>';
  }).join('');
  var assigneeOptions=ticketAssigneeOptions(tickets).map(function(option){
    return '<option value="'+esc(option.value)+'"'+(ticketFilters.assignee===option.value?' selected':'')+'>'+esc(option.label)+'</option>';
  }).join('');
  var toolbarMeta='Showing '+esc(String(filteredTickets.length))+' of '+esc(String(tickets.length))+' tickets';
  if(hideDoneTicketsActive()){
    toolbarMeta+=' · done hidden';
  }
  var effectiveCreateMode=ticketActors.length?(ticketCreateMode==='human'?'human':'agent'):'human';
  var createModeOptions=ticketActors.length
    ?'<option value="agent"'+(effectiveCreateMode==='agent'?' selected':'')+'>Active agent session</option><option value="human"'+(effectiveCreateMode==='human'?' selected':'')+'>Human operator</option>'
    :'<option value="human" selected>Human operator</option>';
  var createModeHint=effectiveCreateMode==='human'
    ?'Creates the ticket as a human operator via system context. Use this when no agent session should own authorship.'
    :'Uses the selected active agent session as the ticket creator.';
  return '<div class="ticket-toolbar-top">'
    +'<div class="ticket-toolbar-meta">'+toolbarMeta+'</div>'
    +'<div class="view-toggle">'
      +'<button type="button" class="view-btn'+(ticketViewMode==='table'?' active':'')+'" data-ticket-view="table">Table</button>'
      +'<button type="button" class="view-btn'+(ticketViewMode==='board'?' active':'')+'" data-ticket-view="board">Board</button>'
    +'</div>'
  +'</div>'
  +'<div class="ticket-toolbar">'
    +'<div class="action-card"><h4>Active Session</h4>'
    +(ticketActors.length
      ?'<div class="field"><label for="ticket-actor-select">Act as</label><select id="ticket-actor-select">'+actorOptions+'</select></div><div class="actor-chip">Using '+esc(actorLabel(actor))+'</div>'
      :'<div class="ticket-help">No active agent sessions available. Human ticket creation still works below. Agent sessions are still required to comment or move tickets.</div>')
    +'</div>'
    +'<div class="action-card"><h4>Filters</h4>'
      +'<div class="filters-grid">'
        +'<div class="field"><label for="ticket-filter-search">Search</label><input id="ticket-filter-search" value="'+esc(ticketFilters.search||'')+'" placeholder="ID, title, creator"></div>'
        +'<div class="field"><label for="ticket-filter-status">Status</label><select id="ticket-filter-status"><option value="all"'+(ticketFilters.status==='all'?' selected':'')+'>All statuses</option><option value="backlog"'+(ticketFilters.status==='backlog'?' selected':'')+'>backlog</option><option value="technical_analysis"'+(ticketFilters.status==='technical_analysis'?' selected':'')+'>technical_analysis</option><option value="approved"'+(ticketFilters.status==='approved'?' selected':'')+'>approved</option><option value="in_progress"'+(ticketFilters.status==='in_progress'?' selected':'')+'>in_progress</option><option value="in_review"'+(ticketFilters.status==='in_review'?' selected':'')+'>in_review</option><option value="ready_for_commit"'+(ticketFilters.status==='ready_for_commit'?' selected':'')+'>ready_for_commit</option><option value="blocked"'+(ticketFilters.status==='blocked'?' selected':'')+'>blocked</option><option value="resolved"'+(ticketFilters.status==='resolved'?' selected':'')+'>resolved</option><option value="closed"'+(ticketFilters.status==='closed'?' selected':'')+'>closed</option><option value="wont_fix"'+(ticketFilters.status==='wont_fix'?' selected':'')+'>wont_fix</option></select></div>'
        +'<div class="field"><label for="ticket-filter-severity">Severity</label><select id="ticket-filter-severity"><option value="all"'+(ticketFilters.severity==='all'?' selected':'')+'>All severities</option><option value="critical"'+(ticketFilters.severity==='critical'?' selected':'')+'>critical</option><option value="high"'+(ticketFilters.severity==='high'?' selected':'')+'>high</option><option value="medium"'+(ticketFilters.severity==='medium'?' selected':'')+'>medium</option><option value="low"'+(ticketFilters.severity==='low'?' selected':'')+'>low</option></select></div>'
        +'<div class="field"><label for="ticket-filter-assignee">Assignee</label><select id="ticket-filter-assignee">'+assigneeOptions+'</select></div>'
        +'<div class="field field-toggle"><label for="ticket-filter-hide-done">Done tickets</label><label class="toggle-row" for="ticket-filter-hide-done"><input id="ticket-filter-hide-done" type="checkbox"'+(ticketFilters.hideDone?' checked':'')+'><span>Hide resolved, closed, and wont_fix by default</span></label></div>'
      +'</div>'
    +'</div>'
    +'<div class="action-card"><h4>Create Ticket</h4>'
      +'<form id="create-ticket-form">'
        +'<div class="field-row">'
          +'<div class="field"><label for="create-ticket-template">Template</label><select id="create-ticket-template">'+templateOptions+'</select></div>'
          +'<div class="field"><label>&nbsp;</label><button class="btn" id="apply-ticket-template" type="button">Apply Template</button><div class="template-hint">'+esc(templateHint)+'</div></div>'
        +'</div>'
        +'<div class="field-row">'
          +'<div class="field"><label for="create-ticket-mode">Author</label><select id="create-ticket-mode"'+(ticketActors.length?'':' disabled')+'>'+createModeOptions+'</select></div>'
          +'<div class="field"><label for="create-ticket-human-name">Human Name</label><input id="create-ticket-human-name" maxlength="80" placeholder="Product Owner"'+(effectiveCreateMode==='human'?'':' disabled')+'></div>'
        +'</div>'
        +'<div class="template-hint" id="create-ticket-mode-hint">'+esc(createModeHint)+'</div>'
        +'<div class="field"><label for="create-ticket-title">Title</label><input id="create-ticket-title" name="title" maxlength="200" required></div>'
        +'<div class="field"><label for="create-ticket-description">Description</label><textarea id="create-ticket-description" name="description" maxlength="5000" required></textarea></div>'
        +'<div class="field-row">'
          +'<div class="field"><label for="create-ticket-severity">Severity</label><select id="create-ticket-severity" name="severity"><option value="medium">medium</option><option value="high">high</option><option value="critical">critical</option><option value="low">low</option></select></div>'
          +'<div class="field"><label for="create-ticket-priority">Priority</label><input id="create-ticket-priority" name="priority" type="number" min="0" max="10" value="5"></div>'
        +'</div>'
        +'<div class="field-row">'
          +'<div class="field"><label for="create-ticket-tags">Tags</label><input id="create-ticket-tags" name="tags" placeholder="dashboard, ui"></div>'
          +'<div class="field"><label for="create-ticket-paths">Affected Paths</label><input id="create-ticket-paths" name="paths" placeholder="src/dashboard/html.ts"></div>'
        +'</div>'
        +'<div class="field"><label for="create-ticket-criteria">Acceptance Criteria</label><textarea id="create-ticket-criteria" name="criteria" maxlength="${MAX_TICKET_LONG_TEXT_LENGTH}"></textarea></div>'
        +'<button class="action-submit" type="submit">Create Ticket</button>'
      +'</form>'
    +'</div>'
  +'</div>';
}

function renderTicketMetrics(metrics){
  if(!metrics) return '';
  var statusOrder=['backlog','technical_analysis','approved','in_progress','in_review','ready_for_commit','blocked','resolved','closed','wont_fix'];
  var severityOrder=['critical','high','medium','low'];
  var agingLabels=[
    ['under1d','< 1 day'],
    ['oneTo3d','1-3 days'],
    ['threeTo7d','3-7 days'],
    ['sevenTo14d','7-14 days'],
    ['over14d','> 14 days']
  ];
  function rows(entries){
    if(!entries.length) return '<div class="metric-empty">No data yet.</div>';
    return '<div class="metric-list">'+entries.join('')+'</div>';
  }
  var statusRows=statusOrder.map(function(status){
    var count=(metrics.statusCounts&&metrics.statusCounts[status])||0;
    if(!count) return '';
    return '<div class="metric-row"><span><span class="badge badge-'+(TICKET_STATUS_CLS[status]||'blue')+'">'+esc(status)+'</span></span><strong>'+esc(String(count))+'</strong></div>';
  }).filter(Boolean);
  var severityRows=severityOrder.map(function(severity){
    var count=(metrics.severityCounts&&metrics.severityCounts[severity])||0;
    if(!count) return '';
    var cls=severity==='critical'?'red':severity==='high'?'orange':'blue';
    return '<div class="metric-row"><span><span class="badge badge-'+cls+'">'+esc(severity)+'</span></span><strong>'+esc(String(count))+'</strong></div>';
  }).filter(Boolean);
  var agingRows=agingLabels.map(function(entry){
    var key=entry[0],label=entry[1];
    return '<div class="metric-row"><span>'+esc(label)+'</span><strong>'+esc(String((metrics.agingBuckets&&metrics.agingBuckets[key])||0))+'</strong></div>';
  });
  var blockedRows=(metrics.blockedTickets||[]).map(function(ticket){
    return '<div class="metric-row"><span>'+esc(ticket.ticketId)+' · '+esc(ticket.title.slice(0,28))+'</span><strong>'+esc(String(ticket.ageDays))+'d</strong></div>';
  });
  var unassignedRows=(metrics.unassignedOpen||[]).map(function(ticket){
    return '<div class="metric-row"><span>'+esc(ticket.ticketId)+' · '+esc(ticket.title.slice(0,28))+'</span><strong>'+esc(String(ticket.ageDays))+'d</strong></div>';
  });
  var assigneeRows=(metrics.assigneeLoad||[]).map(function(entry){
    return '<div class="metric-row"><span>'+esc(entry.label)+'</span><strong>'+esc(String(entry.count))+'</strong></div>';
  });
  var duplicateRows=(metrics.duplicateClusters||[]).map(function(cluster){
    var labels=(cluster.ticketIds||[]).slice(0,3).join(', ');
    var reason=(cluster.reasons||[])[0]||'metadata overlap';
    return '<div class="metric-row" title="'+esc((cluster.reasons||[]).join(' · '))+'"><span>'+esc(labels)+(cluster.ticketIds&&cluster.ticketIds.length>3?' +'+esc(String(cluster.ticketIds.length-3)):'')+'</span><strong>'+esc(String(Math.round((cluster.score||0)*100)))+'%</strong></div>'
      +'<div class="metric-empty" style="padding:.1rem 0 .45rem 0">'+esc(reason)+'</div>';
  });
  return '<div class="ticket-metrics">'
    +'<div class="metric-card"><h4>Status Mix</h4>'+rows(statusRows)+'</div>'
    +'<div class="metric-card"><h4>Severity Mix</h4>'+rows(severityRows)+'</div>'
    +'<div class="metric-card"><h4>Aging Buckets</h4>'+rows(agingRows)+'</div>'
    +'<div class="metric-card"><h4>Blocked Tickets</h4><div class="metric-row"><span>Count</span><strong>'+esc(String(metrics.blockedCount||0))+'</strong></div>'+rows(blockedRows)+'</div>'
    +'<div class="metric-card"><h4>Unassigned Open</h4><div class="metric-row"><span>Count</span><strong>'+esc(String(metrics.unassignedOpenCount||0))+'</strong></div>'+rows(unassignedRows)+'</div>'
    +'<div class="metric-card"><h4>Twin Ticket Clusters</h4><div class="metric-row"><span>Count</span><strong>'+esc(String(metrics.duplicateClusterCount||0))+'</strong></div>'+rows(duplicateRows)+'</div>'
    +'<div class="metric-card"><h4>Assignee Load</h4>'+rows(assigneeRows)+'</div>'
  +'</div>';
}

function attachTicketToolbarListeners(){
  document.querySelectorAll('[data-ticket-view]').forEach(function(button){
    button.addEventListener('click',function(){
      ticketViewMode=button.getAttribute('data-ticket-view')||'table';
      renderTicketsSection(window.__monstheraTickets||[]);
    });
  });

  var actorSelect=document.getElementById('ticket-actor-select');
  if(actorSelect){
    actorSelect.addEventListener('change',function(e){
      selectedActorSessionId=e.target.value||null;
      renderTicketsSection(window.__monstheraTickets||[]);
    });
  }

  var templateSelect=document.getElementById('create-ticket-template');
  if(templateSelect){
    templateSelect.addEventListener('change',function(e){
      selectedTicketTemplateId=e.target.value||'';
    });
  }

  var applyTemplateBtn=document.getElementById('apply-ticket-template');
  if(applyTemplateBtn){
    applyTemplateBtn.addEventListener('click',function(){
      var template=getTicketTemplateById(selectedTicketTemplateId);
      if(!template){
        showToast('Select a template first','error');
        return;
      }
      applyTemplateToCreateForm(template);
      showToast('Applied template '+template.name,'success');
    });
  }

  var searchInput=document.getElementById('ticket-filter-search');
  if(searchInput){
    searchInput.addEventListener('input',function(e){
      ticketFilters.search=e.target.value||'';
      renderTicketsSection(window.__monstheraTickets||[]);
    });
  }

  ['status','severity','assignee'].forEach(function(key){
    var el=document.getElementById('ticket-filter-'+key);
    if(!el) return;
    el.addEventListener('change',function(e){
      ticketFilters[key]=e.target.value||'all';
      renderTicketsSection(window.__monstheraTickets||[]);
    });
  });

  var hideDoneToggle=document.getElementById('ticket-filter-hide-done');
  if(hideDoneToggle){
    hideDoneToggle.addEventListener('change',function(e){
      ticketFilters.hideDone=!!e.target.checked;
      renderTicketsSection(window.__monstheraTickets||[]);
    });
  }

  var createForm=document.getElementById('create-ticket-form');
  if(createForm){
    var syncCreateTicketMode=function(){
      var modeSelect=document.getElementById('create-ticket-mode');
      var humanInput=document.getElementById('create-ticket-human-name');
      var hint=document.getElementById('create-ticket-mode-hint');
      var mode=modeSelect?modeSelect.value:(ticketActors.length?'agent':'human');
      if(!ticketActors.length) mode='human';
      ticketCreateMode=mode;
      if(humanInput){
        var humanMode=mode==='human';
        humanInput.disabled=!humanMode;
        humanInput.required=humanMode;
        if(!humanMode) humanInput.value='';
      }
      if(hint){
        hint.textContent=mode==='human'
          ?'Creates the ticket as a human operator via system context. Use this when no agent session should own authorship.'
          :'Uses the selected active agent session as the ticket creator.';
      }
    };
    var createModeSelect=document.getElementById('create-ticket-mode');
    if(createModeSelect){
      createModeSelect.addEventListener('change',function(e){
        ticketCreateMode=e.target.value||'agent';
        syncCreateTicketMode();
      });
    }
    syncCreateTicketMode();

    createForm.addEventListener('submit',async function(e){
      e.preventDefault();
      var modeSelect=document.getElementById('create-ticket-mode');
      var mode=modeSelect?modeSelect.value:(ticketActors.length?'agent':'human');
      var actor=getSelectedActor();
      var humanNameInput=document.getElementById('create-ticket-human-name');
      var humanName=humanNameInput?humanNameInput.value.trim():'';
      var humanMode=!ticketActors.length||mode==='human';
      if(humanMode && !humanName){
        showToast('Enter a human name for the ticket creator','error');
        return;
      }
      if(!humanMode && !actor){
        showToast('No active session selected','error');
        return;
      }
      var submit=createForm.querySelector('button[type="submit"]');
      submit.disabled=true;
      submit.textContent='Creating...';
      try{
        var title=document.getElementById('create-ticket-title').value.trim();
        var description=document.getElementById('create-ticket-description').value.trim();
        var severity=document.getElementById('create-ticket-severity').value;
        var priority=parseInt(document.getElementById('create-ticket-priority').value||'5',10);
        var tags=document.getElementById('create-ticket-tags').value.split(',').map(function(item){return item.trim()}).filter(Boolean);
        var affectedPaths=document.getElementById('create-ticket-paths').value.split(',').map(function(item){return item.trim()}).filter(Boolean);
        var acceptanceCriteria=document.getElementById('create-ticket-criteria').value.trim();
        var created=await apiPost('tickets/create',{
          title:title,
          description:description,
          severity:severity,
          priority:isNaN(priority)?5:priority,
          tags:tags,
          affectedPaths:affectedPaths,
          acceptanceCriteria:acceptanceCriteria||null,
          ...(humanMode
            ?{humanName:humanName}
            :{agentId:actor.agentId,sessionId:actor.sessionId}),
        });
        selectedTicketId=created.ticketId;
        selectedTicketDetail=null;
        createForm.reset();
        selectedTicketTemplateId='';
        ticketCreateMode=ticketActors.length?'agent':'human';
        document.getElementById('create-ticket-severity').value='medium';
        document.getElementById('create-ticket-priority').value='5';
        syncCreateTicketMode();
        showToast('Created '+created.ticketId,'success');
        await refresh();
      }catch(err){
        showToast('Create failed: '+String(err.message||err),'error');
      }finally{
        submit.disabled=false;
        submit.textContent='Create Ticket';
      }
    });
  }
}

async function loadTicketDetail(ticketId){
  try{
    selectedTicketId=ticketId;
    selectedTicketDetail=await api('tickets/'+encodeURIComponent(ticketId));
    renderTicketDetail();
  }catch(e){
    console.error('Ticket detail load failed:',e);
    selectedTicketDetail=null;
    renderTicketDetail('Failed to load ticket details');
  }
}

function renderTicketDetail(error){
  /* Render into modal when available, else fall back to inline #ticket-detail */
  var host=document.getElementById('ticket-detail');
  var useModal=!!document.getElementById('modal-backdrop');
  if(error){
    if(useModal){openModal('<div class="modal-header"><h2>Error</h2><button class="modal-close" onclick="closeModal()">&times;</button></div><div class="modal-body"><div class="ticket-help">'+esc(error)+'</div></div>');}
    else if(host){host.innerHTML='<div class="detail-card"><div class="ticket-help">'+esc(error)+'</div></div>';}
    return;
  }
  if(!selectedTicketId){
    if(host) host.innerHTML='<div class="ticket-help">Select a ticket to view details.</div>';
    return;
  }
  if(!selectedTicketDetail){
    if(useModal){openModal('<div class="modal-header"><h2>Loading…</h2><button class="modal-close" onclick="closeModal()">&times;</button></div><div class="modal-body"><div class="ticket-help">Loading ticket details…</div></div>');}
    else if(host){host.innerHTML='<div class="detail-card"><div class="ticket-help">Loading ticket details…</div></div>';}
    return;
  }
  var t=selectedTicketDetail;
  var comments=(t.comments||[]).map(function(c){
    var tone=commentTone(c.agentId||'-');
    var persona=commentPersona(c);
    var shortLabel=agentShortLabel(c.agentName||c.agentId||'-');
    var timeMeta=formatTicketConversationTime(c.createdAt);
    return '<div class="comment-item" style="--comment-accent:'+tone.accent+';--comment-bg:'+tone.bg+'">'
      +'<div class="comment-meta">'
      +'<span class="comment-author"><span class="comment-author-swatch"></span>'+persona.emoji+' '+esc(shortLabel)+' · '+esc(persona.name)+'<span class="comment-author-id">'+(c.agentName&&c.agentName!==c.agentId?'('+esc(c.agentId||'-')+')':'')+'</span></span>'
      +'<span class="comment-time" title="'+esc(timeMeta.title)+'">'+esc(timeMeta.label)+'</span>'
      +'</div><div class="comment-content">'+esc(c.content||'')+'</div></div>';
  }).join('')||'<div class="ticket-help">No comments yet.</div>';
  var history=(t.history||[]).map(function(h){
    var change=(h.fromStatus?h.fromStatus+' → ':'')+h.toStatus;
    var note=h.comment?'<div class="history-content">'+esc(h.comment)+'</div>':'';
    return '<div class="history-item"><div class="history-meta"><span>'+esc(change)+'</span><span>'+esc(h.agentId||'-')+'</span><span>'+esc(new Date(h.timestamp).toLocaleString())+'</span></div>'+note+'</div>';
  }).join('')||'<div class="ticket-help">No history yet.</div>';
  var patches=(t.linkedPatches||[]).map(function(p){
    return '<div class="patch-item"><div class="patch-meta"><span>'+esc(p.proposalId)+'</span><span>'+esc(p.agentId||'-')+'</span><span>'+esc(new Date(p.createdAt).toLocaleString())+'</span></div><div class="patch-content">'+esc(p.message||'')+'</div></div>';
  }).join('')||'<div class="ticket-help">No linked patches.</div>';
  var tags=(t.tags||[]).length?(t.tags||[]).join(', '):'-';
  var affectedPaths=(t.affectedPaths||[]).length?(t.affectedPaths||[]).join(', '):'-';
  var resolutionCommits=(t.resolutionCommitShas||[]).length?(t.resolutionCommitShas||[]):(t.commitSha?[t.commitSha]:[]);
  var commitLabel=resolutionCommits.length>1?'Commits':'Commit';
  var commitValue=resolutionCommits.length?resolutionCommits.map(function(sha){return esc((sha||'-').slice(0,7));}).join(', '):'-';
  var quorumSection=renderTicketQuorumDetail(t.quorum);
  var duplicateSection=(function(){
    if(!t.duplicateSignal) return '';
    var clusters=(t.duplicateSignal.clusters||[]).map(function(cluster){
      return (cluster.tickets||[]).map(function(peer){
        return '<div class="edge-meta-item"><div class="edge-meta-top"><span><a href="#" class="dep-link" data-ticket="'+esc(peer.ticketId)+'">'+esc(peer.ticketId)+'</a> · '+esc(peer.status)+'</span><span class="edge-meta-score">'+esc(String(Math.round((cluster.score||0)*100)))+'%</span></div><div class="edge-meta-note">'+esc(peer.title)+(cluster.reasons&&cluster.reasons.length?'<br>'+esc(cluster.reasons.join(' · ')):'')+'</div></div>';
      }).join('');
    }).join('');
    return '<div class="detail-section"><h4>Twin Ticket Signal</h4><div class="detail-block"><div class="detail-label">Suspicious Cluster</div><div class="detail-value"><span class="badge badge-orange">Cluster x'+esc(String(t.duplicateSignal.peerCount||0))+'</span> <span class="badge badge-red">'+esc(String(Math.round((t.duplicateSignal.score||0)*100)))+'% match</span><br>'+esc((t.duplicateSignal.reasons||[]).join(' · '))+'</div></div>'+(clusters?'<div class="edge-meta-list" style="margin-top:.65rem">'+clusters+'</div>':'')+'</div>';
  })();
  var actor=getSelectedActor();
  var assigneeOptions=dashboardAgents.map(function(agent){
    return '<option value="'+esc(agent.id)+'"'+(t.assigneeAgentId===agent.id?' selected':'')+'>'+esc(agent.name+' ('+agent.role+')')+'</option>';
  }).join('');
  var availableTransitions=TICKET_TRANSITIONS[t.status]||[];
  var canBlock=availableTransitions.includes('blocked');
  var isBlocked=t.status==='blocked';
  var restoreStatus=isBlocked?getBlockedRestoreStatus(t):null;
  var transitionOptions=availableTransitions.filter(function(status){return status!=='blocked';});
  var statusOptions=transitionOptions.map(function(status){
    return '<option value="'+esc(status)+'">'+esc(status)+'</option>';
  }).join('');
  var blockControl='<label class="ticket-block-toggle'+(((canBlock&&!isBlocked)||(isBlocked&&restoreStatus))?'':' disabled')+'" title="'+esc(
    isBlocked
      ?(restoreStatus?'Return ticket to '+ticketStatusLabel(restoreStatus):'This ticket is already blocked')
      : canBlock
        ?'Block this ticket'
        : 'Blocking is not available from this status'
  )+'"><input id="ticket-block-toggle" type="checkbox" aria-label="Block ticket"'+(isBlocked?' checked':'')+((((canBlock&&!isBlocked)||(isBlocked&&restoreStatus))?'':' disabled'))+'><span>Blocked</span></label>';
  var actionCards=[];
  if(actor){
    actionCards.push('<form class="action-card" id="assign-ticket-form"><h4>Assign</h4><div class="actor-chip">Acting as '+esc(actorLabel(actor))+'</div><div class="field"><label for="ticket-assignee-select">Assignee</label><select id="ticket-assignee-select">'+assigneeOptions+'</select></div><button class="action-submit" type="submit">Assign Ticket</button></form>');
    actionCards.push('<form class="action-card" id="status-ticket-form"><h4>Transition</h4><div class="actor-chip">Acting as '+esc(actorLabel(actor))+'</div><div class="field"><label for="ticket-status-select">Next Status</label><select id="ticket-status-select"'+(statusOptions?'':' disabled')+'>'+(statusOptions||'<option value="">No other transitions available</option>')+'</select></div><div class="field"><label for="ticket-status-comment">Comment</label><textarea id="ticket-status-comment" maxlength="500" placeholder="Optional transition note"></textarea></div><button class="action-submit" type="submit"'+(statusOptions?'':' disabled')+'>Update Status</button></form>');
    actionCards.push('<form class="action-card" id="comment-ticket-form"><h4>Add Comment</h4><div class="actor-chip">Acting as '+esc(actorLabel(actor))+'</div><div class="field"><label for="ticket-comment-content">Comment</label><textarea id="ticket-comment-content" maxlength="${MAX_TICKET_LONG_TEXT_LENGTH}" placeholder="Provide context for the next agent"></textarea></div><button class="action-submit" type="submit">Post Comment</button></form>');
  }
  var actionsHtml=actionCards.length
    ?'<div class="action-grid">'+actionCards.join('')+'</div>'
    :'<div class="ticket-help">No active session selected.</div>';
  var headBadges='<span class="badge badge-'+(TICKET_STATUS_CLS[t.status]||'blue')+'">'+esc(t.status)+'</span>'+(t.quorum?(' <span class="badge badge-'+esc((t.quorum.progress&&t.quorum.progress.state)||'blue')+'" title="'+esc((t.quorum.progress&&t.quorum.progress.title)||'Quorum progress')+'">'+esc((t.quorum.progress&&t.quorum.progress.label)||'-')+'</span>'):'');
  var detailContent=''
    +'<div class="detail-head"><div><div class="detail-title">'+esc(t.title||t.ticketId)+'</div><div class="detail-sub"><span>'+esc(t.ticketId)+'</span><span>'+esc(new Date(t.updatedAt).toLocaleString())+'</span></div></div><div class="detail-controls"><div>'+headBadges+'</div>'+blockControl+'</div></div>'
    +'<div class="detail-grid">'
    +'<div class="detail-block"><div class="detail-label">Description</div><div class="detail-value">'+esc(t.description||'-')+'</div></div>'
    +'<div class="detail-block"><div class="detail-label">Acceptance Criteria</div><div class="detail-value">'+esc(t.acceptanceCriteria||'-')+'</div></div>'
    +'<div class="detail-block"><div class="detail-label">Ownership</div><div class="detail-value">Creator: '+esc(t.creatorAgentId||'-')+'<br>Assignee: '+esc(t.assigneeAgentId||'-')+'</div></div>'
    +'<div class="detail-block"><div class="detail-label">Context</div><div class="detail-value">Severity: '+esc(t.severity||'-')+'<br>Priority: '+esc(String(t.priority??'-'))+'<br>'+commitLabel+': '+commitValue+'</div></div>'
    +(function(){var hint=t.nextActionHint;if(!hint)return '';var cls=hint.kind==='reviewer'?'purple':hint.kind==='assignee'?'blue':'orange';var actorName=hint.agentName?' · '+hint.agentName:'';return '<div class="detail-block"><div class="detail-label">Next Action (Heuristic)</div><div class="detail-value"><span class="badge badge-'+cls+'">'+esc(hint.label+actorName)+'</span><br>'+esc(hint.reason||'')+'</div></div>';})()
    +(t.humanActionRequired?'<div class="detail-block"><div class="detail-label">Human Action Required</div><div class="detail-value"><span class="badge badge-orange">'+esc(humanActionReasonLabel(t.humanActionReason))+'</span></div></div>':'')
    +'<div class="detail-block"><div class="detail-label">Tags</div><div class="detail-value">'+esc(tags)+'</div></div>'
    +'<div class="detail-block"><div class="detail-label">Affected Paths</div><div class="detail-value">'+esc(affectedPaths)+'</div></div>'
    +(function(){var deps=t.dependencies;if(!deps)return '';var parts=[];if(deps.blocking&&deps.blocking.length)parts.push('Blocks: '+deps.blocking.map(function(id){return '<a href="#" class="dep-link" data-ticket="'+esc(id)+'">'+esc(id)+'</a>';}).join(', '));if(deps.blockedBy&&deps.blockedBy.length)parts.push('Blocked by: '+deps.blockedBy.map(function(id){return '<a href="#" class="dep-link" data-ticket="'+esc(id)+'">'+esc(id)+'</a>';}).join(', '));if(deps.relatedTo&&deps.relatedTo.length)parts.push('Related: '+deps.relatedTo.map(function(id){return '<a href="#" class="dep-link" data-ticket="'+esc(id)+'">'+esc(id)+'</a>';}).join(', '));if(!parts.length)return '<div class="detail-block"><div class="detail-label">Dependencies</div><div class="detail-value">-</div></div>';return '<div class="detail-block"><div class="detail-label">Dependencies</div><div class="detail-value">'+parts.join('<br>')+'</div></div>';})()
    +'</div>'
    +quorumSection
    +duplicateSection
    +'<div class="detail-section"><h4>Actions</h4>'+actionsHtml+'</div>'
    +'<div class="detail-section"><h4>Comments</h4><div class="comment-list">'+comments+'</div></div>'
    +'<div class="detail-section"><h4>History</h4><div class="history-list">'+history+'</div></div>'
    +'<div class="detail-section"><h4>Linked Patches</h4><div class="patch-list">'+patches+'</div></div>';
  if(useModal){
    openModal('<div class="modal-header"><h2>'+esc(t.ticketId)+' '+headBadges+'</h2><button class="modal-close" onclick="closeModal()">&times;</button></div><div class="modal-body"><div class="detail-card" id="ticket-detail">'+detailContent+'</div></div>');
  }else if(host){
    host.innerHTML='<div class="detail-card">'+detailContent+'</div>';
  }
  attachTicketDetailListeners(t);
}

function renderTicketsSection(tickets,metrics){
  var section=document.getElementById('tickets');
  var filteredTickets=filterTicketList(tickets);
  window.__monstheraTickets=tickets;
  window.__monstheraTicketMetrics=metrics||window.__monstheraTicketMetrics||null;
  section.innerHTML='';
  section.insertAdjacentHTML('beforeend',renderTicketMetrics(window.__monstheraTicketMetrics));
  section.insertAdjacentHTML('beforeend',renderTicketToolbar(tickets,filteredTickets));
  if(!filteredTickets.some(function(ticket){return ticket.ticketId===selectedTicketId})){
    selectedTicketId=null;
    selectedTicketDetail=null;
  }
  if(!filteredTickets.length){
    section.appendChild(makeTable(['ID','Title','Status','Severity','Priority','Assignee','Creator','Updated'],[]));
    var emptyDetail=document.createElement('div');
    emptyDetail.id='ticket-detail';
    section.appendChild(emptyDetail);
    attachTicketToolbarListeners();
    renderTicketDetail();
    return filteredTickets;
  }
  if(ticketViewMode==='board'){
    var board=document.createElement('div');
    board.className='board-wrap';
    var boardColumns=hideDoneTicketsActive()
      ? TICKET_BOARD_COLUMNS.filter(function(column){return column.id!=='done';})
      : TICKET_BOARD_COLUMNS;
    boardColumns.forEach(function(column){
      var columnTickets=filteredTickets.filter(function(ticket){return column.statuses.includes(ticket.status)});
      var col=document.createElement('div');
      col.className='board-column';
      col.innerHTML='<div class="board-column-head"><div class="board-column-headline"><div class="board-column-title">'+esc(column.label)+'</div><div class="board-column-count">'+esc(String(columnTickets.length))+'</div></div>'+buildBoardColumnSummary(column,columnTickets)+'</div>';
      var list=document.createElement('div');
      list.className='board-list';
      if(!columnTickets.length){
        list.innerHTML='<div class="ticket-help">No tickets</div>';
      }else{
        columnTickets.forEach(function(ticket){
          var card=document.createElement('div');
          card.className='board-card'+(selectedTicketId===ticket.ticketId?' active':'');
          card.addEventListener('click',function(){loadTicketDetail(ticket.ticketId)});
          var flags=[];
          if(ticket.isHighPriority){
            flags.push('<span class="badge badge-cyan">P7+</span>');
          }
          if(!ticket.assignee){
            flags.push('<span class="badge badge-orange">Unassigned</span>');
          }
          if(ticket.inReviewStale){
            var reviewTitle=ticket.lastReviewActivityAt
              ?'Last review activity '+formatTicketConversationTime(ticket.lastReviewActivityAt).title
              :'No recent review activity';
            flags.push('<span class="badge badge-red" title="'+esc(reviewTitle)+'">Review stale</span>');
          }
        if(ticket.quorumBadge){
          flags.push('<span class="badge badge-'+esc(ticket.quorumState||'blue')+'" title="'+esc(ticket.quorumTitle||ticket.quorumBadge)+'">'+esc(ticket.quorumBadge)+'</span>');
        }
        if(ticket.suspiciousDuplicate){
          flags.push('<span class="badge badge-orange" title="'+esc(ticket.duplicateTitle||'Suspicious duplicate cluster')+'">Twin x'+esc(String(ticket.duplicatePeerCount||1))+'</span>');
        }
        if(ticket.humanActionRequired){
          var har=humanActionReasonLabel(ticket.humanActionReason);
          flags.push('<span class="badge badge-orange" title="'+esc(har)+'">Human action</span>');
        }
          card.innerHTML='<div class="board-card-sub">'+esc(ticket.ticketId)+'</div>'
            +'<div class="board-card-title">'+esc(ticket.title)+'</div>'
            +(flags.length?'<div class="board-card-flags">'+flags.join('')+'</div>':'')
            +'<div class="board-card-meta"><span class="badge badge-'+(TICKET_STATUS_CLS[ticket.status]||'blue')+'">'+esc(ticket.status)+'</span><span class="badge badge-'+(ticket.severity==='critical'?'red':ticket.severity==='high'?'orange':'blue')+'">'+esc(ticket.severity)+'</span><span>P'+esc(String(ticket.priority))+'</span></div>'
            +'<div class="board-card-meta"><span>'+(ticket.assignee?esc(ticket.assignee):'unassigned')+'</span><span>'+esc(new Date(ticket.updatedAt).toLocaleDateString())+'</span><span>'+esc(ticketStatusLabel(ticket.status))+' '+esc(formatStatusAge(ticket.statusAgeDays,ticket.statusAgeHours))+'</span></div>'
            +(ticket.inReviewStale?'<div class="board-card-meta"><span title="'+esc(ticket.lastReviewActivityAt?formatTicketConversationTime(ticket.lastReviewActivityAt).title:'No recent review activity')+'">'+esc(formatIdleLabel(ticket.inReviewIdleDays,ticket.inReviewIdleHours))+'</span></div>':'')
            +buildAgentBadgesHtml(ticket);
          if(ticket.agents&&ticket.agents.some(function(a){return a.presence==='online'})){
            card.classList.add('has-active-agent');
          }
          list.appendChild(card);
        });
      }
      col.appendChild(list);
      board.appendChild(col);
    });
    section.appendChild(board);
  }else{
    var showQuorumColumn=filteredTickets.some(function(ticket){return !!ticket.quorumBadge});
    var showDuplicateColumn=filteredTickets.some(function(ticket){return !!ticket.suspiciousDuplicate});
    var showHumanActionColumn=filteredTickets.some(function(ticket){return !!ticket.humanActionRequired});
    var wrap=document.createElement('div');
    wrap.className='table-wrap';
    var table=document.createElement('table');
    var thead=document.createElement('thead');
    var hr=document.createElement('tr');
    ['ID','Title','Status'].concat(showQuorumColumn?['Quorum']:[]).concat(showDuplicateColumn?['Twin Risk']:[]).concat(showHumanActionColumn?['Human Action']:[]).concat(['Severity','Priority','Assignee','Creator','Age','Updated']).forEach(function(h){var th=document.createElement('th');th.textContent=h;hr.appendChild(th)});
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody=document.createElement('tbody');
    filteredTickets.forEach(function(t){
      var tr=document.createElement('tr');
      tr.className='clickable'+(selectedTicketId===t.ticketId?' active':'');
      tr.addEventListener('click',function(){loadTicketDetail(t.ticketId)});
      var cells=[
        m(t.ticketId),
        t.title.slice(0,60),
        b(t.status,TICKET_STATUS_CLS[t.status]||'blue'),
      ];
      if(showQuorumColumn){
        cells.push(t.quorumBadge?{badge:t.quorumBadge,cls:t.quorumState||'blue',title:t.quorumTitle||t.quorumBadge}:'-');
      }
      if(showDuplicateColumn){
        cells.push(t.suspiciousDuplicate
          ? {badge:'Cluster x'+String(t.duplicatePeerCount||1),cls:'orange',title:t.duplicateTitle||'Suspicious duplicate cluster'}
          : '-');
      }
      if(showHumanActionColumn){
        cells.push(t.humanActionRequired
          ? {badge:'Human action',cls:'orange',title:humanActionReasonLabel(t.humanActionReason)}
          : '-');
      }
      cells=cells.concat([
        b(t.severity,t.severity==='critical'?'red':t.severity==='high'?'orange':'blue'),
        t.priority,
        t.assignee||'-',
        t.creator||'-',
        ticketAgeCell(t),
        new Date(t.updatedAt).toLocaleString(),
      ]);
      cells.forEach(function(cell){
        var td=document.createElement('td');
        if(typeof cell==='object'&&cell&&cell.badge){var s=document.createElement('span');s.className='badge badge-'+cell.cls;s.textContent=cell.badge;td.appendChild(s);if(cell.text){td.appendChild(document.createTextNode(' '+String(cell.text)));}if(cell.title){td.title=String(cell.title);}}
        else if(typeof cell==='object'&&cell&&cell.mono){td.className='mono';td.textContent=cell.mono;}
        else{td.textContent=String(cell);}
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    section.appendChild(wrap);
  }
  var detail=document.createElement('div');
  detail.id='ticket-detail';
  section.appendChild(detail);
  attachTicketToolbarListeners();
  renderTicketDetail();
  return filteredTickets;
}

function humanActionReasonLabel(reason){
  switch(reason){
    case 'active_unassigned': return 'Needs assignment';
    case 'ready_for_commit_unassigned': return 'Commit owner needed';
    case 'lifecycle_guard_blocked': return 'Lifecycle guard blocked';
    case 'quorum_waiting_on_human': return 'Awaiting council';
    case 'veto_blocked': return 'Veto blocked';
    default: return 'Human action required';
  }
}

function attachTicketDetailListeners(ticket){
  document.querySelectorAll('.dep-link').forEach(function(link){
    link.addEventListener('click',function(e){
      e.preventDefault();
      var depTicketId=link.getAttribute('data-ticket');
      if(depTicketId) loadTicketDetail(depTicketId);
    });
  });
  var actor=getSelectedActor();
  var blockToggle=document.getElementById('ticket-block-toggle');
  if(blockToggle&&!blockToggle.disabled){
    blockToggle.addEventListener('change',async function(){
      var restoreStatus=getBlockedRestoreStatus(ticket);
      var wasBlocked=ticket.status==='blocked';
      var targetStatus=blockToggle.checked?'blocked':restoreStatus;
      if(!targetStatus){
        blockToggle.checked=wasBlocked;
        return;
      }
      blockToggle.disabled=true;
      try{
        await apiPost('tickets/'+encodeURIComponent(ticket.ticketId)+'/status',{
          status:targetStatus,
          ...(actor
            ?{
                agentId:actor.agentId,
                sessionId:actor.sessionId,
              }
            :{humanName:'dashboard operator'}),
        });
        showToast('Updated '+ticket.ticketId+' to '+targetStatus,'success');
        await refresh();
      }catch(err){
        blockToggle.checked=wasBlocked;
        blockToggle.disabled=false;
        showToast('Blocked toggle failed: '+String(err.message||err),'error');
      }
    });
  }

  if(!actor) return;

  var assignForm=document.getElementById('assign-ticket-form');
  if(assignForm){
    assignForm.addEventListener('submit',async function(e){
      e.preventDefault();
      var submit=assignForm.querySelector('button[type="submit"]');
      submit.disabled=true;
      submit.textContent='Assigning...';
      try{
        var assigneeAgentId=document.getElementById('ticket-assignee-select').value;
        await apiPost('tickets/'+encodeURIComponent(ticket.ticketId)+'/assign',{
          assigneeAgentId:assigneeAgentId,
          agentId:actor.agentId,
          sessionId:actor.sessionId,
        });
        showToast('Assigned '+ticket.ticketId,'success');
        await refresh();
      }catch(err){
        showToast('Assign failed: '+String(err.message||err),'error');
      }finally{
        submit.disabled=false;
        submit.textContent='Assign Ticket';
      }
    });
  }

  var statusForm=document.getElementById('status-ticket-form');
  if(statusForm){
    statusForm.addEventListener('submit',async function(e){
      e.preventDefault();
      var submit=statusForm.querySelector('button[type="submit"]');
      submit.disabled=true;
      submit.textContent='Updating...';
      try{
        var status=document.getElementById('ticket-status-select').value;
        var comment=document.getElementById('ticket-status-comment').value.trim();
        await apiPost('tickets/'+encodeURIComponent(ticket.ticketId)+'/status',{
          status:status,
          comment:comment||null,
          agentId:actor.agentId,
          sessionId:actor.sessionId,
        });
        showToast('Updated '+ticket.ticketId+' to '+status,'success');
        await refresh();
      }catch(err){
        showToast('Status update failed: '+String(err.message||err),'error');
      }finally{
        submit.disabled=false;
        submit.textContent='Update Status';
      }
    });
  }

  var commentForm=document.getElementById('comment-ticket-form');
  if(commentForm){
    commentForm.addEventListener('submit',async function(e){
      e.preventDefault();
      var submit=commentForm.querySelector('button[type="submit"]');
      submit.disabled=true;
      submit.textContent='Posting...';
      try{
        var content=document.getElementById('ticket-comment-content').value.trim();
        await apiPost('tickets/'+encodeURIComponent(ticket.ticketId)+'/comment',{
          content:content,
          agentId:actor.agentId,
          sessionId:actor.sessionId,
        });
        document.getElementById('ticket-comment-content').value='';
        showToast('Comment added to '+ticket.ticketId,'success');
        await refresh();
      }catch(err){
        showToast('Comment failed: '+String(err.message||err),'error');
      }finally{
        submit.disabled=false;
        submit.textContent='Post Comment';
      }
    });
  }
}

/* ── Chart panels ────────────────────────────── */
function renderCharts(overview,logs,patches,knowledge,presence,indexedFiles){
  var container=document.getElementById('charts');
  var colorMap={blue:'#3b82f6',green:'#22c55e',purple:'#a855f7',cyan:'#06b6d4',orange:'#f59e0b',red:'#ef4444'};
  var onlineAgents=(presence||[]).filter(function(agent){return agent.status==='online'}).length;
  var activeSessions=(presence||[]).reduce(function(total,agent){
    return total+(agent.sessions||[]).filter(function(session){return session.state==='active'}).length;
  },0);
  var successCount=logs.filter(function(l){return l.status==='success'}).length;
  var avgDuration=logs.length?Math.round(logs.reduce(function(total,log){return total+(Number(log.durationMs)||0)},0)/logs.length):0;

  /* Activity sparkline */
  var hourBuckets=bucketByHour(logs.map(function(l){return l.timestamp}));
  var sparkPanel=makeChartPanel(
    'Activity (24h)',
    'blue',
    colorMap,
    '<div class="chart-stack"><div style="width:100%">'+(logs.length?makeSparkline(hourBuckets,320,55):mkEmpty('No recent event logs'))+'</div>'
      +makeIndicators([
        {label:'Events',value:logs.length},
        {label:'Success',value:(logs.length?Math.round((successCount/logs.length)*100):0)+'%'},
        {label:'Avg ms',value:avgDuration},
        {label:'Live',value:onlineAgents+'/'+activeSessions},
      ])
    +'</div>'
  );

  /* Tool usage donut */
  var toolCounts={};
  logs.forEach(function(l){toolCounts[l.tool]=(toolCounts[l.tool]||0)+1});
  var toolData=Object.entries(toolCounts).sort(function(a,b){return b[1]-a[1]}).slice(0,8).map(function(e,i){return{label:e[0],value:e[1],color:PALETTE[i%PALETTE.length]}});
  var topTool=toolData.length?toolData[0].label:'none';
  var failureCount=logs.filter(function(l){return l.status!=='success'}).length;
  var toolPanel=makeChartPanel(
    'Tool Usage',
    'purple',
    colorMap,
    '<div class="chart-stack">'
      +'<div class="chart-body">'+(toolData.length?makeDonut(toolData,100,16):mkEmpty('No tool logs yet'))+'<div class="chart-legend">'+(toolData.length?makeLegend(toolData):'<div class="chart-empty">Usage appears here after tool calls are logged.</div>')+'</div></div>'
      +makeIndicators([
        {label:'Tools',value:Object.keys(toolCounts).length},
        {label:'Top tool',value:topTool},
        {label:'Failures',value:failureCount},
      ])
    +'</div>'
  );

  /* Indexed files by language */
  var fileData=(indexedFiles.topLanguages||[]).map(function(entry,i){
    return {label:entry.label,value:entry.count,color:PALETTE[i%PALETTE.length]};
  });
  var secretPatternData=(indexedFiles.topSecretPatterns||[]).map(function(entry,i){
    return {label:entry.label,value:entry.count,color:PALETTE[(i+3)%PALETTE.length]};
  });
  var topBucket=fileData.length?fileData[0].label:'none';
  var filesPanel=makeChartPanel(
    'Indexed Files',
    'orange',
    colorMap,
    '<div class="chart-stack">'
      +(fileData.length?makeBarChart(fileData,240,18,5):mkEmpty('No indexed files'))
      +(indexedFiles.secretFiles
        ?'<div class="chart-legend">'+(secretPatternData.length?makeLegend(secretPatternData):'<div class="item">Secret hits detected but patterns were not parsed.</div>')+'</div>'
        :'<div class="chart-empty">No indexed secret hits</div>')
      +makeIndicators([
        {label:'Indexed',value:indexedFiles.totalFiles||overview.fileCount||0},
        {label:'Buckets',value:indexedFiles.uniqueBuckets||0},
        {label:'Top',value:topBucket},
        {label:'Secrets',value:indexedFiles.secretFiles||0},
        {label:'Unknown',value:indexedFiles.unknownFiles||0},
      ])
    +'</div>'
  );

  /* Knowledge by type bars */
  var typeCounts={};
  knowledge.forEach(function(k){typeCounts[k.type]=(typeCounts[k.type]||0)+1});
  var typeData=Object.entries(typeCounts).sort(function(a,b){return b[1]-a[1]}).map(function(e){return{label:e[0],value:e[1],color:TYPE_COLORS[e[0]]||'#3b82f6'}});
  var kPanel=makeChartPanel('Knowledge Types','cyan',colorMap,typeData.length?makeBarChart(typeData,240,18,5):mkEmpty());

  container.replaceChildren(sparkPanel,toolPanel,filesPanel,kPanel);
}

function makeChartPanel(title,dotColor,colorMap,bodyHtml){
  var panel=document.createElement('div');
  panel.className='chart-panel';
  panel.innerHTML='<div class="chart-title"><span class="dot" style="background:'+(colorMap[dotColor]||'#3b82f6')+'"></span>'+esc(title)+'</div>'+bodyHtml;
  return panel;
}

function bucketByHour(timestamps){
  var now=Date.now();
  var buckets=[];for(var i=0;i<24;i++)buckets.push(0);
  timestamps.forEach(function(ts){
    var age=(now-new Date(ts).getTime())/3600000;
    if(age>=0&&age<24){buckets[23-Math.floor(age)]++;}
  });
  return buckets;
}

/* ── Time ago helper ─────────────────────────── */
function timeAgo(iso){
  if(!iso) return 'never';
  var s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if(s<5) return 'just now';
  if(s<60) return s+'s ago';
  var m=Math.floor(s/60);
  if(m<60) return m+'m ago';
  var h=Math.floor(m/60);
  if(h<24) return h+'h ago';
  return Math.floor(h/24)+'d ago';
}

/* ── Presence rendering ─────────────────────── */
var STATUS_ORDER={online:0,idle:1,offline:2};

function renderPresence(agents){
  var container=document.getElementById('presence');
  if(!agents||!agents.length){
    container.innerHTML='<div class="empty" style="width:100%">No agents registered yet</div>';
    return;
  }
  agents.sort(function(a,b){return (STATUS_ORDER[a.status]||9)-(STATUS_ORDER[b.status]||9)});
  container.innerHTML='';
  agents.forEach(function(a){
    var card=document.createElement('div');
    card.className='agent-card';
    var lastActivity=null;
    var claimedFiles=[];
    if(a.sessions&&a.sessions.length){
      var active=a.sessions.filter(function(s){return s.status==='online'||s.status==='idle'});
      var best=active.length?active[0]:a.sessions[0];
      lastActivity=best.lastActivity;
      a.sessions.forEach(function(s){if(s.claimedFiles)claimedFiles=claimedFiles.concat(s.claimedFiles)});
    }
    var filesHtml=claimedFiles.length?'<div class="agent-files">&#128196; '+esc(claimedFiles.slice(0,3).join(', '))+(claimedFiles.length>3?' +'+String(claimedFiles.length-3)+' more':'')+'</div>':'';
    var sessionCount=a.sessions?a.sessions.length:0;
    card.innerHTML='<div class="status-dot '+esc(a.status)+'"></div><div class="agent-info"><div class="agent-name">'+esc(a.name)+'</div><div class="agent-meta"><span class="badge badge-'+esc(a.role)+'">'+esc(a.role)+'</span><span class="badge badge-'+(a.trustTier==='A'?'blue':'orange')+'">Tier '+esc(a.trustTier)+'</span><span>'+esc(a.type)+'</span><span>'+sessionCount+' sess</span></div><div class="agent-time">'+timeAgo(lastActivity)+'</div>'+filesHtml+'</div>';
    container.appendChild(card);
  });
}

/* ── Activity Timeline (enriched) ──────────── */
/* NOTE: All user-facing data is passed through esc() (HTML entity escaping) */
/* Data originates from server-side DB queries, not raw user input */
var activityTimelineData=[];

function atlIcon(type){
  if(type.startsWith('ticket_verdict')) return '&#x1F5F3;';
  if(type==='ticket_created') return '&#x1F3AB;';
  if(type==='ticket_status_changed') return '&#x27A1;';
  if(type==='ticket_commented') return '&#x1F4AC;';
  if(type==='ticket_assigned'||type==='ticket_unassigned') return '&#x1F464;';
  if(type==='ticket_linked') return '&#x1F517;';
  if(type==='ticket_auto_transitioned') return '&#x26A1;';
  if(type==='patch_proposed') return '&#x1F4E6;';
  if(type==='note_added') return '&#x1F4DD;';
  if(type==='knowledge_stored') return '&#x1F4DA;';
  if(type.startsWith('job_slot')) return '&#x1F3AF;';
  if(type==='job_loop_created') return '&#x1F504;';
  if(type==='job_progress_update') return '&#x1F4CA;';
  if(type==='agent_registered') return '&#x1F916;';
  if(type==='index_updated') return '&#x1F50D;';
  return '&#x25CF;';
}

function atlTimeSep(prev,curr){
  if(!prev) return '';
  var pDate=new Date(prev);
  var cDate=new Date(curr);
  var diffMs=pDate.getTime()-cDate.getTime();
  if(diffMs<5*60*1000) return '';
  var diffMin=Math.floor(diffMs/60000);
  var label='';
  if(diffMin<60) label=diffMin+' min gap';
  else if(diffMin<1440) label=Math.floor(diffMin/60)+'h '+diffMin%60+'m gap';
  else label=Math.floor(diffMin/1440)+'d ago';
  return '<tr><td colspan="5" class="atl-time-sep"><span>'+esc('— '+label+' —')+'</span></td></tr>';
}

function renderActivityTimeline(data){
  activityTimelineData=data||[];
  var section=document.getElementById('activity-timeline');
  if(!section) return;
  if(!data||!data.length){
    section.textContent='No activity recorded yet';
    return;
  }
  var rows='';
  var prevTs=null;
  for(var i=0;i<data.length;i++){
    var ev=data[i];
    rows+=atlTimeSep(prevTs,ev.timestamp);
    prevTs=ev.timestamp;

    var icon='<span class="atl-icon">'+atlIcon(ev.type)+'</span>';
    var catBar='<span class="atl-cat '+esc(ev.category||'system')+'"></span>';

    /* Agent column: name + role badge */
    var agentHtml='<span class="atl-agent-name">'+esc(ev.agentName||'-')+'</span>';
    if(ev.agentRole) agentHtml+='<span class="atl-role '+esc(ev.agentRole)+'">'+esc(ev.agentRole)+'</span>';

    /* Action column: icon + readable action */
    var actionHtml=catBar+icon+esc(ev.action||ev.type.replace(/_/g,' '));

    /* Verdict enrichment */
    if(ev.type==='ticket_verdict_submitted'&&ev.detail){
      var parts=ev.detail.split(' \xB7 ');
      var spec=parts[0]||'';
      var verd=parts[1]||'';
      var quorum=parts[2]||'';
      var excerpt=parts.slice(3).join(' \xB7 ')||'';
      actionHtml=catBar+icon+'voted <span class="atl-verdict '+esc(verd.toLowerCase())+'">'+esc(verd)+'</span> as '+esc(spec);
      if(quorum) actionHtml+=' <span style="color:var(--text3);font-size:.6rem">('+esc(quorum)+')</span>';
      if(excerpt) actionHtml+='<div class="atl-detail" title="'+esc(excerpt)+'">'+esc(excerpt)+'</div>';
    }

    /* Patch stats enrichment */
    if(ev.type==='patch_proposed'&&ev.detail){
      actionHtml=catBar+icon+'proposed patch';
      actionHtml+='<div class="atl-detail">'+esc(ev.detail)+'</div>';
    }

    /* Ticket column: ID + status pill */
    var ticketHtml='-';
    if(ev.ticketId){
      ticketHtml='<span class="atl-ticket-link" onclick="selectedTicketId=\\x27'+esc(ev.ticketId)+'\\x27;navigate(\\x27tickets\\x27)">'+esc(ev.ticketId.slice(0,12))+'</span>';
      if(ev.ticketStatus) ticketHtml+=' <span class="atl-status '+esc(ev.ticketStatus)+'">'+esc(ev.ticketStatus.replace(/_/g,' '))+'</span>';
    }

    /* Detail column */
    var detailHtml='';
    if(ev.detail&&ev.type!=='ticket_verdict_submitted'&&ev.type!=='patch_proposed'){
      detailHtml='<span class="atl-detail" style="display:inline" title="'+esc(ev.detail)+'">'+esc(ev.detail)+'</span>';
    }

    /* Time column */
    var evDate=new Date(ev.timestamp);
    var now=new Date();
    var diffSec=Math.floor((now.getTime()-evDate.getTime())/1000);
    var timeLabel='';
    if(diffSec<60) timeLabel=diffSec+'s ago';
    else if(diffSec<3600) timeLabel=Math.floor(diffSec/60)+'m ago';
    else if(diffSec<86400) timeLabel=Math.floor(diffSec/3600)+'h ago';
    else timeLabel=evDate.toLocaleDateString();

    rows+='<tr>'
      +'<td style="white-space:nowrap;color:var(--text3);font-size:.65rem" title="'+esc(evDate.toLocaleString())+'">'+esc(timeLabel)+'</td>'
      +'<td>'+agentHtml+'</td>'
      +'<td>'+actionHtml+'</td>'
      +'<td>'+ticketHtml+'</td>'
      +'<td>'+detailHtml+'</td>'
      +'</tr>';
  }

  section.innerHTML='<div class="atl-wrap"><table class="atl-table">'
    +'<thead><tr><th>Time</th><th>Agent</th><th>Action</th><th>Ticket</th><th>Detail</th></tr></thead>'
    +'<tbody>'+rows+'</tbody>'
    +'</table></div>';
}

function renderAgentTimelineSection(timeline){
  var section=document.getElementById('timeline');
  if(!timeline||!timeline.length){
    section.innerHTML='<div class="empty">No agent activity logged yet</div>';
    return;
  }
  section.innerHTML='<div class="timeline-grid">'+timeline.map(function(agent){
    var events=(agent.events||[]).map(function(event){
      var detail=event.errorDetail
        ?'<div class="timeline-event-summary"><strong>'+esc(event.errorCode||'issue')+':</strong> '+esc(event.errorDetail)+'</div>'
        :'';
      return '<div class="timeline-event">'
        +'<div class="timeline-event-head"><span class="timeline-event-tool">'+esc(event.tool)+'</span><span>'+esc(new Date(event.timestamp).toLocaleString())+'</span></div>'
        +'<div class="timeline-event-head"><span><span class="badge badge-'+eventStatusClass(event.status)+'">'+esc(event.status)+'</span></span><span>'+esc(event.durationMs)+'ms · '+esc((event.sessionId||'-').slice(0,12))+'</span></div>'
        +'<div class="timeline-event-summary">'+esc(event.redactedSummary||'No summary captured')+'</div>'
        +detail
      +'</div>';
    }).join('')||'<div class="ticket-help">No recent events.</div>';
    return '<div class="timeline-card">'
      +'<div class="timeline-head"><div><div class="timeline-title">'+esc(agent.name)+'</div><div class="timeline-meta"><span>'+esc(agent.type)+'</span><span class="badge badge-'+esc(agent.role)+'">'+esc(agent.role)+'</span><span class="badge badge-'+(agent.trustTier==='A'?'blue':'orange')+'">Tier '+esc(agent.trustTier)+'</span></div></div><div class="timeline-meta"><span>'+esc(String(agent.totalEvents))+' events</span><span>'+esc(String(agent.activeSessions))+' live</span></div></div>'
      +'<div class="timeline-events">'+events+'</div>'
    +'</div>';
  }).join('')+'</div>';
}

function renderSearchDebugSection(){
  var section=document.getElementById('search-debug');
  var data=searchDebugState.data;
  var resultsHtml='';
  if(searchDebugState.loading){
    resultsHtml='<div class="search-debug-hint">Running search diagnostics…</div>';
  }else if(searchDebugState.error){
    resultsHtml='<div class="search-debug-hint">'+esc(searchDebugState.error)+'</div>';
  }else if(!data){
    resultsHtml='<div class="search-debug-hint">Run a query to inspect the FTS5 and semantic ranking pipeline for code search.</div>';
  }else if(data.unavailable){
    resultsHtml='<div class="search-debug-hint">'+esc(data.reason||'Search debug unavailable.')+'</div>';
  }else{
    var lexicalLabel=data.lexicalBackend==='zoekt'?'Zoekt':'FTS5';
    var queryLabel=data.lexicalBackend==='fts5'?'Sanitized FTS query':'FTS fallback query';
    var renderColumn=function(title,items){
      return '<div class="search-debug-column"><h5>'+esc(title)+'</h5>'
        +(items.length
          ?'<div class="search-debug-list">'+items.map(function(item){
            return '<div class="search-debug-item"><div class="search-debug-path">'+esc(item.path)+'</div><div class="search-debug-score"><span>'+esc(item.source)+'</span><span>'+esc(String(item.score))+'</span></div></div>';
          }).join('')+'</div>'
          :'<div class="search-debug-hint">No results.</div>')
        +'</div>';
    };
    resultsHtml=''
      +'<div class="search-debug-meta">'
        +'<div class="chart-indicator"><span class="chart-indicator-value">'+esc(data.runtimeBackend)+'</span><span class="chart-indicator-label">Runtime backend</span></div>'
        +'<div class="chart-indicator"><span class="chart-indicator-value">'+esc(lexicalLabel)+'</span><span class="chart-indicator-label">Lexical backend</span></div>'
        +'<div class="chart-indicator"><span class="chart-indicator-value">'+esc(data.semanticAvailable?'on':'off')+'</span><span class="chart-indicator-label">Semantic</span></div>'
        +'<div class="chart-indicator"><span class="chart-indicator-value">'+esc(data.sanitizedQuery||'n/a')+'</span><span class="chart-indicator-label">'+esc(queryLabel)+'</span></div>'
        +'<div class="chart-indicator"><span class="chart-indicator-value">'+esc(String((data.mergedResults||[]).length))+'</span><span class="chart-indicator-label">Merged results</span></div>'
      +'</div>'
      +'<div class="search-debug-results">'
        +renderColumn(lexicalLabel,data.lexicalResults||[])
        +renderColumn('Semantic',data.vectorResults||[])
        +renderColumn('Merged',data.mergedResults||[])
      +'</div>';
  }

  section.innerHTML=''
    +'<div class="search-debug-wrap">'
      +'<div class="search-debug-panel"><h4>Query Inspector</h4>'
        +'<form id="search-debug-form">'
          +'<div class="field"><label for="search-debug-query">Query</label><input id="search-debug-query" value="'+esc(searchDebugState.query||'')+'" placeholder="repository name header"></div>'
          +'<div class="field"><label for="search-debug-scope">Scope prefix</label><input id="search-debug-scope" value="'+esc(searchDebugState.scope||'')+'" placeholder="src/dashboard/"></div>'
          +'<div class="field"><label for="search-debug-limit">Limit</label><input id="search-debug-limit" type="number" min="1" max="20" value="'+esc(String(searchDebugState.limit||10))+'"></div>'
          +'<button class="action-submit" type="submit">'+(searchDebugState.loading?'Running...':'Run Debug Search')+'</button>'
        +'</form>'
        +'<div class="template-hint" style="margin-top:.8rem">This is a read-only diagnostic for code search. It shows the runtime backend, the lexical backend actually used for keyword candidates, any FTS fallback query, and how lexical plus semantic candidates merge.</div>'
      +'</div>'
      +'<div class="search-debug-panel"><h4>Results</h4>'+resultsHtml+'</div>'
    +'</div>';

  var form=document.getElementById('search-debug-form');
  if(form){
    form.addEventListener('submit',function(e){
      e.preventDefault();
      runSearchDebug();
    });
  }
}

async function runSearchDebug(){
  var queryEl=document.getElementById('search-debug-query');
  var scopeEl=document.getElementById('search-debug-scope');
  var limitEl=document.getElementById('search-debug-limit');
  searchDebugState.query=queryEl?queryEl.value.trim():searchDebugState.query;
  searchDebugState.scope=scopeEl?scopeEl.value.trim():searchDebugState.scope;
  var parsedLimit=parseInt(limitEl?limitEl.value:'10',10);
  searchDebugState.limit=isNaN(parsedLimit)?10:Math.max(1,Math.min(20,parsedLimit));
  if(!searchDebugState.query){
    searchDebugState.error='Provide a query first.';
    searchDebugState.data=null;
    renderSearchDebugSection();
    return;
  }
  searchDebugState.loading=true;
  searchDebugState.error='';
  renderSearchDebugSection();
  try{
    var params=new URLSearchParams({query:searchDebugState.query,limit:String(searchDebugState.limit)});
    if(searchDebugState.scope) params.set('scope',searchDebugState.scope);
    var res=await fetch('/api/search/debug?'+params.toString());
    var data=await res.json();
    if(!res.ok) throw new Error(data.error||'Search debug failed');
    searchDebugState.data=data;
  }catch(err){
    searchDebugState.data=null;
    searchDebugState.error=String(err.message||err);
  }finally{
    searchDebugState.loading=false;
    renderSearchDebugSection();
  }
}

function knowledgeFiltersActive(){
  return !!knowledgeViewState.query || knowledgeViewState.scope!=='all' || !!knowledgeViewState.type;
}

async function refreshKnowledgeViewData(showLoading){
  if(!knowledgeFiltersActive()){
    knowledgeViewState.results=knowledgeCatalog.slice();
    knowledgeViewState.loading=false;
    knowledgeViewState.error='';
    return;
  }

  knowledgeViewState.loading=true;
  knowledgeViewState.error='';
  if(showLoading) renderKnowledgeSection();

  try{
    var params=new URLSearchParams();
    if(knowledgeViewState.query) params.set('query',knowledgeViewState.query);
    if(knowledgeViewState.scope) params.set('scope',knowledgeViewState.scope);
    if(knowledgeViewState.type) params.set('type',knowledgeViewState.type);
    params.set('limit',String(knowledgeViewState.limit||20));
    knowledgeViewState.results=await api('knowledge?'+params.toString());
  }catch(err){
    knowledgeViewState.results=[];
    knowledgeViewState.error=String(err&&err.message?err.message:err);
  }finally{
    knowledgeViewState.loading=false;
  }
}

async function runKnowledgeSearch(reset){
  if(reset){
    knowledgeViewState.query='';
    knowledgeViewState.scope='all';
    knowledgeViewState.type='';
    knowledgeViewState.limit=20;
  }else{
    var queryEl=document.getElementById('knowledge-search-query');
    var scopeEl=document.getElementById('knowledge-search-scope');
    var typeEl=document.getElementById('knowledge-search-type');
    var limitEl=document.getElementById('knowledge-search-limit');
    knowledgeViewState.query=queryEl?queryEl.value.trim():knowledgeViewState.query;
    knowledgeViewState.scope=scopeEl?scopeEl.value:'all';
    knowledgeViewState.type=typeEl?typeEl.value:'';
    var parsedLimit=parseInt(limitEl?limitEl.value:'20',10);
    knowledgeViewState.limit=isNaN(parsedLimit)?20:Math.max(1,Math.min(50,parsedLimit));
  }

  await refreshKnowledgeViewData(true);
  renderKnowledgeSection();
}

function renderKnowledgeSection(){
  var section=document.getElementById('knowledge');
  var entries=knowledgeFiltersActive()?knowledgeViewState.results:knowledgeCatalog;
  var summary='Showing '+esc(String(entries.length))+' knowledge entr'+(entries.length===1?'y':'ies');
  if(knowledgeFiltersActive()){
    summary+=' · filtered by backend search semantics';
  }else{
    summary+=' · full repo + global catalog';
  }

  section.innerHTML=''
    +'<div class="ticket-toolbar">'
      +'<div class="action-card"><h4>Knowledge Search</h4>'
        +'<form id="knowledge-search-form">'
          +'<div class="field"><label for="knowledge-search-query">Query</label><input id="knowledge-search-query" value="'+esc(knowledgeViewState.query||'')+'" placeholder="auth pattern decision"></div>'
          +'<div class="field-row">'
            +'<div class="field"><label for="knowledge-search-scope">Scope</label><select id="knowledge-search-scope"><option value="all"'+(knowledgeViewState.scope==='all'?' selected':'')+'>all</option><option value="repo"'+(knowledgeViewState.scope==='repo'?' selected':'')+'>repo</option><option value="global"'+(knowledgeViewState.scope==='global'?' selected':'')+'>global</option></select></div>'
            +'<div class="field"><label for="knowledge-search-type">Type</label><select id="knowledge-search-type"><option value=""'+(!knowledgeViewState.type?' selected':'')+'>all types</option>'+KNOWLEDGE_TYPES.map(function(type){return '<option value="'+esc(type)+'"'+(knowledgeViewState.type===type?' selected':'')+'>'+esc(type)+'</option>';}).join('')+'</select></div>'
            +'<div class="field"><label for="knowledge-search-limit">Limit</label><input id="knowledge-search-limit" type="number" min="1" max="50" value="'+esc(String(knowledgeViewState.limit||20))+'"></div>'
          +'</div>'
          +'<div class="field-row">'
            +'<button class="action-submit" type="submit">'+(knowledgeViewState.loading?'Searching...':'Run Knowledge Search')+'</button>'
            +'<button class="btn" id="knowledge-search-reset" type="button">Reset</button>'
          +'</div>'
        +'</form>'
        +'<div class="template-hint" style="margin-top:.8rem">Use <code>repo</code> for this repository, <code>global</code> for shared <code>~/.monsthera</code> knowledge, or <code>all</code> for combined results. When a query is present, the dashboard calls the same backend search semantics as <code>search_knowledge</code>.</div>'
      +'</div>'
    +'</div>';

  var resultsCard=document.createElement('div');
  resultsCard.className='detail-card';
  var helper='<div class="ticket-help">Knowledge discovery now surfaces repo, global, and combined scope explicitly in the dashboard.</div>';
  if(knowledgeViewState.loading){
    helper='<div class="ticket-help">Searching knowledge…</div>';
  }else if(knowledgeViewState.error){
    helper='<div class="ticket-help">'+esc(knowledgeViewState.error)+'</div>';
  }
  resultsCard.innerHTML='<div class="ticket-toolbar-top"><div class="ticket-toolbar-meta">'+summary+'</div></div>'+helper;
  var graphCard=renderKnowledgeGraphCard();
  if(graphCard){
    section.appendChild(graphCard);
  }

  var headers=['Type','Title','Scope','Tags','Status','Agent','Updated'];
  if(knowledgeViewState.query) headers.push('Score');
  var rows=entries.map(function(entry){
    var row=[
      b(entry.type,entry.type),
      entry.title,
      b(entry.scope,entry.scope),
      (entry.tags||[]).join(', ')||'-',
      b(entry.status,entry.status==='active'?'active':'stale'),
      entry.agentId||'-',
      new Date(entry.updatedAt).toLocaleString(),
    ];
    if(knowledgeViewState.query){
      row.push(entry.score!=null?m(String(entry.score)):'-');
    }
    return row;
  });
  resultsCard.appendChild(makeTable(headers,rows));
  section.appendChild(resultsCard);

  var form=document.getElementById('knowledge-search-form');
  if(form){
    form.addEventListener('submit',function(e){
      e.preventDefault();
      runKnowledgeSearch(false);
    });
  }
  var resetBtn=document.getElementById('knowledge-search-reset');
  if(resetBtn){
    resetBtn.addEventListener('click',function(){runKnowledgeSearch(true)});
  }
}

function knowledgeGraphNodeColor(nodeType){
  return KNOWLEDGE_GRAPH_NODE_COLORS[nodeType]||'#6b7280';
}

function knowledgeGraphEdgeColor(edgeType){
  return KNOWLEDGE_GRAPH_EDGE_COLORS[edgeType]||'#94a3b8';
}

function selectedKnowledgeGraphNode(){
  return knowledgeGraphState.nodes.find(function(node){return node.id===knowledgeGraphState.selectedId;})||null;
}

function knowledgeGraphConnectedEdges(nodeId){
  return knowledgeGraphState.edges.filter(function(edge){return edge.source===nodeId||edge.target===nodeId;});
}

function knowledgeGraphNodeById(nodeId){
  return knowledgeGraphState.nodes.find(function(node){return node.id===nodeId;})||null;
}

function formatKnowledgeGraphScore(score){
  return Number(score||0).toFixed(2);
}

function updateKnowledgeGraphDetail(){
  var host=document.getElementById('knowledge-graph-detail');
  if(!host) return;
  var node=selectedKnowledgeGraphNode();
  if(!node){
    host.innerHTML='<div class="ticket-help">Click a node to inspect the underlying artifact and its connected edges.</div>';
    return;
  }
  var details=node.details||{};
  var cls=node.nodeType==='ticket'?'orange':node.nodeType==='patch'?'success':node.nodeType==='note'?'purple':node.nodeType==='knowledge'?'cyan':'blue';
  var rows=['<div class="detail-block"><div class="detail-label">Connections</div><div class="detail-value">'+esc(String(node.connectionCount||0))+'</div></div>'];
  if(node.nodeType==='file'){
    rows.push('<div class="detail-block"><div class="detail-label">Path</div><div class="detail-value">'+esc(details.path||node.label)+'</div></div>');
    rows.push('<div class="detail-block"><div class="detail-label">Language</div><div class="detail-value">'+esc(details.language||'unknown')+'</div></div>');
    if(details.summary){
      rows.push('<div class="detail-block"><div class="detail-label">Summary</div><div class="detail-value">'+esc(details.summary)+'</div></div>');
    }
  }else if(node.nodeType==='ticket'){
    rows.push('<div class="detail-block"><div class="detail-label">Ticket</div><div class="detail-value">'+esc(details.ticketId||node.label)+'</div></div>');
    rows.push('<div class="detail-block"><div class="detail-label">Status</div><div class="detail-value">'+esc(details.status||'-')+'</div></div>');
    rows.push('<div class="detail-block"><div class="detail-label">Title</div><div class="detail-value">'+esc(details.title||'-')+'</div></div>');
  }else if(node.nodeType==='patch'){
    rows.push('<div class="detail-block"><div class="detail-label">Proposal</div><div class="detail-value">'+esc(details.proposalId||node.label)+'</div></div>');
    rows.push('<div class="detail-block"><div class="detail-label">State</div><div class="detail-value">'+esc(details.state||'-')+'</div></div>');
    rows.push('<div class="detail-block"><div class="detail-label">Message</div><div class="detail-value">'+esc(details.message||'-')+'</div></div>');
  }else if(node.nodeType==='note'){
    rows.push('<div class="detail-block"><div class="detail-label">Key</div><div class="detail-value">'+esc(details.key||node.label)+'</div></div>');
    rows.push('<div class="detail-block"><div class="detail-label">Type</div><div class="detail-value">'+esc(details.type||'-')+'</div></div>');
    rows.push('<div class="detail-block"><div class="detail-label">Preview</div><div class="detail-value">'+esc(details.preview||'-')+'</div></div>');
  }else if(node.nodeType==='knowledge'){
    rows.push('<div class="detail-block"><div class="detail-label">Key</div><div class="detail-value">'+esc(details.key||'-')+'</div></div>');
    rows.push('<div class="detail-block"><div class="detail-label">Type</div><div class="detail-value">'+esc(details.type||'-')+'</div></div>');
    rows.push('<div class="detail-block"><div class="detail-label">Scope</div><div class="detail-value">'+esc(details.scope||'-')+'</div></div>');
    rows.push('<div class="detail-block"><div class="detail-label">Preview</div><div class="detail-value">'+esc(details.preview||'-')+'</div></div>');
  }
  var connectedEdges=knowledgeGraphConnectedEdges(node.id).sort(function(a,b){
    return (b.score||0)-(a.score||0)||String(a.edgeType).localeCompare(String(b.edgeType))||String(a.source).localeCompare(String(b.source))||String(a.target).localeCompare(String(b.target));
  });
  if(connectedEdges.length){
    var edgeItems=connectedEdges.map(function(edge){
      var outgoing=edge.source===node.id;
      var otherId=outgoing?edge.target:edge.source;
      var otherNode=knowledgeGraphNodeById(otherId);
      var direction=outgoing?'outgoing':'incoming';
      var provenance=edge.provenance||{};
      return ''
        +'<div class="edge-meta-item">'
          +'<div class="edge-meta-top"><span><span class="badge badge-blue">'+esc(edge.edgeType)+'</span> '+esc(direction)+' · '+esc(otherNode?otherNode.label:otherId)+'</span><span class="edge-meta-score">score '+esc(formatKnowledgeGraphScore(edge.score))+'</span></div>'
          +'<div class="edge-meta-note">'+esc(provenance.kind||'derived')+' · '+esc(provenance.detail||'exact relationship evidence')+'</div>'
        +'</div>';
    }).join('');
    rows.push('<div class="detail-block"><div class="detail-label">Connected Edges</div><div class="edge-meta-list">'+edgeItems+'</div></div>');
  }else{
    rows.push('<div class="detail-block"><div class="detail-label">Connected Edges</div><div class="detail-value">No edges above threshold.</div></div>');
  }
  host.innerHTML=''
    +'<div class="detail-card">'
      +'<div class="detail-head"><div><div class="detail-title">'+esc(node.label)+'</div><div class="detail-sub"><span>'+esc(node.id)+'</span></div></div><div><span class="badge badge-'+cls+'">'+esc(node.nodeType)+'</span></div></div>'
      +rows.join('')
    +'</div>';
}

function renderKnowledgeGraphCard(){
  var knowledgeSection=document.getElementById('knowledge');
  if(!knowledgeGraphState.loaded && !knowledgeGraphState.loading && !knowledgeGraphState.error && knowledgeSection && knowledgeSection.classList.contains('active')){
    loadKnowledgeGraph();
  }
  var card=document.createElement('div');
  card.className='detail-card';
  var summary;
  if(knowledgeGraphState.loading && !knowledgeGraphState.loaded){
    summary='Loading graph…';
  }else if(knowledgeGraphState.error){
    summary='Graph unavailable';
  }else if(knowledgeGraphState.loaded){
    summary=String(knowledgeGraphState.nodes.length)+' nodes · '+String(knowledgeGraphState.edges.length)+' edges · exact-match derivation only';
  }else{
    summary='Preparing graph…';
  }

  var body='';
  if(knowledgeGraphState.loading && !knowledgeGraphState.loaded){
    body='<div class="dep-graph-empty">Loading knowledge graph…</div>';
  }else if(knowledgeGraphState.error){
    body='<div class="ticket-help">'+esc(knowledgeGraphState.error)+'</div>';
  }else if(knowledgeGraphState.loaded && !knowledgeGraphState.nodes.length){
    body='<div class="dep-graph-empty">No exact cross-artifact relationships found yet.</div>';
  }else if(knowledgeGraphState.loaded){
    body=''
      +'<div class="dep-graph-wrap">'
        +'<canvas id="knowledge-graph-canvas" height="420"></canvas>'
        +'<div class="dep-graph-tooltip" id="knowledge-graph-tooltip"></div>'
        +'<div class="dep-graph-legend">'
          +'<span><span class="swatch" style="background:'+esc(knowledgeGraphNodeColor('file'))+'"></span> Files</span>'
          +'<span><span class="swatch" style="background:'+esc(knowledgeGraphNodeColor('ticket'))+'"></span> Tickets</span>'
          +'<span><span class="swatch" style="background:'+esc(knowledgeGraphNodeColor('patch'))+'"></span> Patches</span>'
          +'<span><span class="swatch" style="background:'+esc(knowledgeGraphNodeColor('note'))+'"></span> Notes</span>'
          +'<span><span class="swatch" style="background:'+esc(knowledgeGraphNodeColor('knowledge'))+'"></span> Knowledge</span>'
        +'</div>'
      +'</div>';
  }

  card.innerHTML=''
    +'<div class="ticket-toolbar-top"><div class="ticket-toolbar-meta">Knowledge Graph · '+esc(summary)+'</div></div>'
    +'<div class="ticket-help">Read-only graph derived from explicit relationships only. Default threshold '+esc(String(knowledgeGraphState.defaultThreshold||.65))+'.</div>'
    +body
    +'<div id="knowledge-graph-detail" style="margin-top:1rem"></div>';

  if(knowledgeGraphState.loaded && knowledgeGraphState.nodes.length){
    setTimeout(function(){
      initKnowledgeGraphCanvas();
      updateKnowledgeGraphDetail();
    },0);
  }else{
    setTimeout(updateKnowledgeGraphDetail,0);
  }
  return card;
}

async function loadKnowledgeGraph(){
  if(knowledgeGraphState.loading) return;
  knowledgeGraphState.loading=true;
  knowledgeGraphState.error='';
  renderKnowledgeSection();
  try{
    var data=await api('knowledge-graph');
    knowledgeGraphState.nodes=data.nodes||[];
    knowledgeGraphState.edges=data.edges||[];
    knowledgeGraphState.defaultThreshold=data.defaultThreshold||.65;
    knowledgeGraphState.loaded=true;
    if(knowledgeGraphState.nodes.length && !knowledgeGraphState.nodes.some(function(node){return node.id===knowledgeGraphState.selectedId;})){
      knowledgeGraphState.selectedId=knowledgeGraphState.nodes[0].id;
    }
  }catch(e){
    knowledgeGraphState.nodes=[];
    knowledgeGraphState.edges=[];
    knowledgeGraphState.loaded=true;
    knowledgeGraphState.error=String(e&&e.message?e.message:e);
  }finally{
    knowledgeGraphState.loading=false;
    renderKnowledgeSection();
  }
}

function initKnowledgeGraphCanvas(){
  var canvas=document.getElementById('knowledge-graph-canvas');
  if(!canvas) return;
  var tooltip=document.getElementById('knowledge-graph-tooltip');
  var rect=canvas.parentElement.getBoundingClientRect();
  var W=Math.floor(rect.width);
  var H=420;
  var dpr=window.devicePixelRatio||1;
  canvas.width=W*dpr;
  canvas.height=H*dpr;
  canvas.style.width=W+'px';
  canvas.style.height=H+'px';
  var ctx=canvas.getContext('2d');
  ctx.scale(dpr,dpr);

  var nodes=knowledgeGraphState.nodes.map(function(node){
    return{
      id:node.id,
      label:node.label,
      nodeType:node.nodeType,
      details:node.details||{},
      connectionCount:node.connectionCount||0,
      x:W/2+(Math.random()-.5)*W*.55,
      y:H/2+(Math.random()-.5)*H*.55,
      vx:0,
      vy:0
    };
  });
  var idToNode={};
  nodes.forEach(function(node){idToNode[node.id]=node;});
  var edges=knowledgeGraphState.edges.filter(function(edge){return idToNode[edge.source]&&idToNode[edge.target];});
  var hovered=null;
  var frames=0;
  var stable=false;

  function radius(node){
    return Math.max(6,Math.min(12,6+(node.connectionCount||0)*.6));
  }

  function simulate(){
    frames+=1;
    var repulsion=2200;
    var spring=.02;
    var damping=.82;

    for(var i=0;i<nodes.length;i+=1){
      var a=nodes[i];
      for(var j=i+1;j<nodes.length;j+=1){
        var b=nodes[j];
        var dx=a.x-b.x;
        var dy=a.y-b.y;
        var distSq=Math.max(dx*dx+dy*dy,1);
        var force=repulsion/distSq;
        var dist=Math.sqrt(distSq);
        var ux=dx/dist;
        var uy=dy/dist;
        a.vx+=ux*force;
        a.vy+=uy*force;
        b.vx-=ux*force;
        b.vy-=uy*force;
      }
    }

    edges.forEach(function(edge){
      var source=idToNode[edge.source];
      var target=idToNode[edge.target];
      var dx=target.x-source.x;
      var dy=target.y-source.y;
      var dist=Math.max(Math.sqrt(dx*dx+dy*dy),1);
      var desired=edge.edgeType==='blocks'?120:105;
      var force=(dist-desired)*spring;
      var ux=dx/dist;
      var uy=dy/dist;
      source.vx+=ux*force;
      source.vy+=uy*force;
      target.vx-=ux*force;
      target.vy-=uy*force;
    });

    var maxSpeed=0;
    nodes.forEach(function(node){
      node.vx=(node.vx-(node.x-W/2)*.0015)*damping;
      node.vy=(node.vy-(node.y-H/2)*.0015)*damping;
      node.x=Math.max(24,Math.min(W-24,node.x+node.vx));
      node.y=Math.max(24,Math.min(H-24,node.y+node.vy));
      var speed=Math.abs(node.vx)+Math.abs(node.vy);
      if(speed>maxSpeed) maxSpeed=speed;
    });

    draw();
    stable=frames>90&&maxSpeed<.2;
    if(!stable&&frames<240){
      requestAnimationFrame(simulate);
    }
  }

  function draw(){
    ctx.clearRect(0,0,W,H);
    edges.forEach(function(edge){
      var source=idToNode[edge.source];
      var target=idToNode[edge.target];
      ctx.beginPath();
      ctx.moveTo(source.x,source.y);
      ctx.lineTo(target.x,target.y);
      ctx.strokeStyle=knowledgeGraphEdgeColor(edge.edgeType);
      ctx.lineWidth=Math.max(1,1+edge.score*1.5);
      ctx.globalAlpha=edge.edgeType==='relates_to' ? .45 : .72;
      ctx.stroke();
      ctx.globalAlpha=1;
    });

    nodes.forEach(function(node){
      var selected=knowledgeGraphState.selectedId===node.id;
      var isHovered=hovered&&hovered.id===node.id;
      ctx.beginPath();
      ctx.arc(node.x,node.y,radius(node),0,Math.PI*2);
      ctx.fillStyle=knowledgeGraphNodeColor(node.nodeType);
      ctx.globalAlpha=.92;
      ctx.fill();
      ctx.globalAlpha=1;
      ctx.lineWidth=selected?3:isHovered?2:1.5;
      ctx.strokeStyle=selected?'#f8fafc':'rgba(15,23,42,.75)';
      ctx.stroke();

      ctx.fillStyle='rgba(226,232,240,.9)';
      ctx.font=(selected||isHovered?'600 ':'400 ')+'10px ui-monospace, monospace';
      ctx.fillText(node.label,node.x+radius(node)+6,node.y+4);
    });
  }

  function nearestNode(x,y){
    var best=null;
    var bestDist=Infinity;
    nodes.forEach(function(node){
      var dx=node.x-x,dy=node.y-y;
      var dist=Math.sqrt(dx*dx+dy*dy);
      if(dist<radius(node)+6&&dist<bestDist){
        best=node;
        bestDist=dist;
      }
    });
    return best;
  }

  canvas.addEventListener('mousemove',function(e){
    var r=canvas.getBoundingClientRect();
    hovered=nearestNode(e.clientX-r.left,e.clientY-r.top);
    if(hovered){
      tooltip.style.display='block';
      tooltip.style.left=(Math.min(r.width-220,hovered.x+14))+'px';
      tooltip.style.top=(Math.max(12,hovered.y-10))+'px';
      tooltip.innerHTML='<div class="mono">'+esc(hovered.label)+'</div><div>'+esc(hovered.nodeType)+' · '+esc(String(hovered.connectionCount||0))+' connections</div>';
    }else{
      tooltip.style.display='none';
    }
    draw();
  });

  canvas.addEventListener('mouseleave',function(){
    hovered=null;
    tooltip.style.display='none';
    draw();
  });

  canvas.addEventListener('click',function(e){
    var r=canvas.getBoundingClientRect();
    var hit=nearestNode(e.clientX-r.left,e.clientY-r.top);
    if(!hit) return;
    knowledgeGraphState.selectedId=hit.id;
    updateKnowledgeGraphDetail();
    draw();
  });

  simulate();
}

/* ── Dependency Graph ────────────────────────── */
var depGraphState={scope:'',nodes:[],edges:[],cycleCount:0,loaded:false,catalogPaths:[]};

var LANG_COLORS_MAP={typescript:'#3178c6',javascript:'#f7df1e',python:'#3776ab',go:'#00add8',rust:'#dea584',java:'#b07219',ruby:'#cc342d',php:'#4f5d95'};
var KNOWLEDGE_GRAPH_NODE_COLORS={file:'#3b82f6',ticket:'#f59e0b',patch:'#22c55e',note:'#a855f7',knowledge:'#06b6d4'};
var KNOWLEDGE_GRAPH_EDGE_COLORS={imports:'#60a5fa',blocks:'#ef4444',relates_to:'#f59e0b',addresses_file:'#fb7185',touches_file:'#22c55e',implements_ticket:'#10b981',annotates_file:'#a855f7',documents_file:'#06b6d4',supports_ticket:'#8b5cf6'};

function langColor(lang){
  if(!lang) return '#6b7280';
  var l=lang.toLowerCase();
  return LANG_COLORS_MAP[l]||'#6b7280';
}

function renderDepGraphSection(){
  var el=document.getElementById('dependencies');
  while(el.firstChild) el.removeChild(el.firstChild);

  // Toolbar
  var toolbar=document.createElement('div');toolbar.className='dep-graph-toolbar';
  var scopeInput=document.createElement('input');scopeInput.id='dep-scope';scopeInput.type='text';scopeInput.placeholder='Scope prefix (e.g. src/)';scopeInput.value=depGraphState.scope;
  var fileSelect=document.createElement('select');fileSelect.id='dep-file-select';
  var placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Choose indexed file…';
  fileSelect.appendChild(placeholder);
  depGraphState.catalogPaths.forEach(function(path){
    var option=document.createElement('option');
    option.value=path;
    option.textContent=path;
    if(depGraphState.scope===path) option.selected=true;
    fileSelect.appendChild(option);
  });
  var loadBtn=document.createElement('button');loadBtn.className='action-submit';loadBtn.textContent='Load Graph';
  var showAllBtn=document.createElement('button');showAllBtn.className='action-submit';showAllBtn.textContent='Show All';showAllBtn.type='button';
  var infoSpan=document.createElement('div');infoSpan.className='dep-graph-info';
  toolbar.appendChild(scopeInput);toolbar.appendChild(fileSelect);toolbar.appendChild(loadBtn);toolbar.appendChild(showAllBtn);toolbar.appendChild(infoSpan);
  el.appendChild(toolbar);

  loadBtn.addEventListener('click',function(){
    depGraphState.scope=(scopeInput.value||'').trim();
    loadDepGraph();
  });
  fileSelect.addEventListener('change',function(){
    if(!this.value) return;
    scopeInput.value=this.value;
    depGraphState.scope=this.value;
    loadDepGraph();
  });
  showAllBtn.addEventListener('click',function(){
    scopeInput.value='';
    fileSelect.value='';
    depGraphState.scope='';
    loadDepGraph();
  });
  scopeInput.addEventListener('keydown',function(e){
    if(e.key==='Enter'){depGraphState.scope=this.value.trim();loadDepGraph();}
  });

  if(!depGraphState.loaded){
    infoSpan.textContent='Loading\u2026';
    var loading=document.createElement('div');loading.className='dep-graph-empty';loading.textContent='Loading dependency graph\u2026';
    el.appendChild(loading);
    return;
  }
  if(!depGraphState.nodes.length){
    infoSpan.textContent='0 files';
    var empty=document.createElement('div');empty.className='dep-graph-empty';
    empty.textContent='No indexed files with imports found'+(depGraphState.scope?' in scope "'+depGraphState.scope+'"':'')+'. Choose an indexed file from the list above or click Show All.';
    el.appendChild(empty);
    return;
  }

  var info=String(depGraphState.nodes.length)+' files, '+String(depGraphState.edges.length)+' imports';
  if(depGraphState.cycleCount>0) info+=', '+String(depGraphState.cycleCount)+' in cycles';
  infoSpan.textContent=info;

  // Canvas wrap
  var wrap=document.createElement('div');wrap.className='dep-graph-wrap';
  var canvas=document.createElement('canvas');canvas.id='dep-canvas';canvas.height=500;
  var tooltip=document.createElement('div');tooltip.className='dep-graph-tooltip';tooltip.id='dep-tooltip';
  wrap.appendChild(canvas);wrap.appendChild(tooltip);

  // Legend
  var legend=document.createElement('div');legend.className='dep-graph-legend';
  var langList=[['#3178c6','TypeScript'],['#f7df1e','JavaScript'],['#3776ab','Python'],['#00add8','Go'],['#dea584','Rust'],['#6b7280','Other'],['#ef4444','Cycle']];
  langList.forEach(function(pair){
    var s=document.createElement('span');
    var sw=document.createElement('span');sw.className='swatch';sw.style.background=pair[0];
    s.appendChild(sw);s.appendChild(document.createTextNode(' '+pair[1]));
    legend.appendChild(s);
  });
  wrap.appendChild(legend);
  el.appendChild(wrap);

  initDepCanvas();
}

function initDepCanvas(){
  var canvas=document.getElementById('dep-canvas');
  if(!canvas) return;
  var rect=canvas.parentElement.getBoundingClientRect();
  var W=Math.floor(rect.width);
  var H=500;
  var dpr=window.devicePixelRatio||1;
  canvas.width=W*dpr;
  canvas.height=H*dpr;
  canvas.style.width=W+'px';
  canvas.style.height=H+'px';
  var ctx=canvas.getContext('2d');
  ctx.scale(dpr,dpr);

  var nodes=depGraphState.nodes.map(function(n){
    return{id:n.id,path:n.path,lang:n.language,inCycle:n.inCycle,
      x:W/2+(Math.random()-.5)*W*0.6,
      y:H/2+(Math.random()-.5)*H*0.6,
      vx:0,vy:0,r:4};
  });
  var idToIdx={};
  nodes.forEach(function(n,i){idToIdx[n.id]=i});
  var edges=depGraphState.edges.filter(function(e){return idToIdx[e.source]!==undefined&&idToIdx[e.target]!==undefined})
    .map(function(e){return{s:idToIdx[e.source],t:idToIdx[e.target],kind:e.kind}});

  // Compute degrees for node sizing
  var deg=new Array(nodes.length).fill(0);
  edges.forEach(function(e){deg[e.s]++;deg[e.t]++});
  var maxDeg=Math.max.apply(null,deg.concat([1]));
  nodes.forEach(function(n,i){n.r=3+Math.sqrt(deg[i]/maxDeg)*5});

  var camX=0,camY=0,zoom=1;
  var dragging=null,dragStart=null;
  var hovered=null;

  // Simple force simulation
  var alpha=1;
  var running=true;

  function simulate(){
    if(alpha<0.001){running=false;return}
    alpha*=0.98;
    var N=nodes.length;

    // Repulsion
    for(var i=0;i<N;i++){
      for(var j=i+1;j<N;j++){
        var dx=nodes[j].x-nodes[i].x;
        var dy=nodes[j].y-nodes[i].y;
        var d2=dx*dx+dy*dy+1;
        var f=200*alpha/d2;
        var fx=dx*f,fy=dy*f;
        nodes[i].vx-=fx;nodes[i].vy-=fy;
        nodes[j].vx+=fx;nodes[j].vy+=fy;
      }
    }

    // Attraction along edges
    edges.forEach(function(e){
      var a=nodes[e.s],b=nodes[e.t];
      var dx=b.x-a.x,dy=b.y-a.y;
      var d=Math.sqrt(dx*dx+dy*dy)+0.1;
      var f=0.03*alpha*(d-60)/d;
      var fx=dx*f,fy=dy*f;
      a.vx+=fx;a.vy+=fy;
      b.vx-=fx;b.vy-=fy;
    });

    // Center gravity
    nodes.forEach(function(n){
      n.vx+=(W/2-n.x)*0.001*alpha;
      n.vy+=(H/2-n.y)*0.001*alpha;
    });

    // Integrate
    nodes.forEach(function(n){
      if(n===dragging) return;
      n.vx*=0.6;n.vy*=0.6;
      n.x+=n.vx;n.y+=n.vy;
      n.x=Math.max(n.r,Math.min(W-n.r,n.x));
      n.y=Math.max(n.r,Math.min(H-n.r,n.y));
    });
  }

  function draw(){
    ctx.clearRect(0,0,W,H);
    ctx.save();
    ctx.translate(camX,camY);
    ctx.scale(zoom,zoom);

    // Edges
    ctx.lineWidth=0.5/zoom;
    edges.forEach(function(e){
      var a=nodes[e.s],b=nodes[e.t];
      var isCycle=a.inCycle&&b.inCycle;
      ctx.strokeStyle=isCycle?'rgba(239,68,68,.45)':'rgba(255,255,255,.08)';
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    });

    // Nodes
    nodes.forEach(function(n,i){
      ctx.beginPath();
      ctx.arc(n.x,n.y,n.r/zoom,0,Math.PI*2);
      if(n.inCycle){
        ctx.fillStyle='#ef4444';
        ctx.strokeStyle='rgba(239,68,68,.6)';
        ctx.lineWidth=1.5/zoom;
        ctx.fill();ctx.stroke();
      }else{
        ctx.fillStyle=langColor(n.lang);
        ctx.fill();
      }
      if(i===hovered){
        ctx.strokeStyle='#fff';
        ctx.lineWidth=2/zoom;
        ctx.stroke();
      }
    });

    ctx.restore();
    if(running){simulate();requestAnimationFrame(draw)}
  }

  // Interaction
  function worldPos(e){
    var r=canvas.getBoundingClientRect();
    return{x:(e.clientX-r.left-camX)/zoom,y:(e.clientY-r.top-camY)/zoom};
  }

  function findNode(wx,wy){
    for(var i=nodes.length-1;i>=0;i--){
      var n=nodes[i];
      var dx=n.x-wx,dy=n.y-wy;
      if(dx*dx+dy*dy<(n.r/zoom+4)*(n.r/zoom+4)) return i;
    }
    return -1;
  }

  canvas.addEventListener('mousedown',function(e){
    var p=worldPos(e);
    var idx=findNode(p.x,p.y);
    if(idx>=0){dragging=nodes[idx];dragging.vx=0;dragging.vy=0}
    else{dragStart={mx:e.clientX,my:e.clientY,cx:camX,cy:camY}}
  });

  canvas.addEventListener('mousemove',function(e){
    var p=worldPos(e);
    if(dragging){
      dragging.x=p.x;dragging.y=p.y;
      alpha=Math.max(alpha,0.1);running=true;requestAnimationFrame(draw);
    }else if(dragStart){
      camX=dragStart.cx+(e.clientX-dragStart.mx);
      camY=dragStart.cy+(e.clientY-dragStart.my);
      requestAnimationFrame(draw);
    }else{
      var idx=findNode(p.x,p.y);
      if(idx!==hovered){
        hovered=idx>=0?idx:null;
        var tt=document.getElementById('dep-tooltip');
        if(hovered!==null){
          var n=nodes[hovered];
          var inCount=edges.filter(function(e){return e.t===hovered}).length;
          var outCount=edges.filter(function(e){return e.s===hovered}).length;
          tt.textContent='';
          var mp=document.createElement('div');mp.className='mono';mp.textContent=n.path;
          var md=document.createElement('div');md.textContent=(n.lang||'unknown')+' \u00b7 '+outCount+' imports \u00b7 '+inCount+' importers'+(n.inCycle?' \u00b7 in cycle':'');
          tt.appendChild(mp);tt.appendChild(md);
          tt.style.display='block';
          var r=canvas.getBoundingClientRect();
          tt.style.left=Math.min(e.clientX-r.left+12,W-200)+'px';
          tt.style.top=(e.clientY-r.top+12)+'px';
        }else{
          tt.style.display='none';
        }
        if(!running){requestAnimationFrame(draw)}
      }
    }
  });

  canvas.addEventListener('mouseup',function(){dragging=null;dragStart=null});
  canvas.addEventListener('mouseleave',function(){
    dragging=null;dragStart=null;hovered=null;
    document.getElementById('dep-tooltip').style.display='none';
    if(!running) requestAnimationFrame(draw);
  });

  canvas.addEventListener('wheel',function(e){
    e.preventDefault();
    var r=canvas.getBoundingClientRect();
    var mx=e.clientX-r.left,my=e.clientY-r.top;
    var oldZoom=zoom;
    zoom*=e.deltaY<0?1.1:0.9;
    zoom=Math.max(0.1,Math.min(5,zoom));
    camX=mx-(mx-camX)*(zoom/oldZoom);
    camY=my-(my-camY)*(zoom/oldZoom);
    if(!running) requestAnimationFrame(draw);
  },{passive:false});

  requestAnimationFrame(draw);
}

async function loadDepGraph(){
  depGraphState.loaded=false;
  renderDepGraphSection();
  try{
    var params=depGraphState.scope?'?scope='+encodeURIComponent(depGraphState.scope):'';
    var data=await api('dependency-graph'+params);
    depGraphState.nodes=data.nodes||[];
    depGraphState.edges=data.edges||[];
    depGraphState.cycleCount=data.cycleCount||0;
    if(!depGraphState.scope || !depGraphState.catalogPaths.length){
      depGraphState.catalogPaths=(data.nodes||[]).map(function(node){return node.path}).sort();
    }
    depGraphState.loaded=true;
  }catch(e){
    depGraphState.nodes=[];depGraphState.edges=[];depGraphState.cycleCount=0;
    depGraphState.loaded=true;
    console.error('Dep graph load failed:',e);
  }
  renderDepGraphSection();
}

async function refreshPresence(){
  try{
    var agents=await api('presence');
    renderPresence(agents);
  }catch(e){console.error('Presence refresh failed:',e)}
}

/* ── Governance refresh ─────────────────────── */
async function refreshGovernance(){
  try{
    var settings=await api('settings/governance');
    governanceSettings.data=settings;
    governanceSettings.loading=false;
    governanceSettings.saving=false;
    renderGovernancePanel();
  }catch(e){console.error('Governance refresh failed:',e);}
}

/* ── Main refresh ────────────────────────────── */
var refreshInFlight=false;
async function refresh(){
  if(refreshInFlight) return;
  refreshInFlight=true;
  try{
    var settled=await Promise.allSettled([
      api('overview'),api('agents'),api('agent-timeline'),api('logs'),api('patches'),api('notes'),api('knowledge'),api('presence'),api('tickets'),api('tickets/metrics'),api('files'),api('ticket-templates'),api('settings/governance')
    ]);
    var results=settled.map(function(r){return r.status==='fulfilled'?r.value:null;});
    var o=results[0],agents=results[1],timeline=results[2],logs=results[3],patches=results[4],notes=results[5],knowledge=results[6],presence=results[7],tickets=results[8],ticketMetrics=results[9],files=results[10],ticketTemplates=results[11],settings=results[12];
    knowledgeCatalog=knowledge;
    dashboardAgents=agents;
    window.__monstheraTicketTemplates=ticketTemplates;
    governanceSettings.data=settings;
    governanceSettings.loading=false;
    governanceSettings.saving=false;
    ticketActors=[];
    presence.forEach(function(agent){
      (agent.sessions||[]).forEach(function(session){
        if(session.state==='active'){
          ticketActors.push({sessionId:session.id,agentId:agent.id,name:agent.name,role:agent.role});
        }
      });
    });
    if(!ticketActors.some(function(actor){return actor.sessionId===selectedActorSessionId})){
      selectedActorSessionId=ticketActors.length?ticketActors[0].sessionId:null;
    }

    /* Nav counts — fetch convoy count in background */
    api('convoy').then(function(cd){
      var cc=cd&&cd.convoys?cd.convoys.length:0;
      navCounts.convoys=cc;
      var cel=document.getElementById('nav-count-convoys');
      if(cel) cel.textContent=String(cc);
      if(currentRoute==='convoys') refreshConvoys();
    }).catch(function(){});
    navCounts={agents:agents.length,tickets:tickets.length,knowledge:knowledge.length,logs:logs.length};
    tabCounts={agents:agents.length,timeline:timeline.length,'activity-timeline':activityTimelineData.length,'search-debug':searchDebugState.data&&searchDebugState.data.mergedResults?searchDebugState.data.mergedResults.length:0,dependencies:depGraphState.nodes.length,logs:logs.length,patches:patches.length,notes:notes.length,knowledge:knowledge.length,tickets:tickets.length};
    updateCounts();

    /* Route-specific rendering */
    if(currentRoute==='mission'){
      var ov=document.getElementById('overview');
      var repoName=repoBasename(o.repoPath);
      var repoEl=document.getElementById('repo-name');
      if(repoEl){repoEl.textContent=repoName;repoEl.title=o.repoPath||repoName;}
      if(ov) ov.replaceChildren(
        makeCard('&#128193;','Files Indexed',o.fileCount),
        makeCard('&#129302;','Agents',o.totalAgents),
        makeCard('&#9889;','Active Sessions',o.activeSessions),
        makeCard('&#128230;','Patches',o.totalPatches),
        makeCard('&#127915;','Open Tickets',o.openTickets!=null?o.openTickets+'/'+o.totalTickets:'0'),
        makeCard('&#127793;','Indexed Commit',o.indexedCommit?o.indexedCommit.slice(0,7):'none'),
        makeCard('&#128279;','Topology',o.coordinationTopology));
      renderGovernancePanel();
      renderPresence(presence);
      renderCharts(o,logs,patches,knowledge,presence,files);
    }

    if(currentRoute==='agents'){
      /* Agent cards in grid */
      var agGrid=document.getElementById('agents-grid');
      if(agGrid){
        agGrid.innerHTML='';
        presence.forEach(function(agent){
          var status='offline';
          var lastActive='';
          (agent.sessions||[]).forEach(function(s){
            if(s.state==='active') status='online';
            else if(s.state==='idle'&&status!=='online') status='idle';
            if(s.lastActivity) lastActive=s.lastActivity;
          });
          var card=document.createElement('div');
          card.className='agent-card'+(selectedAgentId===agent.id?' selected':'');
          card.onclick=function(){selectedAgentId=agent.id;refresh();};
          card.innerHTML='<div class="status-dot '+status+'"></div>'
            +'<div class="agent-info">'
            +'<div class="agent-name">'+esc(agent.name)+'</div>'
            +'<div class="agent-meta"><span class="badge badge-blue">'+esc(agent.role||'-')+'</span><span class="badge badge-purple">'+esc(agent.type||'-')+'</span></div>'
            +'<div class="agent-time">['+status.toUpperCase()+']'+(lastActive?' · '+new Date(lastActive).toLocaleTimeString():'')+'</div>'
            +'</div>';
          agGrid.appendChild(card);
        });
        if(!presence.length) agGrid.innerHTML='<div class="empty" style="width:100%">No agents registered</div>';
      }
      /* Timeline in detail panel */
      var tlPanel=document.getElementById('agent-timeline-panel');
      if(tlPanel){
        if(selectedAgentId){
          var agentTimeline=timeline.filter(function(t){return t.agentId===selectedAgentId||t.id===selectedAgentId});
          if(agentTimeline.length){
            renderAgentTimelineSection(agentTimeline);
          }else{
            renderAgentTimelineSection(timeline.slice(0,10));
          }
        }else{
          renderAgentTimelineSection(timeline.slice(0,10));
        }
      }
    }

    if(currentRoute==='tickets'){
      var visibleTickets=renderTicketsSection(tickets,ticketMetrics);
      if(selectedTicketId && visibleTickets.some(function(t){return t.ticketId===selectedTicketId})){
        selectedTicketDetail=await api('tickets/'+encodeURIComponent(selectedTicketId));
        renderTicketDetail();
      }else if(selectedTicketId && !visibleTickets.some(function(t){return t.ticketId===selectedTicketId})){
        selectedTicketId=null;
        selectedTicketDetail=null;
        renderTicketDetail();
      }
    }

    if(currentRoute==='knowledge'){
      await refreshKnowledgeViewData(false);
      renderKnowledgeSection();
      if(knowledgeGraphState.loaded && !knowledgeGraphState.loading){
        var activeKnowledge=document.getElementById('knowledge');
        if(activeKnowledge && activeKnowledge.classList.contains('active')){
          loadKnowledgeGraph();
        }
      }
    }

    if(currentRoute==='activity'){
      /* Activity Timeline (enriched) */
      var atlSection=document.getElementById('activity-timeline');
      if(atlSection&&atlSection.classList.contains('active')){
        try{
          var atlData=await api('activity-timeline?limit=100');
          renderActivityTimeline(atlData);
        }catch(e){console.error('Activity timeline failed:',e);}
      }

      /* Logs */
      var logsEl=document.getElementById('logs');
      if(logsEl) logsEl.replaceChildren(makeTable(
        ['Event','Agent','Tool','Status','Summary','Detail','Duration','In','Out','Time'],
        logs.map(function(l){return[
          m(l.eventId.slice(0,10)),
          l.agentId||'-',
          b(l.tool,'a'),
          b(l.status,eventStatusClass(l.status)),
          l.redactedSummary||'-',
          l.errorDetail?(l.errorCode?l.errorCode+': ':'')+l.errorDetail:'-',
          m(l.durationMs+'ms'),
          l.payloadSizeIn||'-',
          l.payloadSizeOut||'-',
          new Date(l.timestamp).toLocaleTimeString()
        ]})));

      /* Patches */
      var patchesEl=document.getElementById('patches');
      if(patchesEl) patchesEl.replaceChildren(makeTable(
        ['Proposal','State','Message','Base','Agent','Created'],
        patches.map(function(p){return[m(p.proposalId.slice(0,10)),b(p.state,p.state),esc(p.message).slice(0,60),m(p.baseCommit.slice(0,7)),p.agentId||'-',new Date(p.createdAt).toLocaleString()]})));

      /* Notes */
      var notesEl=document.getElementById('notes');
      if(notesEl) notesEl.replaceChildren(makeTable(
        ['Key','Type','Preview','Agent','Commit','Updated'],
        notes.map(function(n){return[m(n.key),b(n.type,n.type),n.contentPreview.slice(0,80),n.agentId||'-',m(n.commitSha.slice(0,7)),new Date(n.updatedAt).toLocaleString()]})));

      /* Agent timeline */
      renderAgentTimelineSection(timeline);
      renderSearchDebugSection();
      if(!depGraphState.loaded) loadDepGraph();
    }

    if(currentRoute==='settings'){
      renderGovernancePanel();
    }

    var lastEl=document.getElementById('last-updated');
    if(lastEl) lastEl.textContent='Updated '+new Date().toLocaleTimeString();
  }catch(e){
    console.error('Refresh failed:',e);
  }finally{
    refreshInFlight=false;
  }
}

/* ── Agent Badges in Ticket Cards ─────────────── */
function buildAgentBadgesHtml(ticket){
  if(!ticket.agents||!ticket.agents.length) return '';
  var badges=ticket.agents.map(function(a){
    var roleClass=a.role||'developer';
    var dotClass=a.presence||'open';
    var label=a.agentName||a.label||a.role;
    var note=a.progressNote?' · '+esc(a.progressNote.slice(0,40)):'';
    return '<div class="agent-badge"><span class="agent-dot '+esc(dotClass)+'"></span>'
      +'<span class="role-badge '+esc(roleClass)+'">'+esc(a.specialization||a.role)+'</span>'
      +'<span>'+esc(label)+'</span>'
      +'<span class="agent-note">'+note+'</span></div>';
  }).join('');
  return '<div class="board-card-agents">'+badges+'</div>';
}

/* ── Screen: Job Board ────────────────────────── */
/* NOTE: All user-facing strings passed through esc() (HTML entity escaping) */
/* Data is server-generated from DB queries, not direct user input */
function renderJobBoardScreen(host){
  host.textContent='';
  var header=document.createElement('div');
  header.className='main-header';
  header.innerHTML='<div><div class="main-title">Job Board</div><div class="main-subtitle">Loop workforce &amp; agent assignments</div></div>'
    +'<div class="header-actions"><button class="btn" onclick="refreshJobBoard()">Refresh</button></div>';
  host.appendChild(header);
  var summary=document.createElement('div');
  summary.id='jobboard-summary';
  host.appendChild(summary);
  var board=document.createElement('div');
  board.id='jobboard-board';
  host.appendChild(board);
  refreshJobBoard();
}

async function refreshJobBoard(){
  try{
    var data=await api('jobboard');
    if(!data) return;
    var summaryEl=document.getElementById('jobboard-summary');
    var boardEl=document.getElementById('jobboard-board');
    if(!summaryEl||!boardEl) return;

    /* Update nav count */
    var activeSlots=data.slots.filter(function(s){return s.status==='active'||s.status==='claimed'}).length;
    var countEl=document.getElementById('nav-count-jobs');
    if(countEl) countEl.textContent=String(data.slots.length);

    if(!data.slots.length){
      summaryEl.textContent='';
      var emptyDiv=document.createElement('div');
      emptyDiv.className='empty';
      emptyDiv.textContent='No loops created yet. Use create_loop to start a loop.';
      summaryEl.appendChild(emptyDiv);
      boardEl.textContent='';
      return;
    }

    /* Agent summary panel — built from server DB data, all strings escaped */
    var loopGroups={};
    data.slots.forEach(function(s){
      if(!loopGroups[s.loopId]) loopGroups[s.loopId]={slots:[],stats:{open:0,claimed:0,active:0,completed:0,abandoned:0}};
      loopGroups[s.loopId].slots.push(s);
      if(loopGroups[s.loopId].stats[s.status]!==undefined) loopGroups[s.loopId].stats[s.status]++;
    });

    var panelHtml='';
    Object.keys(loopGroups).forEach(function(loopId){
      var group=loopGroups[loopId];
      var stats=group.stats;
      var working=stats.claimed+stats.active;
      panelHtml+='<div style="margin-bottom:1rem">'
        +'<div class="agent-summary-header">'
        +'<div class="agent-summary-title">LOOP: '+esc(loopId)+'</div>'
        +'<div class="agent-summary-stats">'+working+'/'+group.slots.length+' active &middot; '+stats.open+' open &middot; '+stats.completed+' completed</div>'
        +'</div>'
        +'<div class="agent-summary-panel">';
      group.slots.forEach(function(s){
        var isOpen=s.status==='open';
        var roleClass=s.role||'developer';
        var specLabel=s.specialization?s.specialization:s.role;
        var dotClass=isOpen?'open':s.presence||'offline';
        panelHtml+='<div class="agent-pill'+(isOpen?' open-slot':'')+'">'
          +'<div style="display:flex;align-items:center;gap:.3rem">'
          +'<span class="agent-dot '+esc(dotClass)+'"></span>'
          +'<span class="pill-role role-badge '+esc(roleClass)+'">'+esc(specLabel)+'</span></div>'
          +'<div class="pill-name">'+(isOpen?'(open slot)':esc(s.agent?s.agent.name:s.label))+'</div>'
          +(s.agent&&s.agent.model?'<div class="pill-note">'+esc(s.agent.model)+'</div>':'')
          +(s.ticket?'<div class="pill-ticket" onclick="navigate(\\x27tickets\\x27)">'+esc(s.ticket.ticketId)+'</div>':'')
          +(s.progressNote?'<div class="pill-note">'+esc(s.progressNote.slice(0,50))+'</div>':'')
          +'</div>';
      });
      panelHtml+='</div></div>';
    });
    /* All values above are escaped via esc() — safe for innerHTML */
    summaryEl.innerHTML=panelHtml;

    /* Show linked ticket count below */
    var loopTicketIds={};
    data.slots.forEach(function(s){if(s.ticket) loopTicketIds[s.ticket.ticketId]=true});
    var ticketCount=Object.keys(loopTicketIds).length;
    if(ticketCount>0){
      boardEl.textContent='';
      var subtitle=document.createElement('div');
      subtitle.className='main-subtitle';
      subtitle.style.cssText='margin:1rem 0 .5rem';
      subtitle.textContent='Tickets in active loops ('+ticketCount+')';
      boardEl.appendChild(subtitle);
    }else{
      boardEl.textContent='';
      var emptyTickets=document.createElement('div');
      emptyTickets.className='empty';
      emptyTickets.style.marginTop='1rem';
      emptyTickets.textContent='No tickets linked to job slots yet. Agents will link tickets as they work.';
      boardEl.appendChild(emptyTickets);
    }
  }catch(e){
    console.error('refreshJobBoard error:',e);
  }
}

/* ── Screen: Convoys ─────────────────────────── */
function renderConvoysScreen(host){
  host.textContent='';
  var header=document.createElement('div');
  header.className='main-header';
  header.innerHTML='<div><div class="main-title">Convoys</div><div class="main-subtitle">Wave-based orchestration progress</div></div>'
    +'<div class="header-actions"><button class="btn" onclick="refreshConvoys()">Refresh</button></div>';
  host.appendChild(header);
  var container=document.createElement('div');
  container.id='convoy-container';
  host.appendChild(container);
  refreshConvoys();
}

async function refreshConvoys(){
  try{
    var data=await api('convoy');
    if(!data) return;
    var container=document.getElementById('convoy-container');
    if(!container) return;
    var convoys=data.convoys||[];

    /* nav count */
    var countEl=document.getElementById('nav-count-convoys');
    if(countEl) countEl.textContent=String(convoys.length);

    if(!convoys.length){
      container.innerHTML='<div class="empty">No convoys launched yet. Use the orchestrator to start a convoy.</div>';
      return;
    }

    /* All values below are escaped via esc() — safe for innerHTML (same pattern as renderJobBoardScreen) */
    var html='';
    convoys.forEach(function(c){
      var statusColor=c.status==='completed'?'var(--green)':c.status==='active'?'var(--blue)':'var(--text3)';
      var wavePercent=c.totalWaves>0?Math.round((c.currentWave/c.totalWaves)*100):0;
      var convoyId='convoy-detail-'+esc(c.groupId);

      html+='<div class="card" style="margin-bottom:1rem;cursor:pointer" onclick="toggleConvoyDetail(\\x27'+esc(c.groupId)+'\\x27)">'
        +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem">'
        +'<div style="display:flex;align-items:center;gap:.75rem">'
        +'<span class="mono" style="font-weight:600;font-size:.9rem">'+esc(c.groupId)+'</span>'
        +'<span style="font-size:.65rem;padding:2px 8px;border-radius:10px;background:'+statusColor+';color:#000;font-weight:600;text-transform:uppercase">'+esc(c.status)+'</span>'
        +'</div>'
        +'<span style="font-size:.7rem;color:var(--text2)">'+esc(c.startedAt||'')+'</span>'
        +'</div>';

      /* Wave progress bar */
      html+='<div style="margin-bottom:.5rem">'
        +'<div style="display:flex;justify-content:space-between;font-size:.7rem;color:var(--text2);margin-bottom:.25rem">'
        +'<span>Wave '+c.currentWave+' / '+c.totalWaves+'</span>'
        +'<span>'+wavePercent+'%</span></div>'
        +'<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">'
        +'<div style="height:100%;width:'+wavePercent+'%;background:var(--accent);border-radius:3px;transition:width .3s"></div>'
        +'</div></div>';

      if(c.integrationBranch){
        html+='<div style="font-size:.65rem;color:var(--text3);margin-bottom:.5rem">Branch: '+esc(c.integrationBranch)+'</div>';
      }

      /* Expandable wave detail */
      html+='<div id="'+convoyId+'" style="display:none;margin-top:.75rem;border-top:1px solid var(--border);padding-top:.75rem">';
      (c.waves||[]).forEach(function(w){
        var waveStatusColor=w.status==='completed'?'var(--green)':w.status==='active'?'var(--blue)':'var(--text3)';
        html+='<div style="margin-bottom:.65rem">'
          +'<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.35rem">'
          +'<span style="width:8px;height:8px;border-radius:50%;background:'+waveStatusColor+'"></span>'
          +'<span style="font-size:.75rem;font-weight:600">Wave '+(w.index+1)+'</span>'
          +'<span style="font-size:.65rem;color:var(--text3);text-transform:uppercase">'+esc(w.status)+'</span>'
          +'</div>';

        /* Ticket grid */
        html+='<div style="display:flex;flex-wrap:wrap;gap:.35rem;padding-left:1.1rem">';
        (w.tickets||[]).forEach(function(t){
          var tc=t.status==='merged'?'var(--green)':t.status==='in_progress'?'var(--blue)':t.status==='dispatched'?'var(--text3)':t.status==='conflicted'?'var(--red)':t.status==='skipped'?'var(--orange)':'var(--text3)';
          html+='<div style="font-size:.6rem;padding:3px 8px;border-radius:4px;background:rgba(255,255,255,.05);border:1px solid '+tc+';color:'+tc+'" title="'+esc(t.status+(t.agentId?' ('+t.agentId+')':''))+'">'
            +esc(t.ticketId.length>16?t.ticketId.slice(0,16)+'\u2026':t.ticketId)
            +'</div>';
        });
        html+='</div></div>';
      });
      html+='</div></div>';
    });
    container.innerHTML=html;
  }catch(e){
    var c2=document.getElementById('convoy-container');
    if(c2) c2.innerHTML='<div class="empty">Failed to load convoy data.</div>';
  }
}

function toggleConvoyDetail(groupId){
  var el=document.getElementById('convoy-detail-'+groupId);
  if(el) el.style.display=el.style.display==='none'?'block':'none';
}

/* ── SSE ─────────────────────────────────────── */
var sseRefreshTimer=null;
function debouncedRefresh(){
  if(sseRefreshTimer!==null) return;
  sseRefreshTimer=setTimeout(function(){sseRefreshTimer=null;refresh();},2000);
}
var sseRetryDelay=1000;
function connectSSE(){
  var pulse=document.getElementById('pulse');
  var es=new EventSource('/api/events');
  es.onopen=function(){if(pulse)pulse.classList.remove('disconnected');if(pulse)pulse.title='SSE connected';sseRetryDelay=1000;};

  var sseHandler=function(eventType){
    return function(){
      addLiveFeedEvent(eventType,'');
      debouncedRefresh();
    };
  };

  es.addEventListener('agent_registered',sseHandler('agent_registered'));
  es.addEventListener('session_changed',sseHandler('session_changed'));
  es.addEventListener('patch_proposed',sseHandler('patch_proposed'));
  es.addEventListener('note_added',sseHandler('note_added'));
  es.addEventListener('event_logged',sseHandler('event_logged'));
  es.addEventListener('index_updated',sseHandler('index_updated'));
  es.addEventListener('knowledge_stored',sseHandler('knowledge_stored'));
  es.addEventListener('ticket_created',sseHandler('ticket_created'));
  es.addEventListener('ticket_assigned',sseHandler('ticket_assigned'));
  es.addEventListener('ticket_status_changed',sseHandler('ticket_status_changed'));
  es.addEventListener('ticket_verdict_submitted',sseHandler('ticket_verdict_submitted'));
  es.addEventListener('ticket_commented',sseHandler('ticket_commented'));
  es.addEventListener('ticket_external_sync',sseHandler('ticket_external_sync'));
  es.addEventListener('job_loop_created',sseHandler('job_loop_created'));
  es.addEventListener('job_slot_claimed',sseHandler('job_slot_claimed'));
  es.addEventListener('job_slot_active',sseHandler('job_slot_active'));
  es.addEventListener('job_slot_completed',sseHandler('job_slot_completed'));
  es.addEventListener('job_slot_released',sseHandler('job_slot_released'));
  es.addEventListener('job_slot_abandoned',sseHandler('job_slot_abandoned'));
  es.addEventListener('job_progress_update',sseHandler('job_progress_update'));
  var convoyHandler=function(eventType){
    return function(){
      addLiveFeedEvent(eventType,'');
      debouncedRefresh();
      if(currentRoute==='convoys') refreshConvoys();
    };
  };
  es.addEventListener('convoy_started',convoyHandler('convoy_started'));
  es.addEventListener('convoy_wave_started',convoyHandler('convoy_wave_started'));
  es.addEventListener('convoy_wave_advanced',convoyHandler('convoy_wave_advanced'));
  es.addEventListener('convoy_completed',convoyHandler('convoy_completed'));
  es.onerror=function(){
    if(pulse){pulse.classList.add('disconnected');pulse.title='SSE disconnected';}
    es.close();setTimeout(connectSSE,sseRetryDelay);
    sseRetryDelay=Math.min(sseRetryDelay*2,30000);
  };
}

/* ── Toast ───────────────────────────────────── */
var toastTimer=null;
function showToast(msg,type){
  var t=document.getElementById('toast');
  if(!t) return;
  if(toastTimer) clearTimeout(toastTimer);
  t.textContent=msg;
  t.className='toast '+type+' show';
  toastTimer=setTimeout(function(){t.classList.remove('show');toastTimer=null;},4000);
}

init();
connectSSE();
setInterval(function(){
  if(document.hidden) return;
  if(currentRoute==='mission'||currentRoute==='agents'){
    api('presence').then(function(agents){renderPresence(agents)}).catch(function(){});
  }
},10000);
</script>
</body>
</html>`;
}
