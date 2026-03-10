import { VERSION } from "../core/constants.js";

export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agora Command Center</title>
<style>
:root{
  --bg:#0a0e14;--surface:#111820;--surface-hover:#151d28;--border:#1c2433;
  --text:#e6edf3;--text2:#7d8b9d;--text3:#4a5567;
  --blue:#3b82f6;--green:#22c55e;--orange:#f59e0b;--red:#ef4444;--purple:#a855f7;--cyan:#06b6d4;
  --radius:10px;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
code,pre,.mono{font-family:'JetBrains Mono','Fira Code',monospace}

/* ── Header ─────────────────────────────────── */
.header{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem;border-bottom:1px solid var(--border);background:var(--surface)}
.header-left{display:flex;align-items:center;gap:.75rem}
.logo{font-size:1.25rem;font-weight:700;color:var(--text);letter-spacing:-.02em}
.logo span{color:var(--blue)}
.version{font-size:.7rem;color:var(--text3);background:var(--bg);padding:2px 8px;border-radius:20px;font-family:monospace}
.repo-name{font-size:.72rem;color:var(--text2);padding:2px 8px;border:1px solid var(--border);border-radius:20px;background:rgba(255,255,255,.03);max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:pulse 2s infinite}
.pulse.disconnected{background:var(--red);box-shadow:0 0 6px var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.header-right{display:flex;align-items:center;gap:.75rem}
.btn{background:var(--bg);border:1px solid var(--border);color:var(--text2);padding:.4rem .9rem;border-radius:6px;cursor:pointer;font-size:.8rem;transition:all .2s}
.btn:hover{color:var(--text);border-color:var(--blue);background:rgba(59,130,246,.08)}

/* ── Main layout ────────────────────────────── */
.main{padding:1.5rem;max-width:1400px;margin:0 auto}

/* ── Stat cards ─────────────────────────────── */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;margin-bottom:1.25rem}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem;border-left:3px solid var(--blue);transition:all .2s;position:relative;overflow:hidden}
.stat:hover{border-color:var(--blue);background:var(--surface-hover);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.3)}
.stat:nth-child(2){border-left-color:var(--green)}
.stat:nth-child(3){border-left-color:var(--cyan)}
.stat:nth-child(4){border-left-color:var(--orange)}
.stat:nth-child(5){border-left-color:var(--purple)}
.stat:nth-child(6){border-left-color:var(--red)}
.stat .icon{font-size:1.1rem;margin-bottom:.3rem}
.stat .label{font-size:.65rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;font-weight:500}
.stat .value{font-size:1.6rem;font-weight:700;margin-top:.15rem;font-family:monospace;letter-spacing:-.02em}

/* ── Charts row ─────────────────────────────── */
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:.75rem;margin-bottom:1.25rem}
.chart-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem;transition:all .2s}
.chart-panel:hover{border-color:rgba(59,130,246,.3)}
.chart-title{font-size:.75rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem}
.chart-title .dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.chart-body{display:flex;align-items:center;gap:1rem;min-height:100px}
.chart-body svg{flex-shrink:0}
.chart-stack{display:flex;flex-direction:column;gap:.85rem;width:100%}
.chart-indicators{display:grid;grid-template-columns:repeat(auto-fit,minmax(86px,1fr));gap:.55rem}
.chart-indicator{border:1px solid rgba(255,255,255,.05);background:rgba(255,255,255,.02);border-radius:8px;padding:.55rem .65rem}
.chart-indicator-value{display:block;color:var(--text);font-family:monospace;font-size:1rem;font-weight:700}
.chart-indicator-label{display:block;color:var(--text3);font-size:.62rem;text-transform:uppercase;letter-spacing:.06em;margin-top:.2rem}
.chart-legend{font-size:.75rem;color:var(--text2);line-height:1.7}
.chart-legend .item{display:flex;align-items:center;gap:.4rem}
.chart-legend .swatch{width:8px;height:8px;border-radius:2px;display:inline-block;flex-shrink:0}
.chart-legend .count{color:var(--text);font-weight:600;font-family:monospace;margin-left:auto;padding-left:.5rem}
.chart-empty{color:var(--text3);font-size:.8rem;font-style:italic;padding:1rem 0}

/* ── Tab bar ────────────────────────────────── */
.tab-bar{display:flex;gap:.4rem;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:0}
.tab{padding:.55rem 1rem;border:none;border-bottom:2px solid transparent;background:none;color:var(--text2);cursor:pointer;font-size:.82rem;font-weight:500;transition:all .15s;border-radius:6px 6px 0 0}
.tab:hover{color:var(--text);background:rgba(255,255,255,.03)}
.tab.active{color:var(--blue);border-bottom-color:var(--blue);background:rgba(59,130,246,.06)}
.tab .count{background:var(--bg);color:var(--text3);font-size:.65rem;padding:1px 6px;border-radius:10px;margin-left:.35rem;font-family:monospace}
.tab.active .count{color:var(--blue);background:rgba(59,130,246,.12)}

