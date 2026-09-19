#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '../..');
const spec = yaml.load(fs.readFileSync(path.join(ROOT, '.kit/conventions/typescript.yaml'), 'utf8'));
const titleSpec = yaml.load(fs.readFileSync(path.join(ROOT, '.kit/conventions/pr-title.yaml'), 'utf8'));

const BASE = process.env.KIT_BASE || 'master';
const argv = process.argv.slice(2);
const titleArg = argv.includes('--title') ? argv[argv.indexOf('--title') + 1] : null;

const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ── glob → regex ─────────────────────────────────────────────────────────────
function globToRe(g) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = esc
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*');
  return new RegExp('^' + re + '$');
}
const matchesAny = (file, globs) => (globs || []).some((g) => globToRe(g).test(file));

// ── diff ─────────────────────────────────────────────────────────────────────
// Added lines only. Scanning whole files would drown the output in pre-existing
// violations and make the tool useless on a repo this size.
function addedLines() {
  let raw;
  try {
    raw = sh(`git diff -U0 ${BASE}...HEAD`);
    if (!raw.trim()) raw = sh('git diff -U0 HEAD');
  } catch {
    raw = sh('git diff -U0 HEAD');
  }
  const out = [];
  let file = null;
  let line = 0;
  for (const l of raw.split('\n')) {
    if (l.startsWith('+++ b/')) {
      file = l.slice(6);
      continue;
    }
    const hunk = l.match(/^@@ -\S+ \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = parseInt(hunk[1], 10);
      continue;
    }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      out.push({ file, line, text: l.slice(1) });
      line++;
    }
  }
  return out.filter((a) => a.file);
}

function changedFiles() {
  try {
    const r = sh(`git diff --name-only ${BASE}...HEAD`).split('\n').filter(Boolean);
    return r.length ? r : sh('git diff --name-only HEAD').split('\n').filter(Boolean);
  } catch {
    return sh('git diff --name-only HEAD').split('\n').filter(Boolean);
  }
}

// ── node display names, resolved offline ─────────────────────────────────────
// Upstream shells out to `npm install` + ts-node at validation time and fails
// open when that breaks. Reading them off disk is instant and fails closed.
let _names = null;
function nodeDisplayNames() {
  if (_names) return _names;
  const names = new Set();
  const roots = [
    path.join(ROOT, 'packages/nodes-base/nodes'),
    path.join(ROOT, 'packages/@n8n/nodes-langchain/nodes'),
  ];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.node.ts')) {
        const m = fs.readFileSync(p, 'utf8').match(/displayName:\s*'([^']+)'/);
        if (m) names.add(m[1]);
      }
    }
  };
  roots.forEach(walk);
  _names = [...names];
  return _names;
}

