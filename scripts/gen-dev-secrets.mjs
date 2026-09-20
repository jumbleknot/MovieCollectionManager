#!/usr/bin/env node
// Local dev-secret generator for feature 021 (externalize-compose-secrets).
// Reads each committed infrastructure-as-code/docker/stacks/<stack>.env.example and mints a real
// value for every `<generate:KIND>` placeholder, copying deterministic fixtures verbatim, into the
// gitignored <stack>.env that Docker Compose interpolates. Idempotent by default (preserves a
// running dev's values); --force rotates. See
// specs/021-externalize-compose-secrets/contracts/env-var-manifest.md.
//
// Usage:
//   node scripts/gen-dev-secrets.mjs                       # generate every missing <stack>.env
//   node scripts/gen-dev-secrets.mjs --force               # rotate ALL (overwrite existing)
//   node scripts/gen-dev-secrets.mjs --stack=observability # only one stack
//   node scripts/gen-dev-secrets.mjs --force --stack=auth  # rotate one stack
//
// Exit codes: 0 success · 1 missing/malformed template or unwritable output · 2 bad args.

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STACKS_DIR = resolve(REPO_ROOT, 'infrastructure-as-code/docker/stacks');
const STACKS = ['auth', 'mcm', 'audit', 'observability'];

// --- random primitives (crypto, unbiased) -----------------------------------
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGIT = '0123456789';
// URL/shell-safe specials only — excludes @ : / ? # % & " ' \ ` $ { } * ~ ^ and whitespace, so a
// complex-16 value is safe inside a `-u user:pass` curl arg, a YAML double-quoted scalar, and sh.
const SPECIAL = '-_.!=+';

/** Pick `n` chars from `alphabet` via rejection sampling (no modulo bias). */
function randChars(alphabet, n) {
  const max = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < n) {
    for (const b of randomBytes(Math.max(n - out.length, 1) * 2)) {
      if (b >= max) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === n) break;
    }
  }
  return out;
}
const b62 = (n) => randChars(B62, n);
const hex = (nBytes) => randomBytes(nBytes).toString('hex');
function randIndexBelow(n) {
  const max = 256 - (256 % n);
  for (;;) {
    const b = randomBytes(1)[0];
    if (b < max) return b % n;
  }
}
function complex16() {
  const all = UPPER + LOWER + DIGIT + SPECIAL;
  const picks = [randChars(UPPER, 1), randChars(LOWER, 1), randChars(DIGIT, 1), randChars(SPECIAL, 1)];
  while (picks.length < 16) picks.push(randChars(all, 1));
  for (let i = picks.length - 1; i > 0; i--) {
    const j = randIndexBelow(i + 1);
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }
  return picks.join('');
}

/** Mint a value for a <generate:KIND> placeholder (kinds per research.md R4). */
function mint(kind) {
  switch (kind) {
    case 'b62-32':
      return b62(32);
    case 'b62-48':
      return b62(48);
    case 'hex-64':
      return hex(32); // 32 bytes → 64 hex chars
    case 'complex-16':
      return complex16();
    case 'unleash-admin':
      return '*:*.' + b62(40);
    case 'unleash-client':
      return 'default:development.' + b62(40);
    case 'mongo-keyfile':
      // MongoDB replica-set keyfile content: base64 of 756 random bytes as ONE line (Node base64 has
      // no embedded newlines). Feature 026 — carried as an env value, materialized to a 0400 in-container
      // file by mc-service/mongo-entrypoint.sh (no host file-secret; feature 022 model).
      return randomBytes(756).toString('base64');
    default:
      throw new Error(`unknown generation KIND '${kind}'`);
  }
}

const PLACEHOLDER = /^<generate:([a-z0-9-]+)>$/;
const KV = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Add any template key absent from an existing `<stack>.env`, minting placeholders as usual and
 * copying fixtures verbatim. Existing keys are left EXACTLY as they are — including ones a
 * developer edited by hand — so this is safe to run on a live box with stacks up.
 */