/* ── Sections & tables ──────────────────────── */
.section{display:none}.section.active{display:block}
.table-wrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;max-height:500px;overflow-y:auto}
.table-wrap::-webkit-scrollbar{width:6px}
.table-wrap::-webkit-scrollbar-track{background:var(--surface)}
.table-wrap::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
table{width:100%;border-collapse:collapse;font-size:.8rem}
thead{position:sticky;top:0;z-index:1}
th{background:var(--surface-hover);color:var(--text2);font-weight:500;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;padding:.6rem .75rem;text-align:left;border-bottom:1px solid var(--border)}
td{padding:.55rem .75rem;border-bottom:1px solid rgba(28,36,51,.5);color:var(--text2);vertical-align:middle}
tr:hover td{background:rgba(255,255,255,.015);color:var(--text)}
tr:nth-child(even) td{background:rgba(0,0,0,.1)}
td.mono{font-family:monospace;font-size:.75rem;color:var(--text3)}
tr.clickable{cursor:pointer}
tr.clickable.active td{background:rgba(59,130,246,.08);color:var(--text)}

/* ── Badges ─────────────────────────────────── */
.badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:.7rem;font-weight:600;letter-spacing:.02em}
.badge-success,.badge-active,.badge-applied{background:rgba(34,197,94,.1);color:var(--green);box-shadow:0 0 8px rgba(34,197,94,.08)}
.badge-blue,.badge-validated,.badge-a,.badge-decision,.badge-pattern{background:rgba(59,130,246,.1);color:var(--blue);box-shadow:0 0 8px rgba(59,130,246,.08)}
.badge-orange,.badge-b,.badge-proposed,.badge-gotcha{background:rgba(245,158,11,.1);color:var(--orange);box-shadow:0 0 8px rgba(245,158,11,.08)}
.badge-red,.badge-stale,.badge-failed{background:rgba(239,68,68,.1);color:var(--red);box-shadow:0 0 8px rgba(239,68,68,.08)}
.badge-purple,.badge-context,.badge-plan{background:rgba(168,85,247,.1);color:var(--purple);box-shadow:0 0 8px rgba(168,85,247,.08)}
.badge-cyan,.badge-solution,.badge-preference{background:rgba(6,182,212,.1);color:var(--cyan);box-shadow:0 0 8px rgba(6,182,212,.08)}
.badge-global{background:rgba(245,158,11,.1);color:var(--orange)}
.badge-repo{background:rgba(34,197,94,.1);color:var(--green)}

/* ── Empty state ────────────────────────────── */
.empty{color:var(--text3);font-size:.82rem;padding:2rem;text-align:center;font-style:italic}

/* ── Toast notifications ───────────────────── */
.toast{position:fixed;bottom:1.5rem;right:1.5rem;padding:.75rem 1.25rem;border-radius:8px;font-size:.82rem;color:var(--text);z-index:100;opacity:0;transform:translateY(10px);transition:all .3s ease;pointer-events:none;max-width:380px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.toast.show{opacity:1;transform:translateY(0);pointer-events:auto}
.toast.success{background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.3)}
.toast.error{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3)}

/* ── Export button ─────────────────────────── */
.btn-export{background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.25);color:var(--purple)}
.btn-export:hover{border-color:var(--purple);background:rgba(168,85,247,.15);color:var(--text)}

/* ── Presence panel ────────────────────────── */
.presence-title{font-size:.75rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-bottom:.6rem;display:flex;align-items:center;gap:.5rem}
.presence-title .dot{width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block}
.presence{display:flex;flex-wrap:wrap;gap:.6rem;margin-bottom:1.25rem}
.agent-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:.85rem 1rem;min-width:220px;flex:1 1 220px;max-width:320px;transition:all .2s;display:flex;align-items:flex-start;gap:.65rem}
.agent-card:hover{border-color:rgba(59,130,246,.3);background:var(--surface-hover);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.3)}
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

/* ── Ticket detail ──────────────────────────── */
.detail-card{margin-top:.9rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem}
.detail-head{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;margin-bottom:.85rem}
.detail-title{font-size:1rem;font-weight:700;color:var(--text)}
.detail-sub{font-size:.72rem;color:var(--text2);margin-top:.25rem;display:flex;gap:.45rem;flex-wrap:wrap}
.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;margin-bottom:.9rem}
.detail-block{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.04);border-radius:8px;padding:.75rem}
.detail-label{font-size:.64rem;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.35rem}
.detail-value{font-size:.8rem;color:var(--text2);line-height:1.5}
.detail-section{margin-top:1rem}
.detail-section h4{font-size:.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.55rem}
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
.board-column-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.board-column-title{font-size:.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em}
.board-column-count{font-family:monospace;font-size:.72rem;color:var(--text3)}
.board-list{display:flex;flex-direction:column;gap:.6rem}
.board-card{border:1px solid rgba(255,255,255,.05);border-left:3px solid rgba(59,130,246,.45);border-radius:8px;background:rgba(255,255,255,.02);padding:.7rem;cursor:pointer;transition:all .15s}
.board-card:hover{background:rgba(255,255,255,.04);border-color:rgba(59,130,246,.25)}
.board-card.active{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.35)}
.board-card-title{font-size:.8rem;color:var(--text);font-weight:600;line-height:1.35;margin:.35rem 0}
.board-card-meta{display:flex;gap:.4rem;flex-wrap:wrap;font-size:.68rem;color:var(--text3)}
.board-card-sub{font-size:.68rem;color:var(--text3);font-family:monospace}
.field{display:flex;flex-direction:column;gap:.35rem;margin-bottom:.7rem}
.field label{font-size:.68rem;color:var(--text3);text-transform:uppercase;letter-spacing:.05em}
.field input,.field textarea,.field select{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:.6rem .7rem;font-size:.8rem}
.field textarea{min-height:88px;resize:vertical}
.field-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.65rem}
.action-submit{background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.3);color:var(--text);padding:.55rem .9rem;border-radius:8px;cursor:pointer;font-size:.78rem}
.action-submit:hover{background:rgba(59,130,246,.18)}
.action-submit:disabled{opacity:.55;cursor:not-allowed}
.action-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem}
.actor-chip{display:inline-flex;align-items:center;gap:.35rem;font-size:.72rem;color:var(--text2);padding:.25rem .55rem;border-radius:20px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05)}

