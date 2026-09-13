// Feature 072 / item #433 — the tripwire that keeps the Langfuse major out of Unleash's data.
//
// THE TRAP THIS EXISTS FOR. Langfuse 4's own reference compose declares
// `postgres:${POSTGRES_VERSION:-17}`, and following upstream is the obvious move. It is the wrong one here,
// and wrong in a way that is invisible in the diff: `langfuse-postgres` and `unleash-postgres` reference the
// IDENTICAL pinned digest, so a single find-and-replace on the Postgres image moves BOTH — and Unleash's
// store is NOT covered by ADR-0002 §4, which ratifies disposability for the Langfuse trace store and the
// OpenSearch audit store and nothing else.
//
// So the failure mode is: a reviewer approves "bump Postgres for Langfuse 4", and a third stateful service
// with real nobody-agreed-to-lose-it data is migrated at the same time, silently.
//
// `${POSTGRES_VERSION:-17}` upstream is a DEFAULT, not a floor — spec.md FR-005. If Langfuse 4 is ever
// PROVEN to require 17, that is a separate feature scoped to include Unleash, and this guard is what forces
// that conversation to happen rather than be skipped.
//
// Asserted on BOTH files: prod is the one that matters and dev is the one that gets edited first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = [
  'infrastructure-as-code/docker/observability/compose.yaml',
  'infrastructure-as-code/docker/observability/compose.prod.yaml',
];
const load = (rel) => parseYaml(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));

test('langfuse-postgres and unleash-postgres share ONE pinned image, in both compose files', () => {
  for (const rel of FILES) {
    const svc = load(rel)?.services ?? {};
    const lf = svc['langfuse-postgres']?.image;
    const un = svc['unleash-postgres']?.image;

    // If either service is gone the assertion below would pass vacuously — the count-of-zero shape.
    assert.ok(lf, `${rel}: langfuse-postgres has no image (renamed? then re-derive this guard)`);
    assert.ok(un, `${rel}: unleash-postgres has no image (renamed? then re-derive this guard)`);

    assert.equal(
      lf,
      un,
      `${rel}: langfuse-postgres and unleash-postgres no longer reference the same image.\n` +
        `  langfuse-postgres: ${lf}\n  unleash-postgres:  ${un}\n` +
        '  They share one pin by construction. If Langfuse needs a different Postgres, that is a ' +
        'deliberate SPLIT of one dependency into two — decide it, do not let it arrive as a diff.',
    );
  }
});

test('that shared Postgres pin stays on 16 — moving it migrates Unleash too (FR-005)', () => {
  for (const rel of FILES) {
    const image = load(rel)?.services?.['langfuse-postgres']?.image ?? '';
    const tag = String(image).split('@')[0].split(':').pop();
    assert.match(
      tag,
      /^16(\b|[.-])/,
      `${rel}: the shared Postgres pin is on '${tag}', not 16.\n` +
        "  Langfuse 4's reference compose defaults to 17, but this digest is SHARED with unleash-postgres, " +
        'whose data ADR-0002 §4 does NOT cover. Moving it migrates Unleash as a side effect.\n' +
        '  If Langfuse 4 genuinely requires 17, that is a separate feature scoped to include Unleash ' +
        '(spec.md FR-005) — not a task appended to the Langfuse upgrade.',
    );
  }
});
