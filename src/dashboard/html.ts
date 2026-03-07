import { VERSION } from "../core/constants.js";

export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agora Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f1117;color:#e1e4e8;padding:1.5rem}
h1{font-size:1.4rem;margin-bottom:1rem;color:#58a6ff}
h2{font-size:1.1rem;margin:1.5rem 0 .5rem;color:#79c0ff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:1.5rem}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem}
.card .label{font-size:.75rem;color:#8b949e;text-transform:uppercase}
.card .value{font-size:1.5rem;font-weight:600;margin-top:.25rem}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid #21262d}
th{color:#8b949e;font-weight:500;font-size:.75rem;text-transform:uppercase}
tr:hover{background:#161b22}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:.75rem;font-weight:500}
.badge-a{background:#1f6feb33;color:#58a6ff}
.badge-b{background:#f0883e33;color:#f0883e}
.badge-active{background:#23863633;color:#3fb950}
.badge-stale{background:#da363333;color:#f85149}
.badge-validated{background:#1f6feb33;color:#58a6ff}
.tab-bar{display:flex;gap:.5rem;margin-bottom:1rem}
.tab{padding:.4rem 1rem;border-radius:6px;border:1px solid #30363d;background:none;color:#8b949e;cursor:pointer;font-size:.85rem}
.tab.active{background:#161b22;color:#e1e4e8;border-color:#58a6ff}
.section{display:none}.section.active{display:block}
.refresh{float:right;background:none;border:1px solid #30363d;color:#8b949e;padding:.3rem .8rem;border-radius:6px;cursor:pointer;font-size:.8rem}
.refresh:hover{color:#e1e4e8;border-color:#58a6ff}
footer{margin-top:2rem;text-align:center;font-size:.75rem;color:#484f58}
</style>
</head>
<body>
<h1 id="title">Agora v${VERSION}</h1>
<div id="overview" class="grid"></div>
<div class="tab-bar" id="tab-bar"></div>
<div id="agents" class="section active"></div>
<div id="logs" class="section"></div>
<div id="patches" class="section"></div>
<div id="notes" class="section"></div>
<footer>Agora — Multi-agent shared context server</footer>
<script>
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const api=p=>fetch('/api/'+p).then(r=>r.json());
const tabs=[['agents','Agents'],['logs','Logs'],['patches','Patches'],['notes','Notes']];

function init(){
  const bar=document.getElementById('tab-bar');
  tabs.forEach(([id,label],i)=>{
    const btn=document.createElement('button');
    btn.className='tab'+(i===0?' active':'');
    btn.textContent=label;
    btn.addEventListener('click',()=>showTab(id,btn));
    bar.appendChild(btn);
  });
  const rb=document.createElement('button');
  rb.className='refresh';
  rb.textContent='Refresh';
  rb.addEventListener('click',refresh);
  document.getElementById('title').appendChild(rb);
  refresh();
}

function showTab(id,btn){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
}

function makeCard(label,value){
  const d=document.createElement('div');d.className='card';
  const l=document.createElement('div');l.className='label';l.textContent=label;
  const v=document.createElement('div');v.className='value';v.textContent=String(value);
  d.appendChild(l);d.appendChild(v);return d;
}

function makeTable(headers,rows){
  if(!rows.length){const p=document.createElement('p');p.textContent='No data';p.style.color='#8b949e';p.style.padding='1rem';return p;}
  const t=document.createElement('table');
  const thead=document.createElement('thead');const hr=document.createElement('tr');
  headers.forEach(h=>{const th=document.createElement('th');th.textContent=h;hr.appendChild(th);});
  thead.appendChild(hr);t.appendChild(thead);
  const tbody=document.createElement('tbody');
  rows.forEach(row=>{const tr=document.createElement('tr');
    row.forEach(cell=>{const td=document.createElement('td');
      if(typeof cell==='object'&&cell.badge){const s=document.createElement('span');s.className='badge badge-'+cell.cls;s.textContent=cell.badge;td.appendChild(s);}
      else{td.textContent=String(cell);}
      tr.appendChild(td);});
    tbody.appendChild(tr);});
  t.appendChild(tbody);return t;
}

function b(v,c){return{badge:v,cls:c}}

async function refresh(){
  const o=await api('overview');
  const ov=document.getElementById('overview');
  ov.replaceChildren(
    makeCard('Files',o.fileCount),makeCard('Agents',o.totalAgents),
    makeCard('Active Sessions',o.activeSessions),makeCard('Patches',o.totalPatches),
    makeCard('Indexed',o.indexedCommit?o.indexedCommit.slice(0,7):'none'),
    makeCard('Topology',o.coordinationTopology));

  const agents=await api('agents');
  document.getElementById('agents').replaceChildren(makeTable(
    ['ID','Name','Type','Role','Tier','Sessions'],
    agents.map(a=>[a.id,a.name,a.type,a.role,b(a.trustTier,a.trustTier.toLowerCase()),a.activeSessions])));

  const logs=await api('logs');
  document.getElementById('logs').replaceChildren(makeTable(
    ['Event','Agent','Tool','Status','Duration','Time'],
    logs.map(l=>[l.eventId.slice(0,12),l.agentId,l.tool,b(l.status,l.status==='success'?'active':'stale'),l.durationMs+'ms',new Date(l.timestamp).toLocaleTimeString()])));

  const patches=await api('patches');
  document.getElementById('patches').replaceChildren(makeTable(
    ['Proposal','State','Message','Base','Agent','Created'],
    patches.map(p=>[p.proposalId,b(p.state,p.state==='validated'?'validated':p.state==='stale'?'stale':'active'),p.message.slice(0,60),p.baseCommit.slice(0,7),p.agentId,new Date(p.createdAt).toLocaleString()])));

  const notes=await api('notes');
  document.getElementById('notes').replaceChildren(makeTable(
    ['Key','Type','Preview','Agent','Commit','Updated'],
    notes.map(n=>[n.key,b(n.type,'a'),n.contentPreview.slice(0,80),n.agentId||'-',n.commitSha.slice(0,7),new Date(n.updatedAt).toLocaleString()])));
}

// SSE: auto-refresh on server events
function connectSSE(){
  const es=new EventSource('/api/events');
  es.addEventListener('agent_registered',()=>refresh());
  es.addEventListener('session_changed',()=>refresh());
  es.addEventListener('patch_proposed',()=>refresh());
  es.addEventListener('note_added',()=>refresh());
  es.addEventListener('event_logged',()=>refresh());
  es.addEventListener('index_updated',()=>refresh());
  es.onerror=()=>{es.close();setTimeout(connectSSE,5000);};
}

init();
connectSSE();
</script>
</body>
</html>`;
}
