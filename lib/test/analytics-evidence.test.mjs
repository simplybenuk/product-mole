import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAnalytics, importAnalytics } from '../analytics-evidence.mjs';
import { registerSource, resolveSource, reconcileSource } from '../source-registry.mjs';
import { listLifecycleRecords } from '../review-lifecycle.mjs';
const root = fileURLToPath(new URL('../../',import.meta.url));
const fixture = fs.readFileSync(path.join(root,'examples/analytics-evidence/review.json'),'utf8');
const csv = fs.readFileSync(path.join(root,'examples/analytics-evidence/review.csv'),'utf8');
const identity = { namespace:'demo',key:'review-1' };
const options = { identity, source:{type:'analytics',ref:'input.json'} };
const parse = body => parseAnalytics(JSON.stringify(body),options);
const body = () => JSON.parse(fixture);
function metric(overrides) { const b=body(); b.metrics=[{...b.metrics[0],...overrides}]; return parse(b).metrics[0]; }
function workspace(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mole-analytics-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'input.json'),fixture);return dir; }

test('multi-metric JSON and CSV preserve definitions, provenance, samples and descriptive deltas',()=>{
  const result=parseAnalytics(fixture,options); const m=result.metrics[0];
  assert.equal(result.review_state,'draft'); assert.equal(result.change_id,'change-search-typos');
  assert.equal(m.status,'measured');assert.equal(m.outcome_status,'unknown');
  assert.equal(m.comparison.absolute_change,10);assert.equal(m.comparison.relative_change_percent,20);assert.equal(m.comparison.causal_claim,false);
  assert.equal(m.windows.baseline.start,'2026-09-01T00:00:00.000Z');assert.equal(m.windows.baseline.duration_ms,604800000);
  assert.equal(m.baseline.sample_size,1000); assert.equal(m.quality.status,'good');
  assert.equal(m.provenance.definition.locator,'/metrics/0/definition');
  assert.equal(result.metrics[1].status,'not_measured');
  const rows=parseAnalytics(csv,{...options,format:'csv',changeId:'explicit-id'}).metrics;
  assert.equal(rows.length,2); assert.equal(rows[0].definition,'Completed searches / starts, percent');
  assert.equal(rows[1].status,'inconclusive'); assert.equal(rows[1].comparison.relative_status,'zero_baseline');
});

test('missing, invalid, not measured, inconclusive, unknown, measured and explicit outcomes stay distinct',()=>{
  for (const status of ['unknown','inconclusive','measured']) assert.equal(metric({status}).status,status);
  assert.equal(metric({baseline_value:null,status:'measured',outcome_status:'success'}).status,'missing');
  assert.equal(metric({baseline_value:null,outcome_status:'success'}).outcome_status,'unknown');
  assert.equal(metric({baseline_value:null,post_value:null,baseline_status:'not_measured',post_status:'not_measured'}).status,'not_measured');
  for (const outcome_status of ['success','failure','unknown']) assert.equal(metric({outcome_status}).outcome_status,outcome_status);
  assert.equal(metric({post_complete:false,outcome_status:'success'}).outcome_status,'unknown');
  assert.equal(metric({post_complete:null}).status,'inconclusive');
  assert.equal(metric({status:undefined}).status,'unknown');
});

test('invalid/nonfinite values, sample sizes, windows and timestamps cannot produce success',()=>{
  for (const overrides of [ {baseline_value:'NaN'}, {post_value:'Infinity'}, {post_value:'0x10'}, {baseline_value:true},
    {baseline_sample_size:-1},{post_sample_size:1.5},{baseline_start:'2026-02-30'}, {post_start:'2026-09-07'},
    {post_end:'2026-09-08'}, {post_end:'2026-09-08T25:00:00Z'}, {post_complete:'yes'}, {data_timestamp:'yesterday'},
    {data_timestamp:'2026-09-10'}, {baseline_value:-1e308,post_value:1e308} ]) {
    const m=metric({...overrides,outcome_status:'success'});assert.equal(m.status,'invalid',JSON.stringify(overrides));assert.equal(m.outcome_status,'unknown');assert.equal(m.quality.status,'invalid');
  }
  assert.equal(metric({baseline_value:0}).comparison.relative_change_percent,null);
  assert.equal(metric({baseline_value:0}).comparison.relative_status,'zero_baseline');
  assert.equal(metric({baseline_end:'2026-09-08',post_start:'2026-09-08'}).status,'measured');
  assert.equal(metric({baseline_start:null}).status,'inconclusive');
});

