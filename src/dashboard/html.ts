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
  <div class="charts" id="charts"></div>
  <div class="tab-bar" id="tab-bar"></div>
  <div id="agents" class="section active"></div>
  <div id="logs" class="section"></div>
  <div id="patches" class="section"></div>
  <div id="notes" class="section"></div>
  <div id="knowledge" class="section"></div>
</div>

<footer>Agora &mdash; Multi-agent shared context &amp; coordination server</footer>
<div class="toast" id="toast"></div>

<script>
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const api=p=>fetch('/api/'+p).then(r=>r.json());
const tabs=[['agents','Agents'],['logs','Activity Log'],['patches','Patches'],['notes','Notes'],['knowledge','Knowledge']];
const PALETTE=['#3b82f6','#22c55e','#f59e0b','#a855f7','#06b6d4','#ec4899','#6366f1','#ef4444','#14b8a6','#f97316'];
const TYPE_COLORS={decision:'#3b82f6',gotcha:'#f59e0b',pattern:'#a855f7',context:'#06b6d4',plan:'#ec4899',solution:'#22c55e',preference:'#6366f1',runbook:'#14b8a6'};
const STATE_COLORS={proposed:'#f59e0b',validated:'#3b82f6',applied:'#22c55e',committed:'#22c55e',stale:'#ef4444',failed:'#ef4444'};
let tabCounts={agents:0,logs:0,patches:0,notes:0,knowledge:0};

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

function mkEmpty(){return '<div class="chart-empty">No data</div>';}

function makeLegend(data){
  return data.map(function(d){return '<div class="item"><span class="swatch" style="background:'+d.color+'"></span>'+esc(d.label)+'<span class="count">'+d.value+'</span></div>'}).join('');
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

/* ── Chart panels ────────────────────────────── */
function renderCharts(logs,patches,knowledge,agents){
  var container=document.getElementById('charts');
  var colorMap={blue:'#3b82f6',green:'#22c55e',purple:'#a855f7',cyan:'#06b6d4',orange:'#f59e0b',red:'#ef4444'};

  /* Activity sparkline */
  var hourBuckets=bucketByHour(logs.map(function(l){return l.timestamp}));
  var sparkPanel=makeChartPanel('Activity (24h)','blue',colorMap,'<div style="width:100%">'+makeSparkline(hourBuckets,320,55)+'</div>');

  /* Tool usage donut */
  var toolCounts={};
  logs.forEach(function(l){toolCounts[l.tool]=(toolCounts[l.tool]||0)+1});
  var toolData=Object.entries(toolCounts).sort(function(a,b){return b[1]-a[1]}).slice(0,8).map(function(e,i){return{label:e[0],value:e[1],color:PALETTE[i%PALETTE.length]}});
  var toolPanel=makeChartPanel('Tool Usage','purple',colorMap,'<div class="chart-body">'+makeDonut(toolData,100,16)+'<div class="chart-legend">'+makeLegend(toolData)+'</div></div>');

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

  container.replaceChildren(sparkPanel,toolPanel,kPanel,pPanel);
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

/* ── Main refresh ────────────────────────────── */
async function refresh(){
  try{
    var results=await Promise.all([
      api('overview'),api('agents'),api('logs'),api('patches'),api('notes'),api('knowledge')
    ]);
    var o=results[0],agents=results[1],logs=results[2],patches=results[3],notes=results[4],knowledge=results[5];

    /* Overview cards */
    var ov=document.getElementById('overview');
    ov.replaceChildren(
      makeCard('&#128193;','Files Indexed',o.fileCount),
      makeCard('&#129302;','Agents',o.totalAgents),
      makeCard('&#9889;','Active Sessions',o.activeSessions),
      makeCard('&#128230;','Patches',o.totalPatches),
      makeCard('&#127793;','Indexed Commit',o.indexedCommit?o.indexedCommit.slice(0,7):'none'),
      makeCard('&#128279;','Topology',o.coordinationTopology));

    /* Charts */
    renderCharts(logs,patches,knowledge,agents);

    /* Tab counts */
    tabCounts={agents:agents.length,logs:logs.length,patches:patches.length,notes:notes.length,knowledge:knowledge.length};
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
</script>
</body>
</html>`;
}