// ── title validation ─────────────────────────────────────────────────────────
// Mirrors .kit/vendor/validate-pr-title/src/validatePrTitle.js. Error strings
// are reproduced verbatim so local output reads identically to CI output.
function checkTitle(title) {
  const issues = [];
  const m = title.match(new RegExp(titleSpec.parse.regex));
  if (!m) {
    return ['PR title does not match PR title convention: type: subject or type(scope): subject'];
  }
  if (/n8n-\d{3,5}/i.test(title)) return ['PR title must not contain a ticket number'];
  if (/#\d{5,7}/.test(title)) return ['Title must not include pull request number'];

  const { type, scope, subject } = m.groups;

  if (!titleSpec.vocabulary.types.includes(type)) {
    issues.push(
      `Unknown \`type\` in PR title: ${type}. Expected one of ${titleSpec.vocabulary.types.join(', ')}`,
    );
  }

  if (scope) {
    if (/,\S/.test(scope)) {
      issues.push('Missing whitespace after comma to separate multiple scopes');
    } else {
      const names = nodeDisplayNames();
      for (const s of scope.split(', ')) {
        if (s.endsWith(' Node')) {
          if (names.length && !names.some((n) => s.startsWith(n))) {
            issues.push(`Unknown \`scope\` in PR title: ${s}`);
          }
        } else if (!titleSpec.vocabulary.scopes.includes(s)) {
          issues.push(
            `Unknown \`scope\` in PR title: ${s}. Expected one of ${titleSpec.vocabulary.scopes.join(', ')} or \`<displayName> Node\``,
          );
        }
      }
    }
  }

  if (/^[a-z]/.test(subject)) issues.push('First char of subject must be uppercase');
  if (subject.startsWith('(')) issues.push('Subject must not start with parens');
  if (/\.$/.test(subject)) issues.push('Subject must not end with a period');
  if (subject.split(' ')[0].endsWith('ed')) {
    issues.push(
      'Subject must use present tense  [upstream heuristic: fires when the first word ends in "ed" — known false positives: Embed, Speed, Seed, Feed, Exceed, Succeed]',
    );
  }
  if (subject.includes('(no-changelog)') && !/ \(no-changelog\)$/.test(subject)) {
    issues.push('`(no-changelog)` must be located at the end of the subject');
  }
  return issues;
}

// ── boundaries ───────────────────────────────────────────────────────────────
function boundaryHits(files) {
  const hits = [];
  for (const r of spec.restricted || []) {
    if (r.path) {
      const re = globToRe(r.path);
      for (const f of files) if (re.test(f)) hits.push({ file: f, reason: r.reason, redirect: r.redirect });
    }
    if (r.nodes) {
      for (const f of files) {
        for (const n of r.nodes) {
          const slug = n.replace(/\s+/g, '');
          if (new RegExp(`packages/nodes-base/nodes/${slug}/`, 'i').test(f)) {
            hits.push({ file: f, reason: `${n}: ${r.reason}`, redirect: r.redirect });
          }
        }
      }
    }
  }
  return hits;
}

// ── run ──────────────────────────────────────────────────────────────────────
const added = addedLines();
const files = changedFiles();
const violations = [];

for (const rule of spec.rules) {
  if (!rule.detect || !rule.detect.regex) continue;
  const re = new RegExp(rule.detect.regex, rule.detect.flags || '');
  for (const a of added) {
    if (!matchesAny(a.file, rule.scope)) continue;
    if (rule.exclude && matchesAny(a.file, rule.exclude)) continue;
    if (re.test(a.text)) {
      violations.push({
        sev: rule.severity,
        id: rule.id,
        file: a.file,
        line: a.line,
        msg: rule.statement,
        hint: rule.fix_hint,
      });
    }
  }
}

// file-level absence rules (e.g. CI001 — workflow permissions block)
for (const rule of spec.rules) {
  if (!rule.detect || !rule.detect.absence_is_violation) continue;
  for (const f of files) {
    if (!matchesAny(f, rule.scope)) continue;
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) continue;
    const body = fs.readFileSync(abs, 'utf8');
    if (!new RegExp(`^${rule.detect.requires_key}:`, 'm').test(body)) {
      violations.push({ sev: rule.severity, id: rule.id, file: f, line: 1, msg: rule.statement });
    }
  }
}

const title = titleArg || sh('git log -1 --pretty=%s').trim();
const titleIssues = checkTitle(title);
const bounds = boundaryHits(files);

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\nBase: ${BASE}   Files changed: ${files.length}   Added lines scanned: ${added.length}`);
console.log(`Title: ${title}\n`);

if (bounds.length) {
  console.log('RESTRICTED AREA — this change touches code the n8n team owns:');
  for (const b of bounds) {
    console.log(`  ${b.file}`);
    console.log(`    ${b.reason}${b.redirect ? `  See ${b.redirect}` : ''}`);
  }
  console.log('');
}

for (const t of titleIssues) console.log(`  ERROR  [title] ${t}`);

const order = { error: 0, warn: 1, advisory: 2 };
violations.sort((a, b) => order[a.sev] - order[b.sev] || a.file.localeCompare(b.file));
for (const v of violations) {
  console.log(`  ${v.sev.toUpperCase().padEnd(6)} [${v.id}] ${v.file}:${v.line}`);
  console.log(`         ${v.msg}`);
  if (v.hint) console.log(`         fix: ${v.hint}`);
}

const advisory = (spec.rules || []).filter((r) => r.severity === 'advisory');
if (advisory.length) {
  console.log(`\n${advisory.length} advisory rule(s) with no reliable static check — agent-surfaced only:`);
  for (const r of advisory) console.log(`  [${r.id}] ${r.statement}`);
}

const blocking =
  titleIssues.length + violations.filter((v) => v.sev === 'error').length + bounds.length;
console.log(blocking ? `\n❌ ${blocking} blocking issue(s)\n` : '\n✅ No blocking issues\n');
process.exit(blocking ? 1 : 0);
