/* ============================================================================
   Backfill historical RUM (10–15 July) from the Google-Sheets CSV into Supabase.

   WHY IT ISN'T A STRAIGHT COPY:
     The old collector wrote ONE ROW PER METRIC, so several CSV rows describe a
     single page view. This merges rows sharing (session_id, path) back into one
     row before inserting — otherwise you'd import the same inflation that made
     13–14 July look like 34k/40k "views" when real traffic was ~12k.

   SAFETY:
     • CSV timestamps verified as UTC (matched against Supabase traffic rhythm).
     • 15 July is cut over at the first Supabase event, so the two collectors
       never double-count.
     • Every inserted row carries raw.source = "sheets_backfill", so the whole
       import can be removed again with one statement:
          delete from rum_events where raw->>'source' = 'sheets_backfill';

   USAGE:
     node backfill_rum.mjs            # dry run — reports, writes nothing
     node backfill_rum.mjs --commit   # actually insert
   ========================================================================== */
import fs from 'node:fs';
import readline from 'node:readline';

const CSV='C:/Users/hp/Downloads/Aditya Tiwari To - Do - RUM.csv';
const SUPA='https://ijzudvwhzsnwysucyves.supabase.co';
const KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlqenVkdndoenNud3lzdWN5dmVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5MzA1MDYsImV4cCI6MjA5OTUwNjUwNn0.i59l07obJhiKt-RND4FEsETKpVUsvQiVGYxDYt5K0Cw';
const COMMIT=process.argv.includes('--commit');
const FROM='2026-07-10', TO='2026-07-15';
const BATCH=500;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function req(url,opts,tries=5){
  let e;
  for(let i=0;i<tries;i++){
    try{ const r=await fetch(url,{...opts,signal:AbortSignal.timeout(60000)});
      if(r.status>=500){ await sleep(1500*(i+1)); continue; }
      return r; }
    catch(x){ e=x; await sleep(1500*(i+1)); }
  }
  throw e||new Error('request failed');
}
const parseLine=l=>{const o=[];let c='',q=false;
  for(let i=0;i<l.length;i++){const ch=l[i];
    if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}
    else{if(ch==='"')q=true;else if(ch===','){o.push(c);c='';}else c+=ch;}}
  o.push(c);return o;};
const parseTS=t=>{const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(t||'');
  return m?Date.UTC(+m[3],+m[1]-1,+m[2],+m[4],+m[5],+m[6]):null;};   // CSV verified UTC
const S=v=>{v=(v??'').toString().trim();return v===''?null:v;};
const N=v=>{const n=parseFloat(v);return isNaN(n)?null:n;};
const Bo=v=>{v=(v??'').toString().trim().toUpperCase();return v==='TRUE'?true:v==='FALSE'?false:null;};

// 1) find where Supabase takes over on 15 Jul, so we never double-count
const r0=await req(`${SUPA}/rest/v1/rum_events?select=created_at&created_at=gte.2026-07-15T00:00:00Z&order=created_at.asc&limit=1`,{headers:{apikey:KEY}});
const firstSupa=(await r0.json())[0]?.created_at;
const CUT=firstSupa?Date.parse(firstSupa):Date.parse('2026-07-16T00:00:00Z');
console.log('Supabase first event on 15 Jul :',firstSupa||'(none)');
console.log('cut-over — CSV rows at/after this instant are skipped\n');