test('structural errors reject batch; sparse input keeps unknown fields visible as gaps',()=>{
  for(const input of [null,{}, {...body(),schema_version:2}, {...body(),approve:true}, {...body(),metrics:[]},
    {...body(),metrics:[{}]}, {...body(),metrics:[{metric_id:'x'},{metric_id:'x'}]}, {...body(),metrics:[{metric_id:'x',secret:'no'}]}]) assert.throws(()=>parse(input));
  assert.throws(()=>parseAnalytics('{',options));
  assert.throws(()=>parseAnalytics(csv,{...options,format:'csv'}),/Explicit/);
  for(const malformed of ['metric_id,metric_id\nx,x','metric_id,definition\nx','metric_id\n"unfinished','metric_id\n"x"oops']) assert.throws(()=>parseAnalytics(malformed,{...options,format:'csv',changeId:'x'}));
  const m=parse({change_id:'x',metrics:[{metric_id:'x'}]}).metrics[0];
  assert.equal(m.status,'missing'); assert.equal(m.definition,null);assert.equal(m.population,null);assert.ok(m.quality.issues.length);
  assert.equal(m.provenance.definition.method,'defaulted');
});

test('immutable captures, draft support, privacy-gated moved sources and byte/options conflicts',t=>{
  const dir=workspace(t);const input=registerSource(dir,{path:'input.json'});
  fs.mkdirSync(path.join(dir,'6-raw/archive'),{recursive:true});
  fs.renameSync(path.join(dir,'input.json'),path.join(dir,'6-raw/archive/moved.json'));
  reconcileSource(dir,input.source_id,'6-raw/archive/moved.json');
  assert.throws(()=>importAnalytics(dir,{sourceId:input.source_id,identity}),/privacy/i);
  fs.writeFileSync(path.join(dir,'selected.json'),fixture);
  const first=importAnalytics(dir,{file:'selected.json',identity});
  assert.deepEqual(listLifecycleRecords(dir).map(r=>r.state).sort(),['draft','raw']);
  const draft=listLifecycleRecords(dir).find(r=>r.state==='draft');assert.deepEqual(draft.source_ids,[first.event.source.source_id]);
  fs.renameSync(path.join(dir,first.raw_path),path.join(dir,'6-raw/archive/capture.json'));
  assert.equal(resolveSource(dir,first.event.source.source_id).ok,true);
  assert.throws(()=>importAnalytics(dir,{file:'selected.json',identity}),/privacy/i);
  fs.renameSync(path.join(dir,'6-raw/archive/capture.json'),path.join(dir,first.raw_path));
  assert.equal(importAnalytics(dir,{sourceId:first.event.source.source_id,format:'json',identity}).changed,false);
  assert.throws(()=>importAnalytics(dir,{file:'selected.json',identity,changeId:'change-search-typos'}),/different import request|different normalized data/);
  fs.appendFileSync(path.join(dir,'selected.json'),'\n');
  assert.throws(()=>importAnalytics(dir,{file:'selected.json',identity}),/different raw bytes|different import request/);
});

for(const layer of ['6-raw/staging','5-evidence/analytics']) test(`atomic ${layer} short write recovery and no replacement`,t=>{
  const dir=workspace(t);const original=fs.writeFileSync;let fault=false;
  fs.writeFileSync=function(file,data,opts){if(!fault && String(file).includes(layer)){fault=true;original.call(fs,file,Buffer.from(data).subarray(0,8),opts);throw new Error('Injected full disk');}return original.call(fs,file,data,opts);};
  try{assert.throws(()=>importAnalytics(dir,{file:'input.json',identity}),/Injected/);}finally{fs.writeFileSync=original;}
  if(layer==='6-raw/staging'){assert.equal(fs.readdirSync(path.join(dir,layer)).length,1);assert.throws(()=>importAnalytics(dir,{file:'input.json',identity}),/privacy/i);return;}
  assert.deepEqual(fs.readdirSync(path.join(dir,layer)),[]);
  assert.equal(importAnalytics(dir,{file:'input.json',identity}).changed,true);
  const files=fs.readdirSync(path.join(dir,layer));const canonical=path.join(dir,layer,files[0]);fs.writeFileSync(canonical,'occupied');
  assert.throws(()=>importAnalytics(dir,{file:'input.json',identity}));assert.equal(fs.readFileSync(canonical,'utf8'),'occupied');
});