/* ── Footer ─────────────────────────────────── */
footer{text-align:center;font-size:.7rem;color:var(--text3);padding:1.5rem;border-top:1px solid var(--border);margin-top:1rem}
footer a{color:var(--blue);text-decoration:none}
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <div class="logo"><span>&#9670;</span> Agora</div>
    <span class="version">v${VERSION}</span>
    <span class="repo-name" id="repo-name" title="Repository name">loading…</span>
    <div class="pulse" id="pulse" title="SSE connected"></div>
  </div>
  <div class="header-right">
    <span style="font-size:.75rem;color:var(--text3)" id="last-updated"></span>
    <button class="btn btn-export" id="export-btn" title="Export knowledge to Obsidian markdown vault">&#128214; Export Obsidian</button>
    <button class="btn" id="refresh-btn">&#8635; Refresh</button>
  </div>
</div>

<div class="main">
  <div class="stats" id="overview"></div>
  <div class="presence-title"><span class="dot"></span> Live Agents</div>
  <div class="presence" id="presence"><div class="empty" style="width:100%">No agents registered yet</div></div>
  <div class="charts" id="charts"></div>
  <div class="tab-bar" id="tab-bar"></div>
  <div id="agents" class="section active"></div>
  <div id="logs" class="section"></div>
  <div id="patches" class="section"></div>
  <div id="notes" class="section"></div>
  <div id="knowledge" class="section"></div>
  <div id="tickets" class="section"></div>
</div>

<footer>Agora &mdash; Multi-agent shared context &amp; coordination server</footer>
<div class="toast" id="toast"></div>

<script>
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const api=p=>fetch('/api/'+p).then(r=>r.json());
const tabs=[['agents','Agents'],['logs','Activity Log'],['patches','Patches'],['notes','Notes'],['knowledge','Knowledge'],['tickets','Tickets']];
const PALETTE=['#3b82f6','#22c55e','#f59e0b','#a855f7','#06b6d4','#ec4899','#6366f1','#ef4444','#14b8a6','#f97316'];
const COMMENT_TONES=[
  {accent:'#3b82f6',bg:'rgba(59,130,246,.10)'},
  {accent:'#22c55e',bg:'rgba(34,197,94,.10)'},
  {accent:'#f59e0b',bg:'rgba(245,158,11,.10)'},
  {accent:'#a855f7',bg:'rgba(168,85,247,.10)'},
  {accent:'#06b6d4',bg:'rgba(6,182,212,.10)'},
  {accent:'#ef4444',bg:'rgba(239,68,68,.10)'},
  {accent:'#ec4899',bg:'rgba(236,72,153,.10)'},
  {accent:'#14b8a6',bg:'rgba(20,184,166,.10)'}
];
const COMMENT_EMOJIS=['🤖','🧠','🧪','🛠️','📡','🛰️','🔎','⚙️','🧭','📝'];
const TYPE_COLORS={decision:'#3b82f6',gotcha:'#f59e0b',pattern:'#a855f7',context:'#06b6d4',plan:'#ec4899',solution:'#22c55e',preference:'#6366f1',runbook:'#14b8a6'};
const STATE_COLORS={proposed:'#f59e0b',validated:'#3b82f6',applied:'#22c55e',committed:'#22c55e',stale:'#ef4444',failed:'#ef4444'};
const TICKET_STATUS_CLS={resolved:'success',closed:'success',technical_analysis:'purple',in_progress:'blue',in_review:'blue',backlog:'orange',assigned:'orange',blocked:'red',wont_fix:'red'};
const TICKET_TRANSITIONS={backlog:['technical_analysis','assigned','wont_fix'],technical_analysis:['backlog','assigned','wont_fix'],assigned:['in_progress','wont_fix'],in_progress:['in_review','blocked','wont_fix'],in_review:['in_progress','resolved'],blocked:['in_progress'],resolved:['in_progress','closed'],closed:[],wont_fix:[]};
const TICKET_BOARD_COLUMNS=[
  {id:'backlog',label:'Backlog',statuses:['backlog']},
  {id:'technical_analysis',label:'Technical Analysis',statuses:['technical_analysis']},
  {id:'assigned',label:'Assigned',statuses:['assigned']},
  {id:'in_progress',label:'In Progress',statuses:['in_progress']},
  {id:'in_review',label:'In Review',statuses:['in_review']},
  {id:'blocked',label:'Blocked',statuses:['blocked']},
  {id:'done',label:'Done',statuses:['resolved','closed','wont_fix']}
];
let tabCounts={agents:0,logs:0,patches:0,notes:0,knowledge:0,tickets:0};
let selectedTicketId=null;
let selectedTicketDetail=null;
let selectedActorSessionId=null;
let ticketActors=[];
let dashboardAgents=[];
let ticketViewMode='table';
let ticketFilters={search:'',status:'all',severity:'all',assignee:'all'};

function repoBasename(repoPath){
  if(!repoPath) return 'unknown repo';
  var clean=String(repoPath).replace(/[\\\\/]+$/,'');
  var parts=clean.split(/[\\\\/]/);
  return parts[parts.length-1]||clean;
}

function actorLabel(actor){
  return actor.name+' ('+actor.role+') · '+actor.sessionId.slice(0,12);
}

