// generate.mjs — Fetches Notion data via REST API and generates internship_sankey_flow.html
import fs from "fs";

const TOKEN = process.env.NOTION_TOKEN;
const HANG_DB = process.env.HANG_DB_ID || "4de0bf8ae56b4fdc8a26c2fdfd1e0658";
const TONG_DB = process.env.TONG_DB_ID || "33808633776180c484fdeca299571657";

async function queryAllPages(databaseId) {
  const pages = [];
  let cursor = undefined;
  while (true) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Notion API error ${res.status}: ${err}`);
    }
    const data = await res.json();
    pages.push(...data.results);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return pages;
}

function extractEntry(page) {
  const p = page.properties;
  const company = p["Company"]?.select?.name || "";
  const status = p["Status"]?.select?.name || "";
  const appliedDate = p["Applied Date"]?.date?.start || "";
  const role = p["岗位-"]?.rich_text?.[0]?.plain_text || p["岗位"]?.title?.[0]?.plain_text || "";
  return { company, status, appliedDate, role };
}

function normalizeStatus(s) {
  if (!s) return null;
  if (s.includes("Applied")) return "Applied";
  if (s.includes("Interview")) return "Interview";
  if (s.includes("Offer")) return "Offer";
  if (s.includes("Rejected")) return "Rejected";
  if (s === "OA") return "OA";
  if (s.includes("To Apply") || s.includes("Withdrawn")) return null;
  return "Applied";
}

function buildSankeyData(entries) {
  const dateSet = new Set();
  entries.forEach(e => { if (e.appliedDate) dateSet.add(e.appliedDate); });
  const sortedDates = [...dateSet].sort();
  if (!sortedDates.length) return { steps: [], rows: [] };
  const steps = [];
  let i = 0;
  while (i < sortedDates.length) {
    const start = new Date(sortedDates[i] + "T00:00:00");
    let endStr = sortedDates[i];
    let j = i + 1;
    while (j < sortedDates.length) {
      const d = new Date(sortedDates[j] + "T00:00:00");
      if ((d - start) / 86400000 <= 1) { endStr = sortedDates[j]; j++; } else break;
    }
    const sD = new Date(sortedDates[i] + "T00:00:00");
    const eD = new Date(endStr + "T00:00:00");
    const label = sortedDates[i] === endStr
      ? `${sD.getMonth()+1}/${sD.getDate()}`
      : `${sD.getMonth()+1}/${sD.getDate()}\u2013${eD.getDate()}`;
    steps.push({ label, dates: sortedDates.slice(i, j) });
    i = j;
  }
  steps.push({ label: "Today", dates: ["today"] });
  const nSteps = steps.length;
  const groups = {};
  entries.forEach(e => {
    const status = normalizeStatus(e.status);
    if (!status) return;
    const si = steps.findIndex(s => s.dates.includes(e.appliedDate));
    if (si < 0) return;
    const key = `${si}|${e.company}|${status}`;
    if (!groups[key]) groups[key] = { company: e.company, status, stepIdx: si, count: 0 };
    groups[key].count++;
  });
  const rows = Object.values(groups).map(g => {
    const arr = new Array(nSteps + 2);
    arr[0] = g.count > 1 ? `${g.company} \u00d7${g.count}` : g.company;
    arr[1] = g.count;
    for (let si = 0; si < nSteps; si++) {
      if (si < g.stepIdx) arr[si+2] = null;
      else if (si === g.stepIdx) arr[si+2] = "New";
      else if (si === nSteps-1) arr[si+2] = g.status;
      else arr[si+2] = g.status === "Rejected" ? null : ["OA","Interview","Offer"].includes(g.status) ? g.status : "Applied";
    }
    if (g.status === "Rejected") {
      const mid = Math.min(g.stepIdx+1, nSteps-1);
      if (mid < nSteps) arr[mid+2] = "Rejected";
      for (let si = mid+1; si < nSteps; si++) arr[si+2] = null;
      if (mid === g.stepIdx && g.stepIdx+1 < nSteps) arr[g.stepIdx+3] = "Rejected";
    }
    return arr;
  });
  return { steps: steps.map(s => s.label), rows };
}

function generateHTML(hangResult, tongResult) {
  const hangJSON = JSON.stringify({steps:hangResult.steps,rows:hangResult.rows});
  const tongJSON = JSON.stringify({steps:tongResult.steps,rows:tongResult.rows});
  const now = new Date().toISOString().slice(0,16).replace("T"," ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Internship Journey Sankey</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fff;color:#333;display:flex;flex-direction:column;align-items:center;padding:.5rem 0;gap:2rem}
@media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#D3D1C7}}
.chart{width:100%}svg{display:block}
.divider{width:60%;height:1px;background:rgba(128,128,128,.15)}
.updated{font-size:10px;color:#bbb;text-align:center;padding:4px}
.tp{position:fixed;pointer-events:none;z-index:10;padding:7px 11px;border-radius:7px;font-size:12px;line-height:1.4;max-width:260px;display:none;background:rgba(0,0,0,.82);color:#fff}
@media(prefers-color-scheme:dark){.tp{background:rgba(255,255,255,.92);color:#1a1a1a}}
</style>
</head>
<body>
<div class="chart" id="c1"></div>
<div class="divider"></div>
<div class="chart" id="c2"></div>
<div class="updated">Last updated: ${now} UTC</div>
<div class="tp" id="tp"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"><\/script>
<script>
const dk=matchMedia('(prefers-color-scheme:dark)').matches;
const tp=document.getElementById('tp');
const C={New:dk?'#2CB88A':'#5DCAA5',Applied:dk?'#4A9AD9':'#7DBCE8',OA:dk?'#D9A030':'#F2C96B',Interview:dk?'#8B7BD4':'#B0A6E8',Rejected:dk?'#D06060':'#EE9090',Offer:dk?'#3BBF3B':'#7BCF7B'};
const sO=['New','Applied','OA','Interview','Rejected','Offer'];
function draw(id,title,steps,rows){
if(!rows.length)return;
const N=steps.length,bW=10;
const cT=[];for(let i=0;i<N;i++)cT.push(rows.reduce((s,r)=>r[i+2]?s+r[1]:s,0));
const mT=Math.max(...cT,1);
const W=2200,H=520,mg={t:48,b:14,l:100,r:120};
const aH=H-mg.t-mg.b,cG=(W-mg.l-mg.r-bW*N)/(N-1),uH=aH/mT,nP=4;
const NP={},segs=[];
for(let si=0;si<N;si++){const x0=mg.l+si*(bW+cG),cH=cT[si]*uH,sY=mg.t+(aH-cH)/2;const gr=[];
sO.forEach(st=>{const m=rows.filter(r=>r[si+2]===st);if(!m.length)return;const c=m.reduce((s,r)=>s+r[1],0);gr.push({st,c,rows:m})});
const tP=(gr.length-1)*nP,sc=(cH-tP)/cT[si];let y=sY;
gr.forEach(g=>{const h=g.c*sc;NP[si+'|'+g.st]={x0,x1:x0+bW,y0:y,y1:y+h,si,st:g.st,cnt:g.c};let sy=y;
g.rows.forEach(r=>{const sh=r[1]*sc;segs.push({si,st:g.st,lab:r[0],w:r[1],y0:sy,y1:sy+sh,x0,x1:x0+bW});sy+=sh});y+=h+nP})}
const LC={};rows.forEach(r=>{for(let i=0;i<N-1;i++){const a=r[i+2],b=r[i+3];if(!a||!b)continue;const k=i+'|'+a+'>'+(i+1)+'|'+b;LC[k]=(LC[k]||0)+r[1]}});
const sOut={},tIn={};Object.keys(NP).forEach(k=>{sOut[k]=0;tIn[k]=0});
const LL=Object.entries(LC).map(([k,v])=>{const[sk,tk]=k.split('>');return{sk,tk,v,from:sk.split('|')[1],to:tk.split('|')[1]}})
.sort((a,b)=>{if(a.from===a.to&&b.from!==b.to)return-1;if(a.from!==a.to&&b.from===b.to)return 1;return sO.indexOf(a.to)-sO.indexOf(b.to)});
LL.forEach(l=>{const s=NP[l.sk],t=NP[l.tk];if(!s||!t){l.skip=1;return}
const ss=(s.y1-s.y0)/s.cnt,ts=(t.y1-t.y0)/t.cnt;l.th=Math.max(1,Math.min(l.v*ss,l.v*ts));l.sy=s.y0+sOut[l.sk];l.ty=t.y0+tIn[l.tk];sOut[l.sk]+=l.th;tIn[l.tk]+=l.th});
const svg=d3.select('#'+id).append('svg').attr('viewBox','0 0 '+W+' '+H).attr('width','100%').attr('font-family','-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif');
const fG=svg.append('g');
LL.forEach((l,li)=>{if(l.skip)return;const s=NP[l.sk],t=NP[l.tk],sx=s.x1,tx=t.x0;
const sy0=l.sy,sy1=l.sy+l.th,ty0=l.ty,ty1=l.ty+l.th,mx=(sx+tx)/2;
fG.append('path').attr('d','M'+sx+','+sy0+' C'+mx+','+sy0+' '+mx+','+ty0+' '+tx+','+ty0+' L'+tx+','+ty1+' C'+mx+','+ty1+' '+mx+','+sy1+' '+sx+','+sy1+' Z')
.attr('fill',C[l.to]||'#999').attr('fill-opacity',dk?.18:.14).attr('stroke',C[l.to]||'#999').attr('stroke-width',.4).attr('stroke-opacity',dk?.12:.08)
.attr('class','fl').attr('data-i',li).style('cursor','pointer')
.on('mouseenter',function(ev){fG.selectAll('.fl').attr('fill-opacity',function(){return+this.dataset.i===li?(dk?.5:.4):(dk?.03:.02)}).attr('stroke-opacity',function(){return+this.dataset.i===li?.35:.01});
tp.style.display='block';tp.innerHTML='<b>'+l.from+'</b> -> <b>'+l.to+'</b><br>'+steps[s.si]+' -> '+steps[t.si]+'<br>'+l.v+' app'+(l.v>1?'s':'')})
.on('mousemove',ev=>{tp.style.left=(ev.clientX+12)+'px';tp.style.top=(ev.clientY-8)+'px'})
.on('mouseleave',()=>{fG.selectAll('.fl').attr('fill-opacity',dk?.18:.14).attr('stroke-opacity',dk?.12:.08);tp.style.display='none'})});
Object.values(NP).forEach(n=>{svg.append('rect').attr('x',n.x0).attr('y',n.y0).attr('width',bW).attr('height',Math.max(2,n.y1-n.y0)).attr('rx',3).attr('fill',C[n.st]||'#999')});
Object.values(NP).forEach(n=>{const h=n.y1-n.y0;if(h<12)return;
svg.append('text').attr('x',n.x1+8).attr('y',n.y0+2).attr('dy','.8em').attr('font-size','13px').attr('font-weight',500).attr('fill',dk?'#D3D1C7':'#444').text(n.st);
if(h>=26){const pct=Math.round(n.cnt/cT[n.si]*100);svg.append('text').attr('x',n.x1+8).attr('y',n.y0+17).attr('dy','.8em').attr('font-size','11px').attr('fill',dk?'#777':'#aaa').text(n.cnt+' - '+pct+'%')}});
const uY={};segs.forEach(seg=>{const h=seg.y1-seg.y0;if(h<6)return;const midY=(seg.y0+seg.y1)/2,fs=h>16?12:h>10?10:8;
const lh=fs+2,ly0=midY-lh/2,ly1=midY+lh/2,col=seg.si+'|'+seg.st;if(!uY[col])uY[col]=[];
if(uY[col].some(a=>!(ly1<a[0]||ly0>a[1])))return;uY[col].push([ly0,ly1]);
const lab=seg.w>1?seg.lab+' x'+seg.w:seg.lab;
svg.append('text').attr('x',seg.x0-6).attr('y',midY).attr('dy','0.35em').attr('text-anchor','end').attr('font-size',fs).attr('fill',dk?'#999':'#888').text(lab)});
steps.forEach((l,i)=>{const x=mg.l+i*(bW+cG)+bW/2;
svg.append('text').attr('x',x).attr('y',mg.t-14).attr('text-anchor','middle').attr('font-size','14px').attr('font-weight',500).attr('fill',dk?'#B4B2A9':'#555').text(l);
svg.append('text').attr('x',x).attr('y',mg.t-1).attr('text-anchor','middle').attr('font-size','10px').attr('fill',dk?'#666':'#bbb').text(cT[i])});
const total=rows.reduce((s,r)=>s+r[1],0);
svg.append('text').attr('x',W/2).attr('y',16).attr('text-anchor','middle').attr('font-size','16px').attr('font-weight',500).attr('fill',dk?'#D3D1C7':'#333').text(title+' - '+total+' total')}
const hangData=${hangJSON};
const tongData=${tongJSON};
draw('c1',"Hang's internship journey",hangData.steps,hangData.rows);
draw('c2',"Tong's internship journey",tongData.steps,tongData.rows);
<\/script>
</body>
</html>`;
}

async function main() {
  console.log("Fetching Hang's data...");
  const hangPages = await queryAllPages(HANG_DB);
  const hangEntries = hangPages.map(extractEntry).filter(e => e.company && e.appliedDate);
  console.log("  Found " + hangEntries.length + " entries");
  console.log("Fetching Tong's data...");
  const tongPages = await queryAllPages(TONG_DB);
  const tongEntries = tongPages.map(extractEntry).filter(e => e.company && e.appliedDate);
  console.log("  Found " + tongEntries.length + " entries");
  const hangResult = buildSankeyData(hangEntries);
  const tongResult = buildSankeyData(tongEntries);
  const html = generateHTML(hangResult, tongResult);
  fs.writeFileSync("internship_sankey_flow.html", html);
  console.log("Generated internship_sankey_flow.html");
}

main().catch(e => { console.error(e); process.exit(1); });
