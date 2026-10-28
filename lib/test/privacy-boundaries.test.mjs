import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { captureNote, safeRepoPath, server } from '../../ui/server.mjs';
import { ingestPrivateCapture, privacyInventory, purgeRaw, scanRaw, assertPrivacyProcessing } from '../privacy.mjs';
import { claimInboxProcessing, completeInboxProcessing } from '../inbox-processing.mjs';
import { registerSource } from '../source-registry.mjs';
import { assertNoPrivatePackagedFiles } from '../../scripts/verify-package.mjs';
const checkout = fileURLToPath(new URL('../..', import.meta.url));
const canary = ['synthetic-review', 'example.invalid'].join('@');
async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-boundary-'));
  try { return await fn(root); } finally { fs.rmSync(root, {recursive:true,force:true}); }
}
function ledger(root) {
  const walk = dir => !fs.existsSync(dir) ? '' : fs.readdirSync(dir,{withFileTypes:true}).map(e => e.isDirectory() ? walk(path.join(dir,e.name)) : fs.readFileSync(path.join(dir,e.name),'utf8')).join('\n');
  return walk(path.join(root,'governance'));
}
function template(root) {
  const paths = spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:checkout,encoding:'utf8'}).stdout.split('\0').filter(Boolean);
  for (const rel of paths) { const dst=path.join(root,rel); fs.mkdirSync(path.dirname(dst),{recursive:true}); fs.copyFileSync(path.join(checkout,rel),dst); }
}
test('R1 CLI/UI reject sensitive visibility before any ledger writes, registry rejects direct unsafe metadata', async () => fixture(async root => {
  const cli = spawnSync(process.execPath,[path.join(checkout,'cli/mole.mjs'),'insight','Synthetic CSV observation','--visibility',canary],{cwd:root,encoding:'utf8'});
  assert.notEqual(cli.status,0);
  assert.ok(!cli.stderr.includes(canary));
  const ui = await captureNote(root,{note:'Synthetic CSV observation',visibility:canary});
  assert.equal(ui.status,400);
  assert.ok(!JSON.stringify(ui).includes(canary));
  assert.equal(privacyInventory(root).length,0);
  fs.mkdirSync(path.join(root,'6-raw/inbox'),{recursive:true});
  fs.writeFileSync(path.join(root,'6-raw/inbox/synthetic.md'),'Synthetic clean note');
  assert.throws(()=>registerSource(root,{path:'6-raw/inbox/synthetic.md',visibility:canary}),err=>!err.message.includes(canary));
  assert.ok(!ledger(root).includes(canary));
}));
test('R2 actual npm artifact excludes ignored untracked inbox/quarantine/staging/archive bytes', async () => fixture(async root => {
  template(root);
  for (const dir of ['inbox','quarantine','staging','inbox/archive']) { fs.mkdirSync(path.join(root,'6-raw',dir),{recursive:true}); fs.writeFileSync(path.join(root,'6-raw',dir,'synthetic-private.md'),canary); }
  const pack = spawnSync('npm',['pack','--dry-run','--json','--ignore-scripts'],{cwd:root,encoding:'utf8',env:{...process.env,npm_config_cache:path.join(root,'.npm-cache')}});
  assert.equal(pack.status,0,pack.stderr);
  const entries=JSON.parse(pack.stdout)[0].files.map(f=>f.path);
  assert.deepEqual(entries.filter(p=>p.startsWith('6-raw/')),['6-raw/inbox/README.md']);
  assert.throws(()=>assertNoPrivatePackagedFiles(['package/6-raw/quarantine/synthetic.bin']));
}));
test('R3 dirty template scaffold excludes originals and does not recreate expired captures', async () => fixture(async root => {
  const src=path.join(root,'template'); fs.mkdirSync(src); template(src);
  const privacy=await import(pathToFileURL(path.join(src,'lib/privacy.mjs')));
  const cli=await import(pathToFileURL(path.join(src,'cli/mole.mjs')));
  const item=privacy.ingestPrivateCapture(src,{content:'Synthetic unknown token',now:'2020-01-01'});
  const dst=path.join(root,'destination'); cli.createWorkspaceScaffold(dst);
  assert.equal(fs.existsSync(path.join(dst,item.path)),false);
  assert.equal(privacy.scanRaw(dst).unregistered_items,0);
  assert.ok(fs.existsSync(path.join(src,item.path)));
  assert.equal(privacy.privacyInventory(src)[0].expires_at,item.record.expires_at);
}));
test('R4 reject sensitive completion and ownership metadata without leaking into receipts or metrics', async () => fixture(async root => {
  const capture=await captureNote(root,{note:'Synthetic CSV observation'});
  const p=capture.payload.path; assertPrivacyProcessing(root,[p]);
  const owner={processor:'synthetic-review',host:'synthetic-host',claimedPaths:[p]};
  const claim=claimInboxProcessing(root,owner); assert.equal(claim.ok,true,claim.message);
  assert.throws(()=>completeInboxProcessing(root,{...owner,runId:claim.run_id,processed:[p],summary:`Contact ${canary}`}),err=>!err.message.includes(canary));
  assert.ok(!ledger(root).includes(canary));
  const done=completeInboxProcessing(root,{...owner,runId:claim.run_id,processed:[p],summary:'Synthetic completed'});
  assert.equal(done.ok,true,done.message);
  assert.equal(purgeRaw(root,{apply:true,now:'2099-01-01'}).items[0].status,'deleted');
  assert.ok(!ledger(root).includes(canary));
  assert.throws(()=>claimInboxProcessing(root,{processor:canary,host:'synthetic-host'}),err=>!err.message.includes(canary));
  assert.ok(!ledger(root).includes(canary));
}));
test('R5 invalid recovery location fails before deletion or tombstone mutation', async () => fixture(async root => {
  const item=ingestPrivateCapture(root,{content:'Synthetic CSV',now:'2020-01-01'});
  const renamed=item.path.replace(/\.md$/,'.bin'); fs.renameSync(path.join(root,item.path),path.join(root,renamed));
  const manifest=path.join(root,'governance/privacy',`${item.record.source_id}.json`);
  const record=JSON.parse(fs.readFileSync(manifest)); record.current_path=renamed; fs.writeFileSync(manifest,JSON.stringify(record));
  assert.throws(()=>purgeRaw(root,{apply:true,now:'2099-01-01'}),/Privacy operation failed/);
  assert.ok(fs.existsSync(path.join(root,renamed)));
  assert.equal(JSON.parse(fs.readFileSync(manifest)).retention_state,'active');
}));
test('R6 UI rejects internal file and directory aliases into every private area', async () => fixture(async root => {
  const item=ingestPrivateCapture(root,{content:'Synthetic unknown token'});
  fs.mkdirSync(path.join(root,'5-evidence'),{recursive:true});
  for (const [i,relative] of [item.path,`governance/privacy/${item.record.source_id}.json`,'6-raw/quarantine','6-raw/staging','governance/privacy'].entries()) {
    const alias=`5-evidence/alias-${i}`; fs.symlinkSync(path.join(root,relative),path.join(root,alias));
    assert.throws(()=>safeRepoPath(alias,root));
    if (!relative.endsWith('.json') && !relative.endsWith('.bin')) assert.throws(()=>safeRepoPath(`${alias}/synthetic.bin`,root));
  }
}));
test('R7 malformed JSON and invalid capture shapes return controlled content-free errors', async () => {
  for (const body of [canary,`{"note":"${canary}"`, 'null', '[]', '{"note":42}']) {
    const req=Readable.from([Buffer.from(body)]); req.method='POST'; req.url='/api/capture'; req.headers={host:'localhost','content-type':'application/json'};
    const reply=await new Promise(resolve=>server.emit('request',req,{writeHead(status){this.status=status;},end(body){resolve({status:this.status,body});}}));
    assert.equal(reply.status,400,reply.body);
    assert.ok(!reply.body.includes(canary));
    assert.ok(!reply.body.includes('SyntaxError'));
  }
});
