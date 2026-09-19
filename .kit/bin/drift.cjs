#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const spec = yaml.load(read('.kit/conventions/pr-title.yaml'));
const manifest = JSON.parse(read('.kit/vendor/validate-pr-title/manifest.json'));
const upstream = require(path.join(ROOT, '.kit/vendor/validate-pr-title/src/constants.js'));

const findings = [];
const flag = (id, msg) => findings.push({ id, msg });

// ── Arm 1: spec vs vendored authority ────────────────────────────────────────
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

if (!sameSet(spec.vocabulary.types, upstream.TYPES)) {
  flag(
    'SPEC-TYPES',
    `spec types ${JSON.stringify(spec.vocabulary.types)} != upstream ${JSON.stringify(upstream.TYPES)}`,
  );
}
if (!sameSet(spec.vocabulary.scopes, upstream.SCOPES)) {
  flag(
    'SPEC-SCOPES',
    `spec scopes ${JSON.stringify(spec.vocabulary.scopes)} != upstream ${JSON.stringify(upstream.SCOPES)}`,
  );
}

// ── Arm 2: external pin still matches the snapshot ───────────────────────────
const wfPath = manifest.pinned_by;
if (exists(wfPath)) {
  const pinned = read(wfPath).match(/validate-n8n-pull-request-title@([0-9a-f]{40})/);
  if (!pinned) {
    flag('PIN-MISSING', `no pinned SHA found in ${wfPath}`);
  } else if (pinned[1] !== manifest.sha) {
    flag('PIN-MOVED', `workflow pins ${pinned[1]}, snapshot is ${manifest.sha} — re-vendor`);
  }
} else {
  flag('PIN-UNREADABLE', `${wfPath} not found`);
}

// ── Arm 3: in-repo transcriptions vs authority ───────────────────────────────
// Each check states what the file claims, and compares it to what upstream says.
function missingScopes(text, label) {
  const missing = upstream.SCOPES.filter(
    (s) => !new RegExp(`\\b${s.replace(/-/g, '\\-')}\\b`).test(text),
  );
  return missing.length ? `${label} omits upstream scope(s): ${missing.join(', ')}` : null;
}

const CHECKS = [
  {
    id: 'D001a',
    file: '.github/pull_request_title_conventions.md',
    check: (t) =>
      /###?\s*Revert commits/i.test(t) && !upstream.TYPES.includes('revert')
        ? 'documents a `revert` type; upstream TYPES has no `revert` (CI returns INVALID_TYPE)'
        : null,
  },
  {
    id: 'D001b',
    file: '.agents/skills/create-pr/SKILL.md',
    check: (t) =>
      /\(feat\|[a-z|]*\brevert\b/.test(t) && !upstream.TYPES.includes('revert')
        ? 'regex accepts `revert`; upstream TYPES does not'
        : null,
  },
  {
    id: 'D001c',
    file: '.agents/skills/community-pr-readiness-check/reference/checks.md',
    check: (t) =>
      /\^revert\(/.test(t) && !upstream.TYPES.includes('revert')
        ? 'carries a dedicated `revert` pattern; upstream TYPES does not include it'
        : null,
  },
  {
    id: 'D002a',
    file: '.github/pull_request_title_conventions.md',
    check: (t) => missingScopes(t, 'documented scope list'),
  },
  {
    id: 'D002b',
    file: '.agents/skills/create-pr/SKILL.md',
    check: (t) => missingScopes(t, 'documented scope list'),
  },
  {
    id: 'D003',
    file: '.agents/skills/community-pr-readiness-check/reference/checks.md',
    check: (t) =>
      /\[a-zA-Z0-9 \]/.test(t) && upstream.SCOPES.some((s) => s.includes('-'))
        ? `scope char class excludes "-", so valid scope(s) ${upstream.SCOPES.filter((s) => s.includes('-')).join(', ')} are rejected`
        : null,
  },
  {
    id: 'D004',
    file: '.agents/skills/create-pr/SKILL.md',
    check: (t) =>
      /\[a-zA-Z0-9 \]/.test(t)
        ? 'scope char class excludes ",", so multi-scope titles (upstream splits on ", ") are rejected'
        : null,
  },
  {
    id: 'D005',
    file: '.agents/skills/create-pr/SKILL.md',
    check: (t) =>
      /\^\(feat\|/.test(t) && spec.parse.anchored === false
        ? 'regex is anchored with ^; upstream schema regex is unanchored, so CI accepts prefixed titles this rejects'
        : null,
  },
];

for (const c of CHECKS) {
  if (!exists(c.file)) {
    flag(c.id, `${c.file} not found`);
    continue;
  }
  const msg = c.check(read(c.file));
  if (msg) flag(c.id, `${c.file}: ${msg}`);
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\nAuthority: ${manifest.repo}@${manifest.ref} (${manifest.sha.slice(0, 10)})`);
console.log(`Types:  ${upstream.TYPES.join(', ')}`);
console.log(`Scopes: ${upstream.SCOPES.join(', ')}\n`);

if (!findings.length) {
  console.log('✅ No drift. Transcriptions agree with the vendored authority.\n');
  process.exit(0);
}

console.log(
  `⚠️  ${findings.length} divergence(s) between documented conventions and the validator CI runs:\n`,
);
for (const f of findings) console.log(`  [${f.id}] ${f.msg}`);
console.log('');
process.exit(1);
