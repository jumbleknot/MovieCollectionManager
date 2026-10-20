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
// `${POSTGRES_VERSION:-17}` upstream is a DEFAULT, not a floor — feature 072's spec.md FR-005. Moving the
// pin was to be a separate feature scoped to include Unleash; spec 081 US8b is that feature, and it moved
// both databases 16 -> 18 together (the second test below was updated at its cause, not deleted).
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

// UPDATED AT THE CAUSE — spec 081 US8b (T060). The premise this test protected was "the shared pin
// stays on 16, because moving it migrates Unleash as a side effect". Spec 081 is the separate feature
// FR-005 asked for: it is scoped to include Unleash (OQ-3 — Unleash flag state is preserved by
// dump/restore, Langfuse traces are discarded per ADR-0002 §4) and it moves BOTH databases to 18 in
// ONE change. So the premise is now "both consumers sit on the 18 line, together". The pairing test
// above still fails on a split; this one now fails on a regression to 16 (a revert that strands
// Unleash's restored-on-18 data dir behind an image that cannot read it) and on an unreviewed move off
// 18 (19 is again a data migration of a store ADR-0002 does not cover — a new spec, not a diff).
test('that shared Postgres pin is on the 18 line — both databases moved together (spec 081 US8b)', () => {
  for (const rel of FILES) {
    const svc = load(rel)?.services ?? {};
    for (const name of ['langfuse-postgres', 'unleash-postgres']) {
      const image = String(svc[name]?.image ?? '');
      const [ref, digest] = image.split('@');
      const tag = ref.split(':').pop();
      assert.match(
        tag,
        /^18(\b|[.-])/,
        `${rel}: ${name} is on postgres '${tag}', not the 18 line.\n` +
          '  Spec 081 US8b moved BOTH observability databases to 18 together, restoring Unleash\'s flag state ' +
          'onto 18 (ADR-0002 §4 covers only the Langfuse traces). A 16 here cannot read the 18 data directory; ' +
          'a 19 is another data migration of a store nothing has agreed to lose — a new spec, not a diff.',
      );
      assert.match(
        digest ?? '',
        /^sha256:[0-9a-f]{64}$/,
        `${rel}: ${name} is not digest-pinned ('${image}') — the shared pin is a DIGEST, not a floating tag.`,
      );
    }
  }
});

// The 18 image moved PGDATA to the version-specific `/var/lib/postgresql/18/docker` and declares its
// VOLUME at `/var/lib/postgresql`. A named volume left on the pre-18 `/var/lib/postgresql/data` path is
// NOT where 18 writes: the cluster lands in an anonymous volume and is silently lost on the next
// `down` — or, over a 16 data dir, the entrypoint refuses to start. keycloak and agent-db already
// mount the parent for exactly this reason. The pin and the mount are one change; asserted together.
test('both observability postgres services mount the 18 layout (/var/lib/postgresql), not the pre-18 /data path', () => {
  for (const rel of FILES) {
    const svc = load(rel)?.services ?? {};
    for (const name of ['langfuse-postgres', 'unleash-postgres']) {
      const mounts = (svc[name]?.volumes ?? []).map((v) => (typeof v === 'string' ? v.split(':')[1] : v?.target));
      assert.ok(
        mounts.includes('/var/lib/postgresql'),
        `${rel}: ${name} does not mount a volume at /var/lib/postgresql (mounts: ${JSON.stringify(mounts)}).\n` +
          '  postgres 18 keeps its cluster under /var/lib/postgresql/18/docker; without the parent mounted the ' +
          'data goes to an anonymous volume.',
      );
      assert.ok(
        !mounts.includes('/var/lib/postgresql/data'),
        `${rel}: ${name} still mounts the pre-18 /var/lib/postgresql/data path — postgres 18 does not write there.`,
      );
    }
  }
});
