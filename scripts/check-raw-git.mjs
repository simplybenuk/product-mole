import { execFileSync } from 'node:child_process';
const names = execFileSync('git', ['ls-files', '-z', '--cached'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const bad = names.filter(n => (n.startsWith('6-raw/') && n !== '6-raw/inbox/README.md') || n.startsWith('governance/privacy/'));
if (bad.length) { console.error(`Git privacy guard rejected ${bad.length} raw or private metadata files. Remove them from the index.`); process.exitCode = 1; }
else console.log('Git raw-content guard passed.');
