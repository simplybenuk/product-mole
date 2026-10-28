import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureNote } from '../../ui/server.mjs';
import { privacyInventory, assertPrivacyProcessing, purgeRaw } from '../privacy.mjs';
import { registerLifecycleRecord, transitionLifecycleRecord, relocateLifecycleRecord } from '../review-lifecycle.mjs';
import { registerSource } from '../source-registry.mjs';
const cli=fileURLToPath(new URL('../../cli/mole.mjs',import.meta.url));
async function fixture(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'mole-round2-'));try{return await fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
const run=(root,args)=>spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8'});
function ledgers(root){const walk=dir=>!fs.existsSync(dir)?'':fs.readdirSync(dir,{withFileTypes:true}).map(e=>e.isDirectory()?walk(path.join(dir,e.name)):fs.readFileSync(path.join(dir,e.name),'utf8')).join('\n');return walk(path.join(root,'governance'));}
const cases=[
 ['PERSON_NAME','person name: Roundtwo Synthetic'],['ADDRESS','postal address: 2 Roundtwo Road'],
 ['CUSTOMER_ID','customer_id: roundtwo-fixture'],['API_KEY','api_key: roundtwo-label-only-value'],
 ['HEALTH_DATA','diagnosis: roundtwo-fixture'],['FINANCIAL_DATA','bank account: roundtwo-fixture'],
 ['CONFIDENTIAL_BUSINESS','contract terms: roundtwo-fixture']
];
for(const [category,input] of cases) test(`R8 CLI multiline ${category} never survives in any serialized copy`,async()=>fixture(async root=>{
 const proc=run(root,['insight',`Synthetic first line\n${input}`]);assert.equal(proc.status,0,proc.stderr);
 const record=privacyInventory(root)[0];assert.equal(record.outcome,'redacted');
 const content=fs.readFileSync(path.join(root,record.current_path),'utf8');
 assert.ok(!content.includes(input),category);assert.ok(content.includes(`[${category}]`));
 assertPrivacyProcessing(root,[record.current_path]);
 assert.ok(!ledgers(root).includes(input));
 assert.equal(purgeRaw(root,{apply:true,now:'2099-01-01'}).items[0].status,'deleted');
 assert.ok(!ledgers(root).includes(input));
}));
test('R8 every CLI metadata value is scanned before YAML escaping; uncertainty stays quarantined',async()=>fixture(async root=>{
 const input='api_key: roundtwo-field-value';
 for(const flag of ['--stakeholder','--requested-by','--audience','--interest-area','--captured-by','--follow-up-by']){
  const proc=run(root,['insight','Synthetic note',flag,`Synthetic first line\n${input}`]);assert.equal(proc.status,0,proc.stderr);
 }
 for(const record of privacyInventory(root)){
  assert.notEqual(record.outcome,'quarantined');
  assert.ok(!fs.readFileSync(path.join(root,record.current_path),'utf8').includes(input));
 }
 const uncertain='Synthetic first line\nunknown token requires review';
 const proc=run(root,['insight','Synthetic note','--stakeholder',uncertain]);assert.equal(proc.status,0,proc.stderr);
 const quarantine=privacyInventory(root).find(r=>r.outcome==='quarantined');assert.ok(quarantine);
 assert.throws(()=>assertPrivacyProcessing(root,[quarantine.current_path]));
 assert.ok(!ledgers(root).includes(input));
 purgeRaw(root,{apply:true,now:'2099-01-01'});assert.ok(!ledgers(root).includes(input));
}));
test('R9 lifecycle rejects actor/reason before mutation and permits clean retries across all paths',async()=>fixture(async root=>{
 const secret='api_key: roundtwo-label-only-value';const email=['roundtwo.synthetic','example.invalid'].join('@');
 const capture=await captureNote(root,{note:`Synthetic context\n${secret}`});assert.equal(capture.status,200);
 assertPrivacyProcessing(root,[capture.payload.path]);
 const ledger=path.join(root,'governance/lifecycle/records.json');
 const before=fs.readFileSync(ledger,'utf8');
 const options={actor:'synthetic-review',actorType:'agent',reason:'Synthetic draft'};
 for(const bad of [{reason:secret},{actor:email}]){
  const proc=run(root,['lifecycle','draft',capture.payload.record_id,'--actor',bad.actor||options.actor,'--actor-type','agent','--reason',bad.reason||options.reason]);
  assert.notEqual(proc.status,0);assert.ok(!proc.stderr.includes(secret));assert.ok(!proc.stderr.includes(email));
  assert.equal(fs.readFileSync(ledger,'utf8'),before);
  assert.throws(()=>registerLifecycleRecord(root,{...options,sourceId:capture.payload.source_id,...bad}),e=>!e.message.includes(secret)&&!e.message.includes(email));
  assert.equal(fs.readFileSync(ledger,'utf8'),before);
  assert.throws(()=>relocateLifecycleRecord(root,capture.payload.record_id,{...options,path:'4-context/not-used.md',...bad}),e=>!e.message.includes(secret)&&!e.message.includes(email));
  assert.equal(fs.readFileSync(ledger,'utf8'),before);
 }
 const result=transitionLifecycleRecord(root,capture.payload.record_id,{...options,action:'draft'});assert.equal(result.ok,true);
 const noHistory=path.join(root,'6-raw/inbox/second.md');fs.writeFileSync(noHistory,'Synthetic clean note');
 const src=registerSource(root,{path:'6-raw/inbox/second.md',captured_by:'synthetic',channel:'test'});
 assert.throws(()=>registerLifecycleRecord(root,{...options,sourceId:src.source_id,actor:email}),e=>!e.message.includes(email));
 assert.ok(registerLifecycleRecord(root,{...options,sourceId:src.source_id,state:'raw'}).ok);
 assert.ok(!ledgers(root).includes(secret));assert.ok(!ledgers(root).includes(email));
 // Only the managed capture is purged; the separate synthetic file is not an inbox capture.
 fs.rmSync(noHistory);
 assert.equal(purgeRaw(root,{apply:true,now:'2099-01-01'}).items[0].status,'deleted');
 assert.ok(!ledgers(root).includes(secret));assert.ok(!ledgers(root).includes(email));
}));

test('R8 UI original field values are scanned and uncertain metadata cannot publish',async()=>fixture(async root=>{
 const input='api_key: roundtwo-ui-field-value';
 for(const field of ['source','channel','confidence','capturedBy','captured_by','tags']) {
  const value=`Synthetic first line\n${input}`;
  const response=await captureNote(root,{note:'Synthetic note',[field]:field==='tags'?[value]:value});
  assert.equal(response.status,200,JSON.stringify(response));
  assert.notEqual(response.payload.state,'quarantined');
  const record=privacyInventory(root).find(r=>r.source_id===response.payload.source_id);
  assert.ok(!fs.readFileSync(path.join(root,record.current_path),'utf8').includes(input));
  assertPrivacyProcessing(root,[record.current_path]);
 }
 const uncertain='Synthetic first line\nunknown token requires review';
 const response=await captureNote(root,{note:'Synthetic note',tags:[uncertain]});
 assert.equal(response.payload.state,'quarantined');
 assert.ok(fs.readFileSync(path.join(root,response.payload.path),'utf8').includes('unknown token requires review'));
 assert.throws(()=>assertPrivacyProcessing(root,[response.payload.path]));
 purgeRaw(root,{apply:true,now:'2099-01-01'});
 assert.ok(!ledgers(root).includes(input));assert.ok(!ledgers(root).includes(uncertain));
}));
test('R9 normalized actors and implicit lock identity reject before any ledger write',async()=>fixture(async root=>{
 const capture=await captureNote(root,{note:'Synthetic note'});
 const email=['roundtwo.synthetic','example.invalid'].join('@');
 const file=path.join(root,'governance/lifecycle/records.json');const before=fs.readFileSync(file,'utf8');
 const options={action:'draft',actorType:'agent',reason:'Synthetic draft'};
 assert.throws(()=>transitionLifecycleRecord(root,capture.payload.record_id,{...options,actor:{toString:()=>email}}),e=>!e.message.includes(email));
 const original=os.hostname;
 try {
  os.hostname=()=>email;
  assert.throws(()=>transitionLifecycleRecord(root,capture.payload.record_id,{...options,actor:'synthetic-review'}),e=>!e.message.includes(email));
 } finally { os.hostname=original; }
 assert.equal(fs.readFileSync(file,'utf8'),before);
 assert.ok(!fs.existsSync(path.join(root,'governance/lifecycle/.mutation.lock')));
 assert.ok(!ledgers(root).includes(email));
}));
test('R9 relocation rejection preserves source and lifecycle ledgers for a clean retry',async()=>fixture(async root=>{
 const capture=await captureNote(root,{note:'Synthetic relocation observation'});
 const options={actor:'synthetic-review',actorType:'agent',reason:'Synthetic draft'};
 transitionLifecycleRecord(root,capture.payload.record_id,{...options,action:'draft'});
 fs.mkdirSync(path.join(root,'4-context'),{recursive:true});
 const target='4-context/synthetic-clean.md';
 fs.renameSync(path.join(root,capture.payload.path),path.join(root,target));
 const before=ledgers(root);
 const secret='api_key: roundtwo-relocation-value';
 assert.throws(()=>relocateLifecycleRecord(root,capture.payload.record_id,{...options,path:target,reason:secret}),e=>!e.message.includes(secret));
 assert.equal(ledgers(root),before);
 assert.ok(relocateLifecycleRecord(root,capture.payload.record_id,{...options,path:target,reason:'Synthetic relocation'}).ok);
 purgeRaw(root,{apply:true,now:'2099-01-01'});
 assert.ok(fs.existsSync(path.join(root,target)));
 assert.ok(!ledgers(root).includes(secret));
}));