test('unsafe paths, malformed bytes and CLI options fail closed',t=>{
  const dir=workspace(t);
  fs.writeFileSync(path.join(dir,'bad.json'),Buffer.from([0xff]));assert.throws(()=>importAnalytics(dir,{file:'bad.json',identity}));assert.equal(fs.existsSync(path.join(dir,'6-raw')),false);
  const run=args=>spawnSync(process.execPath,[path.join(root,'cli/mole.mjs'),'analytics','import',...args],{cwd:dir,encoding:'utf8'});
  const result=run(['input.json','--namespace','demo','--key','review-1']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).event.review_state,'draft');
  assert.notEqual(run(['input.json']).status,0);assert.notEqual(run(['input.json','--key','a','--key','b']).status,0);
  assert.notEqual(run(['input.json','--change-id','conflict','--namespace','demo','--key','next']).status,0);
  fs.mkdirSync(path.join(dir,'other'));fs.symlinkSync(os.tmpdir(),path.join(dir,'other','6-raw'));
  assert.throws(()=>importAnalytics(path.join(dir,'other'),{file:path.join(dir,'input.json'),identity}),/symlink/);
});

test('explicit unmeasured/invalid metric status and source quality cannot imply measured success',()=>{
  assert.equal(parse({change_id:'x',metrics:[{metric_id:'support',status:'not_measured'}]}).metrics[0].status,'not_measured');
  assert.equal(metric({status:'invalid'}).quality.status,'invalid');
  assert.equal(metric({quality_status:'invalid',outcome_status:'success'}).outcome_status,'unknown');
  const overflow=fixture.replace('"baseline_value": 50','"baseline_value": 1e999');
  const m=parseAnalytics(overflow,options).metrics[0];assert.equal(m.status,'invalid');assert.equal(m.baseline.invalid_value,'Infinity');
});

test('normalized evidence source ID survives relocation and replay returns relocated path',t=>{
  const dir=workspace(t);const first=importAnalytics(dir,{file:'input.json',identity});
  const evidence=listLifecycleRecords(dir).find(r=>r.state==='draft');
  fs.mkdirSync(path.join(dir,'5-evidence/archive'));fs.renameSync(path.join(dir,first.path),path.join(dir,'5-evidence/archive/review.json'));
  reconcileSource(dir,evidence.source_id,'5-evidence/archive/review.json');
  const replay=importAnalytics(dir,{file:'input.json',identity});
  assert.equal(replay.changed,false);assert.equal(replay.path,'5-evidence/archive/review.json');
  assert.equal(listLifecycleRecords(dir).length,2);assert.equal(fs.existsSync(path.join(dir,first.path)),false);
});

for(const layer of ['6-raw/inbox','5-evidence/analytics']) test(`concurrent ${layer} destination survives exclusive publication`,t=>{
  const dir=workspace(t);const original=fs.linkSync;let occupied;
  fs.linkSync=function(from,dest){if(!occupied && String(dest).includes(layer)){occupied=dest;fs.writeFileSync(dest,'concurrent user file',{flag:'wx'});}return original.call(fs,from,dest);};
  try{assert.throws(()=>importAnalytics(dir,{file:'input.json',identity}),{code:'EEXIST'});}finally{fs.linkSync=original;}
  assert.equal(fs.readFileSync(occupied,'utf8'),'concurrent user file');
  assert.equal(fs.readdirSync(path.dirname(occupied)).some(s=>s.startsWith('.mole-analytics-')),false);
});

test('quoted multiline CSV preserves text and malformed header options reject writes',t=>{
  const dir=workspace(t);
  const text='metric_id,definition\r\nx,"line one, with ""quotes""\nline two"\r\n';
  const m=parseAnalytics(text,{...options,format:'csv',releaseId:'r'}).metrics[0];
  assert.equal(m.definition,'line one, with "quotes"\nline two');assert.equal(m.provenance.definition.locator,'record:2/definition');
  fs.writeFileSync(path.join(dir,'bad.csv'),'metric_id,credential\nx,secret');
  assert.throws(()=>importAnalytics(dir,{file:'bad.csv',identity,changeId:'x'}));assert.equal(fs.existsSync(path.join(dir,'6-raw')),false);
});

test('failure after publication can resume registration without replacing payloads',t=>{
  const dir=workspace(t);const original=fs.linkSync;let fault=false;
  fs.linkSync=function(from,to){const result=original.call(fs,from,to);if(!fault && String(to).includes('5-evidence/analytics')){fault=true;throw new Error('Interrupted after publication');}return result;};
  try{assert.throws(()=>importAnalytics(dir,{file:'input.json',identity}),/Interrupted/);}finally{fs.linkSync=original;}
  const retry=importAnalytics(dir,{file:'input.json',identity});assert.equal(retry.changed,false);assert.equal(listLifecycleRecords(dir).length,2);
});
