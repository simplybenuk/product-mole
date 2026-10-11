import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTravelLogInstruction, createWorkspaceScaffold } from '../mole.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const moleCliPath = path.join(testDir, '..', 'mole.mjs');
const exampleDir = path.join(repoRoot, 'examples', 'product-travel-log');

const DECISIONS = ['continue', 'iterate', 'stop', 'investigate', 'unknown'];
// The report sections the issue asks for, in order.
const SECTIONS = [
  'Change and release',
  'Original intent',
  'What shipped',
  'Expected outcome',
  'Evidence before and after',
  'Unexpected effects',
  'Interpretation and confidence',
  'What we learned',
  'Decision',
  'Recommended next action',
  'Unresolved questions',
  'Sources and evidence gaps',
  'Retrieval receipt'
];

function read(...parts) {
  return fs.readFileSync(path.join(...parts), 'utf8');
}

/** Split a report into its `## ` sections, keyed by heading. */
function sectionsOf(markdown) {
  const sections = new Map();
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const part of body.split(/^## /m).slice(1)) {
    const [heading, ...rest] = part.split('\n');
    sections.set(heading.trim(), rest.join('\n').trim());
  }
  return sections;
}

function frontmatterOf(markdown) {
  const block = markdown.match(/^---\n([\s\S]*?)\n---\n/)[1];
  return Object.fromEntries(block.split('\n').filter((line) => /^[a-z_]+:/.test(line)).map((line) => {
    const index = line.indexOf(':');
    return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [moleCliPath, ...args], { cwd, encoding: 'utf8' });
}

describe('product travel log template and skill', () => {
  it('has every report section, in order, and a usable frontmatter', () => {
    const template = read(repoRoot, 'templates', 'artifacts', 'product-travel-log-template.md');
    assert.deepEqual([...sectionsOf(template).keys()], SECTIONS);
    const frontmatter = frontmatterOf(template);
    assert.equal(frontmatter.artifact_type, 'product-travel-log');
    assert.equal(frontmatter.decision, 'unknown');
    assert.ok(frontmatter.summary, 'the template needs a default summary');
    for (const decision of DECISIONS) assert.ok(template.includes(`\`${decision}\``), decision);
  });

  it('tells the agent not to invent evidence and to leave decisions to a person', () => {
    const skill = read(repoRoot, 'cli', 'skills', 'mole-product-travel-log', 'SKILL.md');
    assert.match(skill, /^---\nname: mole-product-travel-log\ndescription: .+\n---\n/);
    for (const rule of [
      /Do not invent an intent, a metric, a result, or a causal explanation/,
      /write `unknown`/,
      /No intent record found/,
      /Say when the review is too early/,
      /do not say the measure was met/,
      /--actor "<agent name>" --actor-type agent --reason "Ready for review"/,
      /`mixed` otherwise/,
      /Say when attribution is weak/,
      /one decision per change/i,
      /Never overwrite existing context/,
      /never run `mole lifecycle approve`/,
      /mole lifecycle submit <record_id>/,
      /mole create product-travel-log/,
      /fact.*observation.*interpretation.*assumption/s
    ]) assert.match(skill, rule);
    for (const decision of DECISIONS) assert.ok(skill.includes(`\`${decision}\``), decision);
  });

  it('prints an instruction that names the subject and the rules', () => {
    const output = buildTravelLogInstruction('release 2026.09');
    assert.match(output, /^Suggested agent instruction:\n\nWrite a product travel log for: release 2026\.09\./);
    assert.match(output, /mole-product-travel-log skill/);
    assert.match(output, /Do not invent an intent, a metric, a result, or a cause/);
    assert.match(output, /continue, iterate, stop, investigate, or unknown/);
    assert.match(output, /a learning is durable only after a person approves the report/);
    assert.match(output, /mole lifecycle submit <record_id> --actor "<agent name>" --actor-type agent --reason "Ready for review"/);
    for (const section of SECTIONS.slice(0, 8)) assert.ok(output.includes(`- ${section}`), section);
    assert.throws(() => buildTravelLogInstruction('  '), /Name the change or release to review/);
  });
});

describe('product travel log worked example', () => {
  const rich = read(exampleDir, 'reports', 'travel-log-rich.md');
  const notesOnly = read(exampleDir, 'reports', 'travel-log-release-notes-only.md');
  const changes = ['CSV export', 'Onboarding checklist', 'Pricing page copy'];

  it('ships the inputs the reports cite', () => {
    for (const file of ['release-notes-2026-09.md', 'intent-csv-export.md', 'analytics-export.csv', 'support-signals.md']) {
      assert.ok(fs.existsSync(path.join(exampleDir, 'inputs', file)), file);
    }
    const notes = read(exampleDir, 'inputs', 'release-notes-2026-09.md');
    for (const change of changes) assert.ok(notes.toLowerCase().includes(change.toLowerCase()), change);
  });

  for (const [label, report] of [['rich inputs', rich], ['release notes alone', notesOnly]]) {
    it(`holds a complete report written from ${label}`, () => {
      const sections = sectionsOf(report);
      assert.deepEqual([...sections.keys()], SECTIONS);
      for (const [heading, body] of sections) assert.ok(body.length > 20, `${heading} is empty`);
      // None of the template's guidance sentences is left behind.
      const guidance = [...sectionsOf(read(repoRoot, 'templates', 'artifacts', 'product-travel-log-template.md')).values()]
        .flatMap((body) => body.split(/\n\n/))
        .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
        .filter((paragraph) => paragraph.length > 40 && !paragraph.startsWith('|') && !paragraph.startsWith('```'));
      assert.ok(guidance.length >= 10);
      const flat = report.replace(/\s+/g, ' ');
      for (const paragraph of guidance) assert.ok(!flat.includes(paragraph), `template text left in the report: ${paragraph}`);
      const frontmatter = frontmatterOf(report);
      assert.ok([...DECISIONS, 'mixed'].includes(frontmatter.decision), frontmatter.decision);
      assert.match(frontmatter.next_review, /^\d{4}-\d{2}-\d{2}$/);

      // A release with several changes: each has what shipped and a decision.
      for (const change of changes) {
        assert.match(sections.get('What shipped'), new RegExp(`\\*\\*${change}\\. Fact\\.\\*\\*`, 'i'), change);
        const decision = sections.get('Decision').match(new RegExp(`\\*\\*${change}: ([a-z]+)\\.\\*\\*`, 'i'));
        assert.ok(decision && DECISIONS.includes(decision[1]), `${change} needs a decision`);
      }
      assert.match(sections.get('Unresolved questions'), /Next review: \d{4}-\d{2}-\d{2}/);
      // The frontmatter decision is the shared decision, or "mixed".
      const made = new Set(changes.map((change) => sections.get('Decision').match(new RegExp(`\\*\\*${change}: ([a-z]+)\\.`, 'i'))[1]));
      assert.equal(frontmatter.decision, made.size === 1 ? [...made][0] : 'mixed');
      // Every source the body cites is declared in the frontmatter.
      const declared = report.match(/^---\n[\s\S]*?\n---\n/)[0].match(/src_[0-9a-f-]{36}/g);
      const cited = sections.get('Sources and evidence gaps').match(/src_[0-9a-f-]{36}/g);
      assert.deepEqual([...new Set(cited)].sort(), [...new Set(declared)].sort());
    });
  }

  it('separates facts, observations, interpretations, and assumptions when evidence exists', () => {
    for (const kind of ['Fact', 'Observation', 'Interpretation', 'Assumption']) {
      assert.match(rich, new RegExp(`\\*\\*(?:[A-Za-z ]+\\. )?${kind}[.,]`), kind);
    }
    const sections = sectionsOf(rich);
    assert.match(sections.get('Interpretation and confidence'), /Attribution is weak/);
    assert.match(sections.get('Interpretation and confidence'), /paid\s+campaign/);
    assert.match(sections.get('Evidence before and after'), /three weeks\. The intent record set its measures\s+at four weeks/);
    // Three weeks against a four-week measure: on track, not met.
    assert.ok(!/\bmet its\b|\bis meeting its\b/.test(rich));
    assert.match(sections.get('Decision'), /CSV export: iterate\.\*\* It is on track at three weeks; the measures are\s+judged at four/);
    // A change with no stated intent is not given one.
    assert.match(sections.get('Original intent'), /Onboarding checklist\.\*\* No intent record found/);
    assert.match(sections.get('Expected outcome'), /Onboarding checklist\.\*\* unknown/);
    assert.match(sections.get('Recommended next action'), /For a person to approve/);
  });

  it('writes explicit gaps when intent and analytics are missing', () => {
    const sections = sectionsOf(notesOnly);
    assert.equal((sections.get('Original intent').match(/No intent record found/g) || []).length, 3);
    assert.match(sections.get('Expected outcome'), /^unknown/);
    assert.match(sections.get('Evidence before and after'), /No analytics evidence and no qualitative signal were available/);
    assert.match(sections.get('Interpretation and confidence'), /Nothing can be concluded/);
    assert.equal((sections.get('Decision').match(/: unknown\./g) || []).length, 3);
    for (const gap of ['No intent record for any change', 'No analytics evidence', 'No qualitative signal']) {
      assert.ok(sections.get('Sources and evidence gaps').includes(gap), gap);
    }
    assert.equal(frontmatterOf(notesOnly).decision, 'unknown');
    // It does not borrow numbers, dates, or measures from evidence it was not given.
    assert.ok(!/\b\d+%|\btickets? fell\b|2026-08-|sign-ups|upgrades/.test(notesOnly));
  });

  it('matches the numbers in the analytics input', () => {
    const rows = read(exampleDir, 'inputs', 'analytics-export.csv').trim().split('\n').slice(1).map((line) => line.split(','));
    const after = rows.filter((row) => row[0] >= '2026-09-14');
    assert.ok(rich.includes(`| ${after.map((row) => row[3]).join(', ')} |`), 'export tickets after release');
    assert.ok(rich.includes(after.map((row) => `${Math.round((Number(row[2]) / Number(row[1])) * 100)}%`).join(', ')), 'export share after release');
    assert.ok(rich.includes(after.map((row) => `${row[5]} of ${row[4]}`).join(', ')), 'checklist completion');
  });
});

describe('mole travel-log and mole create product-travel-log', () => {
  function withWorkspace(callback) {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mole-travel-log-')));
    try {
      createWorkspaceScaffold(workspace);
      callback(workspace);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  it('creates a tracked draft from the template', () => {
    withWorkspace((workspace) => {
      const created = runCli(['create', 'product-travel-log'], workspace);
      assert.equal(created.status, 0, created.stderr);
      const draft = path.join(workspace, '4-context', 'travel-log', 'product-travel-log-draft.md');
      assert.equal(fs.readFileSync(draft, 'utf8'), read(repoRoot, 'templates', 'artifacts', 'product-travel-log-template.md'));
      assert.match(created.stdout, /Lifecycle record: rec_[0-9a-f-]{36} \(draft\)/);
      assert.match(created.stdout, /mole-product-travel-log skill/);
      assert.match(created.stdout, /submit the report for human review/);

      const elsewhere = runCli(['create', 'product-travel-log', '4-context/travel-log/release-2026-09.md'], workspace);
      assert.equal(elsewhere.status, 0, elsewhere.stderr);
      assert.ok(fs.existsSync(path.join(workspace, '4-context', 'travel-log', 'release-2026-09.md')));
    });
  });

  it('prints the instruction and lists the command and artifact in help', () => {
    withWorkspace((workspace) => {
      const printed = runCli(['travel-log', 'release', '2026.09'], workspace);
      assert.equal(printed.status, 0, printed.stderr);
      assert.match(printed.stdout, /Write a product travel log for: release 2026\.09\./);
      const missing = runCli(['travel-log'], workspace);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /Name the change or release to review/);

      const help = runCli(['--help'], workspace).stdout;
      assert.match(help, /mole travel-log <change-or-release>/);
      assert.match(help, /product-travel-log/);
    });
  });
});