// 2) merge CSV rows into page views
const PV=new Map();
let hdr=null, seen=0, skippedCut=0;
const rl=readline.createInterface({input:fs.createReadStream(CSV),crlfDelay:Infinity});
for await(const line of rl){
  if(!line.trim())continue; if(!hdr){hdr=parseLine(line);continue;}
  const f=parseLine(line); const ts=parseTS(f[0]); if(ts==null)continue;
  const day=new Date(ts).toISOString().slice(0,10);
  if(day<FROM||day>TO) continue;
  if(ts>=CUT){ skippedCut++; continue; }
  seen++;
  const key=(f[1]||'')+'|'+(f[3]||'');
  let e=PV.get(key);
  if(!e){ e={ created_at:new Date(ts).toISOString(), session_id:S(f[1]), url:S(f[2]), path:S(f[3]),
      referrer:S(f[4]), device:S(f[5]), os:S(f[6]), browser:S(f[7]), viewport:S(f[8]),
      connection:S(f[9]), save_data:Bo(f[10]), device_memory:N(f[11]), cpu_cores:N(f[12]), nav_type:S(f[13]),
      lcp:null,lcp_rating:null,lcp_element:null, cls:null,cls_rating:null,cls_element:null,
      inp:null,inp_rating:null,inp_target:null,inp_type:null, fcp:null,fcp_rating:null,
      ttfb:null,ttfb_rating:null,ttfb_waiting:null,ttfb_dns:null,ttfb_connect:null,ttfb_request:null,
      raw:{source:'sheets_backfill'} };
    PV.set(key,e);
  }
  if(ts<Date.parse(e.created_at)) e.created_at=new Date(ts).toISOString();
  // merge metric fields — the old collector split them across rows
  const set=(k,v)=>{ if(e[k]==null && v!=null) e[k]=v; };
  set('lcp',N(f[14]));  set('lcp_rating',S(f[15])); set('lcp_element',S(f[16]));
  set('cls',N(f[17]));  set('cls_rating',S(f[18])); set('cls_element',S(f[19]));
  set('inp',N(f[20]));  set('inp_rating',S(f[21])); set('inp_target',S(f[22])); set('inp_type',S(f[23]));
  set('fcp',N(f[24]));  set('fcp_rating',S(f[25]));
  set('ttfb',N(f[26])); set('ttfb_rating',S(f[27]));
  set('ttfb_waiting',N(f[28])); set('ttfb_dns',N(f[29]));
  set('ttfb_connect',N(f[30])); set('ttfb_request',N(f[31]));
  for(const k of ['url','path','referrer','device','os','browser','viewport','connection','nav_type'])
    if(e[k]==null) e[k]=S(f[{url:2,path:3,referrer:4,device:5,os:6,browser:7,viewport:8,connection:9,nav_type:13}[k]]);
}
const merged=[...PV.values()];
const hasData=e=>e.lcp!=null||e.cls!=null||e.inp!=null||e.fcp!=null||e.ttfb!=null;
// Default: import only measurement-bearing page views (skip the empty shells the
// failing collector produced).  --include-empty also imports the traffic-only rows,
// which restores true VISIT COUNTS for 13-15 July but adds rows with null metrics.
// Those get a separate tag so they can be removed independently.
const INCLUDE_EMPTY=process.argv.includes('--include-empty');
const ONLY_DAY=(process.argv.find(a=>a.startsWith('--day='))||'').split('=')[1]||null;
let rowsAll = INCLUDE_EMPTY ? merged : merged.filter(hasData);
if(ONLY_DAY) rowsAll = rowsAll.filter(e=>e.created_at.slice(0,10)===ONLY_DAY);
if(INCLUDE_EMPTY) for(const e of rowsAll) if(!hasData(e)) e.raw={source:'sheets_backfill_trafficonly'};
// never re-insert what the previous (measured) run already added
if(INCLUDE_EMPTY) rowsAll = rowsAll.filter(e=>!hasData(e));
const perDate={}, allDate={};
for(const e of merged) allDate[e.created_at.slice(0,10)]=(allDate[e.created_at.slice(0,10)]||0)+1;
for(const e of rowsAll) perDate[e.created_at.slice(0,10)]=(perDate[e.created_at.slice(0,10)]||0)+1;

console.log('CSV rows read (in range)   :',seen.toLocaleString());
console.log('skipped (after cut-over)   :',skippedCut.toLocaleString());
console.log('page views after merging   :',merged.length.toLocaleString());
console.log('EMPTY shells excluded       :',(merged.length-rowsAll.length).toLocaleString());
console.log('WILL IMPORT (has metrics)  :',rowsAll.length.toLocaleString());
console.log('\n  date         merged views   importing (with data)   excluded (empty)');
Object.keys(allDate).sort().forEach(d=>{
  const a=allDate[d], k=perDate[d]||0;
  console.log(`  ${d}   ${String(a).padStart(12)}   ${String(k).padStart(20)}   ${String(a-k).padStart(16)}`);
});

if(!COMMIT){
  console.log('\nDRY RUN — nothing written. Re-run with --commit to insert.');
  console.log('Undo after import:  delete from rum_events where raw->>\'source\' = \'sheets_backfill\';');
  process.exit(0);
}

// 3) insert
console.log(`\nInserting ${rowsAll.length.toLocaleString()} rows in batches of ${BATCH} …`);
let done=0, failed=0;
for(let i=0;i<rowsAll.length;i+=BATCH){
  const chunk=rowsAll.slice(i,i+BATCH);
  const r=await req(`${SUPA}/rest/v1/rum_events`,{
    method:'POST',
    headers:{apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json',Prefer:'return=minimal'},
    body:JSON.stringify(chunk)});
  if(r.ok) done+=chunk.length;
  else { failed+=chunk.length; console.error('  batch failed:',r.status,(await r.text()).slice(0,180)); }
  if((i/BATCH)%10===0||i+BATCH>=rowsAll.length)
    console.log(`  ${Math.min(i+BATCH,rowsAll.length).toLocaleString()} / ${rowsAll.length.toLocaleString()}  (ok ${done.toLocaleString()}, failed ${failed.toLocaleString()})`);
}
console.log(`\nDONE — inserted ${done.toLocaleString()}, failed ${failed.toLocaleString()}`);
console.log('Undo:  delete from rum_events where raw->>\'source\' = \'sheets_backfill\';');