function getSelectedActor(){
  if(!ticketActors.length) return null;
  var found=ticketActors.find(function(actor){return actor.sessionId===selectedActorSessionId});
  if(found) return found;
  selectedActorSessionId=ticketActors[0].sessionId;
  return ticketActors[0];
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
  var center='<text x="'+cx+'" y="'+cy+'" text-anchor="middle" dominant-baseline="central" fill="#e6edf3" font-size="'+(size*.18).toFixed(0)+'" font-weight="700" font-family="monospace">'+total+'</text>';
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
    bars+='<text x="'+(w+6).toFixed(1)+'" y="'+(y+barH/2)+'" dominant-baseline="central" fill="#7d8b9d" font-size="11" font-family="monospace">'+d.value+'</text>';
    bars+='<text x="'+width+'" y="'+(y+barH/2)+'" text-anchor="end" dominant-baseline="central" fill="#4a5567" font-size="10">'+d.label+'</text>';
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
  var gradient='<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b82f6" stop-opacity="0.3"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0.02"/></linearGradient></defs>';
  return '<svg width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'">'+gradient+'<path d="'+area+'" fill="url(#sg)"/><polyline points="'+pts+'" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/></svg>';
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

function agentShortLabel(agentId){
  var parts=String(agentId||'-').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if(parts.length>1){
    return parts.slice(0,2).map(function(part){return part.charAt(0).toUpperCase()}).join('');
  }
  var compact=String(agentId||'-').replace(/[^a-zA-Z0-9]/g,'').toUpperCase();
  return compact.slice(0,2)||'--';
}

/* ── Init ────────────────────────────────────── */
function init(){
  var bar=document.getElementById('tab-bar');
  tabs.forEach(function(t,i){
    var id=t[0],label=t[1];
    var btn=document.createElement('button');
    btn.className='tab'+(i===0?' active':'');
    btn.id='tab-'+id;
    btn.innerHTML=esc(label)+'<span class="count" id="count-'+id+'">0</span>';
    btn.addEventListener('click',function(){showTab(id,btn)});
    bar.appendChild(btn);
  });
  document.getElementById('refresh-btn').addEventListener('click',refresh);
  refresh();
}

function showTab(id,btn){
  document.querySelectorAll('.section').forEach(function(s){s.classList.remove('active')});
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
  refresh();
}

function updateCounts(){
  Object.keys(tabCounts).forEach(function(k){
    var el=document.getElementById('count-'+k);
    if(el) el.textContent=tabCounts[k];
  });
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

function renderTicketToolbar(tickets,filteredTickets){
  var actor=getSelectedActor();
  var actorOptions=ticketActors.map(function(option){
    return '<option value="'+esc(option.sessionId)+'"'+(actor&&actor.sessionId===option.sessionId?' selected':'')+'>'+esc(actorLabel(option))+'</option>';
  }).join('');
  var assigneeOptions=ticketAssigneeOptions(tickets).map(function(option){
    return '<option value="'+esc(option.value)+'"'+(ticketFilters.assignee===option.value?' selected':'')+'>'+esc(option.label)+'</option>';
  }).join('');
  return '<div class="ticket-toolbar-top">'
    +'<div class="ticket-toolbar-meta">Showing '+esc(String(filteredTickets.length))+' of '+esc(String(tickets.length))+' tickets</div>'
    +'<div class="view-toggle">'
      +'<button type="button" class="view-btn'+(ticketViewMode==='table'?' active':'')+'" data-ticket-view="table">Table</button>'
      +'<button type="button" class="view-btn'+(ticketViewMode==='board'?' active':'')+'" data-ticket-view="board">Board</button>'
    +'</div>'
  +'</div>'
  +'<div class="ticket-toolbar">'
    +'<div class="action-card"><h4>Active Session</h4>'
    +(ticketActors.length
      ?'<div class="field"><label for="ticket-actor-select">Act as</label><select id="ticket-actor-select">'+actorOptions+'</select></div><div class="actor-chip">Using '+esc(actorLabel(actor))+'</div>'
      :'<div class="ticket-help">No active agent sessions available. Register an agent first to create or update tickets.</div>')
    +'</div>'
    +'<div class="action-card"><h4>Filters</h4>'
      +'<div class="filters-grid">'
        +'<div class="field"><label for="ticket-filter-search">Search</label><input id="ticket-filter-search" value="'+esc(ticketFilters.search||'')+'" placeholder="ID, title, creator"></div>'
        +'<div class="field"><label for="ticket-filter-status">Status</label><select id="ticket-filter-status"><option value="all"'+(ticketFilters.status==='all'?' selected':'')+'>All statuses</option><option value="backlog"'+(ticketFilters.status==='backlog'?' selected':'')+'>backlog</option><option value="technical_analysis"'+(ticketFilters.status==='technical_analysis'?' selected':'')+'>technical_analysis</option><option value="assigned"'+(ticketFilters.status==='assigned'?' selected':'')+'>assigned</option><option value="in_progress"'+(ticketFilters.status==='in_progress'?' selected':'')+'>in_progress</option><option value="in_review"'+(ticketFilters.status==='in_review'?' selected':'')+'>in_review</option><option value="blocked"'+(ticketFilters.status==='blocked'?' selected':'')+'>blocked</option><option value="resolved"'+(ticketFilters.status==='resolved'?' selected':'')+'>resolved</option><option value="closed"'+(ticketFilters.status==='closed'?' selected':'')+'>closed</option><option value="wont_fix"'+(ticketFilters.status==='wont_fix'?' selected':'')+'>wont_fix</option></select></div>'
        +'<div class="field"><label for="ticket-filter-severity">Severity</label><select id="ticket-filter-severity"><option value="all"'+(ticketFilters.severity==='all'?' selected':'')+'>All severities</option><option value="critical"'+(ticketFilters.severity==='critical'?' selected':'')+'>critical</option><option value="high"'+(ticketFilters.severity==='high'?' selected':'')+'>high</option><option value="medium"'+(ticketFilters.severity==='medium'?' selected':'')+'>medium</option><option value="low"'+(ticketFilters.severity==='low'?' selected':'')+'>low</option></select></div>'
        +'<div class="field"><label for="ticket-filter-assignee">Assignee</label><select id="ticket-filter-assignee">'+assigneeOptions+'</select></div>'
      +'</div>'
    +'</div>'
    +'<div class="action-card"><h4>Create Ticket</h4>'
    +(ticketActors.length
      ?'<form id="create-ticket-form">'
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
        +'<div class="field"><label for="create-ticket-criteria">Acceptance Criteria</label><textarea id="create-ticket-criteria" name="criteria" maxlength="2000"></textarea></div>'
        +'<button class="action-submit" type="submit">Create Ticket</button>'
      +'</form>'
      :'<div class="ticket-help">Ticket creation is unavailable until there is an active developer, reviewer, or admin session.</div>')
    +'</div>'
  +'</div>';
}

function renderTicketMetrics(metrics){
  if(!metrics) return '';
  var statusOrder=['backlog','technical_analysis','assigned','in_progress','in_review','blocked','resolved','closed','wont_fix'];
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
  return '<div class="ticket-metrics">'
    +'<div class="metric-card"><h4>Status Mix</h4>'+rows(statusRows)+'</div>'
    +'<div class="metric-card"><h4>Severity Mix</h4>'+rows(severityRows)+'</div>'
    +'<div class="metric-card"><h4>Aging Buckets</h4>'+rows(agingRows)+'</div>'
    +'<div class="metric-card"><h4>Blocked Tickets</h4><div class="metric-row"><span>Count</span><strong>'+esc(String(metrics.blockedCount||0))+'</strong></div>'+rows(blockedRows)+'</div>'
    +'<div class="metric-card"><h4>Unassigned Open</h4><div class="metric-row"><span>Count</span><strong>'+esc(String(metrics.unassignedOpenCount||0))+'</strong></div>'+rows(unassignedRows)+'</div>'
    +'<div class="metric-card"><h4>Assignee Load</h4>'+rows(assigneeRows)+'</div>'
  +'</div>';
}

function attachTicketToolbarListeners(){
  document.querySelectorAll('[data-ticket-view]').forEach(function(button){
    button.addEventListener('click',function(){
      ticketViewMode=button.getAttribute('data-ticket-view')||'table';
      renderTicketsSection(window.__agoraTickets||[]);
    });
  });

  var actorSelect=document.getElementById('ticket-actor-select');
  if(actorSelect){
    actorSelect.addEventListener('change',function(e){
      selectedActorSessionId=e.target.value||null;
      renderTicketsSection(window.__agoraTickets||[]);
    });
  }

  var searchInput=document.getElementById('ticket-filter-search');
  if(searchInput){
    searchInput.addEventListener('input',function(e){
      ticketFilters.search=e.target.value||'';
      renderTicketsSection(window.__agoraTickets||[]);
    });
  }

  ['status','severity','assignee'].forEach(function(key){
    var el=document.getElementById('ticket-filter-'+key);
    if(!el) return;
    el.addEventListener('change',function(e){
      ticketFilters[key]=e.target.value||'all';
      renderTicketsSection(window.__agoraTickets||[]);
    });
  });

  var createForm=document.getElementById('create-ticket-form');
  if(createForm){
    createForm.addEventListener('submit',async function(e){
      e.preventDefault();
      var actor=getSelectedActor();
      if(!actor){
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
          agentId:actor.agentId,
          sessionId:actor.sessionId,
        });
        selectedTicketId=created.ticketId;
        selectedTicketDetail=null;
        createForm.reset();
        document.getElementById('create-ticket-severity').value='medium';
        document.getElementById('create-ticket-priority').value='5';
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
  var host=document.getElementById('ticket-detail');
  if(!host) return;
  if(error){
    host.innerHTML='<div class="detail-card"><div class="ticket-help">'+esc(error)+'</div></div>';
    return;
  }
  if(!selectedTicketId){
    host.innerHTML='<div class="ticket-help">Select a ticket to view comments, history, and linked patches.</div>';
    return;
  }
  if(!selectedTicketDetail){
    host.innerHTML='<div class="detail-card"><div class="ticket-help">Loading ticket details…</div></div>';
    return;
  }
  var t=selectedTicketDetail;
  var comments=(t.comments||[]).map(function(c){
    var tone=commentTone(c.agentId||'-');
    var persona=commentPersona(c);
    var shortLabel=agentShortLabel(c.agentName||c.agentId||'-');
    return '<div class="comment-item" style="--comment-accent:'+tone.accent+';--comment-bg:'+tone.bg+'">'
      +'<div class="comment-meta">'
      +'<span class="comment-author"><span class="comment-author-swatch"></span>'+persona.emoji+' '+esc(shortLabel)+' · '+esc(persona.name)+'<span class="comment-author-id">'+(c.agentName&&c.agentName!==c.agentId?'('+esc(c.agentId||'-')+')':'')+'</span></span>'
      +'<span class="comment-time">'+esc(new Date(c.createdAt).toLocaleString())+'</span>'
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
  var actor=getSelectedActor();
  var assigneeOptions=dashboardAgents.map(function(agent){
    return '<option value="'+esc(agent.id)+'"'+(t.assigneeAgentId===agent.id?' selected':'')+'>'+esc(agent.name+' ('+agent.role+')')+'</option>';
  }).join('');
  var statusOptions=(TICKET_TRANSITIONS[t.status]||[]).map(function(status){
    return '<option value="'+esc(status)+'">'+esc(status)+'</option>';
  }).join('');
  var actionsHtml=actor
    ?'<div class="action-grid">'
      +'<form class="action-card" id="assign-ticket-form"><h4>Assign</h4><div class="actor-chip">Acting as '+esc(actorLabel(actor))+'</div><div class="field"><label for="ticket-assignee-select">Assignee</label><select id="ticket-assignee-select">'+assigneeOptions+'</select></div><button class="action-submit" type="submit">Assign Ticket</button></form>'
      +'<form class="action-card" id="status-ticket-form"><h4>Transition</h4><div class="actor-chip">Acting as '+esc(actorLabel(actor))+'</div><div class="field"><label for="ticket-status-select">Next Status</label><select id="ticket-status-select"'+(statusOptions?'':' disabled')+'>'+(statusOptions||'<option value="">No transitions available</option>')+'</select></div><div class="field"><label for="ticket-status-comment">Comment</label><textarea id="ticket-status-comment" maxlength="500" placeholder="Optional transition note"></textarea></div><button class="action-submit" type="submit"'+(statusOptions?'':' disabled')+'>Update Status</button></form>'
      +'<form class="action-card" id="comment-ticket-form"><h4>Add Comment</h4><div class="actor-chip">Acting as '+esc(actorLabel(actor))+'</div><div class="field"><label for="ticket-comment-content">Comment</label><textarea id="ticket-comment-content" maxlength="2000" placeholder="Provide context for the next agent"></textarea></div><button class="action-submit" type="submit">Post Comment</button></form>'
    +'</div>'
    :'<div class="ticket-help">No active session selected. Register an agent to comment or move tickets.</div>';
  host.innerHTML='<div class="detail-card">'
    +'<div class="detail-head"><div><div class="detail-title">'+esc(t.title||t.ticketId)+'</div><div class="detail-sub"><span>'+esc(t.ticketId)+'</span><span>'+esc(new Date(t.updatedAt).toLocaleString())+'</span></div></div><div><span class="badge badge-'+(TICKET_STATUS_CLS[t.status]||'blue')+'">'+esc(t.status)+'</span></div></div>'
    +'<div class="detail-grid">'
    +'<div class="detail-block"><div class="detail-label">Description</div><div class="detail-value">'+esc(t.description||'-')+'</div></div>'
    +'<div class="detail-block"><div class="detail-label">Acceptance Criteria</div><div class="detail-value">'+esc(t.acceptanceCriteria||'-')+'</div></div>'
    +'<div class="detail-block"><div class="detail-label">Ownership</div><div class="detail-value">Creator: '+esc(t.creatorAgentId||'-')+'<br>Assignee: '+esc(t.assigneeAgentId||'-')+'</div></div>'
    +'<div class="detail-block"><div class="detail-label">Context</div><div class="detail-value">Severity: '+esc(t.severity||'-')+'<br>Priority: '+esc(String(t.priority??'-'))+'<br>Commit: '+esc((t.commitSha||'-').slice(0,7))+'</div></div>'
    +'<div class="detail-block"><div class="detail-label">Tags</div><div class="detail-value">'+esc(tags)+'</div></div>'
    +'<div class="detail-block"><div class="detail-label">Affected Paths</div><div class="detail-value">'+esc(affectedPaths)+'</div></div>'
    +'</div>'
    +'<div class="detail-section"><h4>Actions</h4>'+actionsHtml+'</div>'
    +'<div class="detail-section"><h4>Comments</h4><div class="comment-list">'+comments+'</div></div>'
    +'<div class="detail-section"><h4>History</h4><div class="history-list">'+history+'</div></div>'
    +'<div class="detail-section"><h4>Linked Patches</h4><div class="patch-list">'+patches+'</div></div>'
    +'</div>';
  attachTicketDetailListeners(t);
}

function renderTicketsSection(tickets,metrics){
  var section=document.getElementById('tickets');
  var filteredTickets=filterTicketList(tickets);
  window.__agoraTickets=tickets;
  window.__agoraTicketMetrics=metrics||window.__agoraTicketMetrics||null;
  section.innerHTML='';
  section.insertAdjacentHTML('beforeend',renderTicketMetrics(window.__agoraTicketMetrics));
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
    TICKET_BOARD_COLUMNS.forEach(function(column){
      var columnTickets=filteredTickets.filter(function(ticket){return column.statuses.includes(ticket.status)});
      var col=document.createElement('div');
      col.className='board-column';
      col.innerHTML='<div class="board-column-head"><div class="board-column-title">'+esc(column.label)+'</div><div class="board-column-count">'+esc(String(columnTickets.length))+'</div></div>';
      var list=document.createElement('div');
      list.className='board-list';
      if(!columnTickets.length){
        list.innerHTML='<div class="ticket-help">No tickets</div>';
      }else{
        columnTickets.forEach(function(ticket){
          var card=document.createElement('div');
          card.className='board-card'+(selectedTicketId===ticket.ticketId?' active':'');
          card.addEventListener('click',function(){loadTicketDetail(ticket.ticketId)});
          card.innerHTML='<div class="board-card-sub">'+esc(ticket.ticketId)+'</div>'
            +'<div class="board-card-title">'+esc(ticket.title)+'</div>'
            +'<div class="board-card-meta"><span class="badge badge-'+(TICKET_STATUS_CLS[ticket.status]||'blue')+'">'+esc(ticket.status)+'</span><span class="badge badge-'+(ticket.severity==='critical'?'red':ticket.severity==='high'?'orange':'blue')+'">'+esc(ticket.severity)+'</span><span>P'+esc(String(ticket.priority))+'</span></div>'
            +'<div class="board-card-meta"><span>'+(ticket.assignee?esc(ticket.assignee):'unassigned')+'</span><span>'+esc(new Date(ticket.updatedAt).toLocaleDateString())+'</span></div>';
          list.appendChild(card);
        });
      }
      col.appendChild(list);
      board.appendChild(col);
    });
    section.appendChild(board);
  }else{
    var wrap=document.createElement('div');
    wrap.className='table-wrap';
    var table=document.createElement('table');
    var thead=document.createElement('thead');
    var hr=document.createElement('tr');
    ['ID','Title','Status','Severity','Priority','Assignee','Creator','Updated'].forEach(function(h){var th=document.createElement('th');th.textContent=h;hr.appendChild(th)});
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody=document.createElement('tbody');
    filteredTickets.forEach(function(t){
      var tr=document.createElement('tr');
      tr.className='clickable'+(selectedTicketId===t.ticketId?' active':'');
      tr.addEventListener('click',function(){loadTicketDetail(t.ticketId)});
      [
        m(t.ticketId),
        t.title.slice(0,60),
        b(t.status,TICKET_STATUS_CLS[t.status]||'blue'),
        b(t.severity,t.severity==='critical'?'red':t.severity==='high'?'orange':'blue'),
        t.priority,
        t.assignee||'-',
        t.creator||'-',
        new Date(t.updatedAt).toLocaleString(),
      ].forEach(function(cell){
        var td=document.createElement('td');
        if(typeof cell==='object'&&cell&&cell.badge){var s=document.createElement('span');s.className='badge badge-'+cell.cls;s.textContent=cell.badge;td.appendChild(s);}
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

function attachTicketDetailListeners(ticket){
  var actor=getSelectedActor();
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
  var topBucket=fileData.length?fileData[0].label:'none';
  var filesPanel=makeChartPanel(
    'Indexed Files',
    'orange',
    colorMap,
    '<div class="chart-stack">'
      +(fileData.length?makeBarChart(fileData,240,18,5):mkEmpty('No indexed files'))
      +makeIndicators([
        {label:'Indexed',value:indexedFiles.totalFiles||overview.fileCount||0},
        {label:'Buckets',value:indexedFiles.uniqueBuckets||0},
        {label:'Top',value:topBucket},
        {label:'Unknown',value:indexedFiles.unknownFiles||0},
      ])
    +'</div>'
  );

  /* Knowledge by type bars */
  var typeCounts={};
  knowledge.forEach(function(k){typeCounts[k.type]=(typeCounts[k.type]||0)+1});
  var typeData=Object.entries(typeCounts).sort(function(a,b){return b[1]-a[1]}).map(function(e){return{label:e[0],value:e[1],color:TYPE_COLORS[e[0]]||'#3b82f6'}});
  var kPanel=makeChartPanel('Knowledge Types','cyan',colorMap,typeData.length?makeBarChart(typeData,240,18,5):mkEmpty());

  /* Patch states donut */
  var stateCounts={};
  patches.forEach(function(p){stateCounts[p.state]=(stateCounts[p.state]||0)+1});
  var stateData=Object.entries(stateCounts).map(function(e){return{label:e[0],value:e[1],color:STATE_COLORS[e[0]]||'#3b82f6'}});
  var pPanel=makeChartPanel('Patch States','green',colorMap,'<div class="chart-body">'+makeDonut(stateData,90,14)+'<div class="chart-legend">'+makeLegend(stateData)+'</div></div>');

  container.replaceChildren(sparkPanel,toolPanel,filesPanel,kPanel,pPanel);
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

async function refreshPresence(){
  try{
    var agents=await api('presence');
    renderPresence(agents);
  }catch(e){console.error('Presence refresh failed:',e)}
}

/* ── Main refresh ────────────────────────────── */
async function refresh(){
  try{
    var results=await Promise.all([
      api('overview'),api('agents'),api('logs'),api('patches'),api('notes'),api('knowledge'),api('presence'),api('tickets'),api('tickets/metrics'),api('files')
    ]);
    var o=results[0],agents=results[1],logs=results[2],patches=results[3],notes=results[4],knowledge=results[5],presence=results[6],tickets=results[7],ticketMetrics=results[8],files=results[9];
    dashboardAgents=agents;
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

    /* Overview cards */
    var ov=document.getElementById('overview');
    var repoName=repoBasename(o.repoPath);
    var repoEl=document.getElementById('repo-name');
    if(repoEl){repoEl.textContent=repoName;repoEl.title=o.repoPath||repoName;}
    ov.replaceChildren(
      makeCard('&#128193;','Files Indexed',o.fileCount),
      makeCard('&#129302;','Agents',o.totalAgents),
      makeCard('&#9889;','Active Sessions',o.activeSessions),
      makeCard('&#128230;','Patches',o.totalPatches),
      makeCard('&#127915;','Open Tickets',o.openTickets!=null?o.openTickets+'/'+o.totalTickets:'0'),
      makeCard('&#127793;','Indexed Commit',o.indexedCommit?o.indexedCommit.slice(0,7):'none'),
      makeCard('&#128279;','Topology',o.coordinationTopology));

    /* Presence */
    renderPresence(presence);

    /* Charts */
    renderCharts(o,logs,patches,knowledge,presence,files);

    /* Tab counts */
    tabCounts={agents:agents.length,logs:logs.length,patches:patches.length,notes:notes.length,knowledge:knowledge.length,tickets:tickets.length};
    updateCounts();

    /* Agents */
    document.getElementById('agents').replaceChildren(makeTable(
      ['ID','Name','Type','Role','Tier','Sessions'],
      agents.map(function(a){return[m(a.id),a.name,a.type,b(a.role,a.role),b(a.trustTier,a.trustTier.toLowerCase()),a.activeSessions]})));

    /* Logs */
    document.getElementById('logs').replaceChildren(makeTable(
      ['Event','Agent','Tool','Status','Duration','In','Out','Time'],
      logs.map(function(l){return[m(l.eventId.slice(0,10)),l.agentId||'-',b(l.tool,'a'),b(l.status,l.status==='success'?'success':'red'),m(l.durationMs+'ms'),l.payloadSizeIn||'-',l.payloadSizeOut||'-',new Date(l.timestamp).toLocaleTimeString()]})));

    /* Patches */
    document.getElementById('patches').replaceChildren(makeTable(
      ['Proposal','State','Message','Base','Agent','Created'],
      patches.map(function(p){return[m(p.proposalId.slice(0,10)),b(p.state,p.state),esc(p.message).slice(0,60),m(p.baseCommit.slice(0,7)),p.agentId||'-',new Date(p.createdAt).toLocaleString()]})));

    /* Notes */
    document.getElementById('notes').replaceChildren(makeTable(
      ['Key','Type','Preview','Agent','Commit','Updated'],
      notes.map(function(n){return[m(n.key),b(n.type,n.type),n.contentPreview.slice(0,80),n.agentId||'-',m(n.commitSha.slice(0,7)),new Date(n.updatedAt).toLocaleString()]})));

    /* Knowledge */
    document.getElementById('knowledge').replaceChildren(makeTable(
      ['Type','Title','Scope','Tags','Status','Agent','Updated'],
      knowledge.map(function(k){return[b(k.type,k.type),k.title,b(k.scope,k.scope),k.tags.join(', ')||'-',b(k.status,k.status==='active'?'active':'stale'),k.agentId||'-',new Date(k.updatedAt).toLocaleString()]})));

    /* Tickets */
    var visibleTickets=renderTicketsSection(tickets,ticketMetrics);
    if(selectedTicketId && visibleTickets.some(function(t){return t.ticketId===selectedTicketId})){
      selectedTicketDetail=await api('tickets/'+encodeURIComponent(selectedTicketId));
      renderTicketDetail();
    }else if(selectedTicketId && !visibleTickets.some(function(t){return t.ticketId===selectedTicketId})){
      selectedTicketId=null;
      selectedTicketDetail=null;
      renderTicketDetail();
    }

    document.getElementById('last-updated').textContent='Updated '+new Date().toLocaleTimeString();
  }catch(e){
    console.error('Refresh failed:',e);
  }
}

/* ── SSE ─────────────────────────────────────── */
function connectSSE(){
  var pulse=document.getElementById('pulse');
  var es=new EventSource('/api/events');
  es.onopen=function(){pulse.classList.remove('disconnected');pulse.title='SSE connected'};
  es.addEventListener('agent_registered',function(){refresh()});
  es.addEventListener('session_changed',function(){refresh()});
  es.addEventListener('patch_proposed',function(){refresh()});
  es.addEventListener('note_added',function(){refresh()});
  es.addEventListener('event_logged',function(){refresh()});
  es.addEventListener('index_updated',function(){refresh()});
  es.addEventListener('knowledge_stored',function(){refresh()});
  es.addEventListener('ticket_created',function(){refresh()});
  es.addEventListener('ticket_assigned',function(){refresh()});
  es.addEventListener('ticket_status_changed',function(){refresh()});
  es.addEventListener('ticket_commented',function(){refresh()});
  es.onerror=function(){
    pulse.classList.add('disconnected');pulse.title='SSE disconnected';
    es.close();setTimeout(connectSSE,5000);
  };
}

/* ── Toast ───────────────────────────────────── */
function showToast(msg,type){
  var t=document.getElementById('toast');
  t.textContent=msg;
  t.className='toast '+type+' show';
  setTimeout(function(){t.classList.remove('show')},4000);
}

/* ── Obsidian Export ─────────────────────────── */
document.getElementById('export-btn').addEventListener('click',async function(){
  var btn=document.getElementById('export-btn');
  btn.disabled=true;btn.textContent='Exporting...';
  try{
    var res=await fetch('/api/export/obsidian',{method:'POST'});
    var data=await res.json();
    if(res.ok){
      showToast('Exported '+data.exported+' entries → '+data.path,'success');
    }else{
      showToast('Export failed: '+(data.error||'Unknown error'),'error');
    }
  }catch(e){
    showToast('Export failed: '+e.message,'error');
  }finally{
    btn.disabled=false;btn.innerHTML='&#128214; Export Obsidian';
  }
});

init();
connectSSE();
setInterval(refreshPresence,10000);
</script>
</body>
</html>`;
}