function seedMissingKeys(stack, tmpl, out) {
  const present = new Set(
    readFileSync(out, 'utf8')
      .split(/\r?\n/)
      .map((l) => KV.exec(l.trim())?.[1])
      .filter(Boolean),
  );
  const added = [];
  for (const line of readFileSync(tmpl, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const kv = KV.exec(trimmed);
    if (!kv) {
      console.error(`  ${stack}: malformed template line: ${line}`);
      return { stack, status: 'malformed' };
    }
    const [, key, rawValue] = kv;
    if (present.has(key)) continue;
    const ph = PLACEHOLDER.exec(rawValue.trim());
    let value;
    if (ph) {
      try {
        value = mint(ph[1]);
      } catch (e) {
        console.error(`  ${stack}: ${e.message} (key ${key})`);
        return { stack, status: 'bad-kind' };
      }
    } else {
      value = rawValue;
    }
    added.push(`${key}=${value}`);
  }
  if (added.length === 0) {
    console.log(`  ${stack}: up to date (exists; --force to rotate)`);
    return { stack, status: 'skipped' };
  }
  const body = readFileSync(out, 'utf8').replace(/\n*$/, '\n');
  writeFileSync(out, `${body}${added.join('\n')}\n`, { encoding: 'utf8' });
  console.log(
    `  ${stack}: seeded ${added.length} new key(s) into ${stack}.env ` +
      `(${added.map((a) => a.split('=')[0]).join(', ')}); existing values untouched`,
  );
  return { stack, status: 'seeded' };
}

function generateStack(stack, force) {
  const tmpl = resolve(STACKS_DIR, `${stack}.env.example`);
  const out = resolve(STACKS_DIR, `${stack}.env`);
  if (!existsSync(tmpl)) {
    console.error(`  ${stack}: template missing (${stack}.env.example) — skipping`);
    return { stack, status: 'no-template' };
  }
  if (existsSync(out) && !force) {
    // NOT a plain skip. A template that has GAINED a key since this file was written would
    // otherwise never deliver it to an existing box, and the only way to get it would be
    // `--force`, which rotates every OTHER value — taking the running stacks down to add one
    // variable. That is why this generator's skip was a silent no-op with a success message, the
    // same defect class as 048 US6 and item #227: the step reports done and the thing is absent.
    // So: seed the keys the file does not yet define, and touch nothing it already has.
    return seedMissingKeys(stack, tmpl, out);
  }

  const lines = readFileSync(tmpl, 'utf8').split(/\r?\n/);
  const result = [
    '# GENERATED by scripts/gen-dev-secrets.mjs — DO NOT COMMIT (gitignored).',
    `# Stack: ${stack}. Real local credentials; re-run with --force to rotate randomized values.`,
  ];
  let keys = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // drop template comments/blanks
    const kv = KV.exec(trimmed);
    if (!kv) {
      console.error(`  ${stack}: malformed template line: ${line}`);
      return { stack, status: 'malformed' };
    }
    const [, key, rawValue] = kv;
    const ph = PLACEHOLDER.exec(rawValue.trim());
    let value;
    if (ph) {
      try {
        value = mint(ph[1]);
      } catch (e) {
        console.error(`  ${stack}: ${e.message} (key ${key})`);
        return { stack, status: 'bad-kind' };
      }
    } else {
      value = rawValue; // deterministic fixture — copy verbatim
    }
    result.push(`${key}=${value}`);
    keys++;
  }
  writeFileSync(out, result.join('\n') + '\n', { encoding: 'utf8' });
  console.log(`  ${stack}: ${force && existsSync(out) ? 'rotated' : 'generated'} ${stack}.env (${keys} keys)`);
  return { stack, status: 'written' };
}

// --- args --------------------------------------------------------------------
const args = process.argv.slice(2);
const force = args.includes('--force');
const stackArg = args.find((a) => a.startsWith('--stack='));
const unknown = args.filter((a) => a !== '--force' && !a.startsWith('--stack='));
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: gen-dev-secrets.mjs [--force] [--stack=<name>]`);
  process.exit(2);
}
let targets = STACKS;
if (stackArg) {
  const s = stackArg.split('=')[1];
  if (!STACKS.includes(s)) {
    console.error(`Unknown --stack value '${s}'. Valid: ${STACKS.join(', ')}.`);
    process.exit(2);
  }
  targets = [s];
}

console.log(`gen-dev-secrets: ${force ? 'rotating' : 'generating'} ${targets.join(', ')} under ${STACKS_DIR}`);
let failed = false;
for (const stack of targets) {
  let r;
  try {
    r = generateStack(stack, force);
  } catch (e) {
    console.error(`  ${stack}: ${e.message}`);
    failed = true;
    continue;
  }
  if (['no-template', 'malformed', 'bad-kind'].includes(r.status)) failed = true;
}
if (failed) {
  console.error('gen-dev-secrets: completed with errors.');
  process.exit(1);
}
console.log('gen-dev-secrets: done. (.env files are gitignored — never commit them.)');
