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
// VOLUME at `/var/lib/postgresql`. MEASURED 2026-10-20 on 18-alpine@sha256:77f58511: a mount left on the
// pre-18 `/var/lib/postgresql/data` path makes the entrypoint exit 1 — even when that volume is EMPTY
// ("there appears to be PostgreSQL data in: /var/lib/postgresql/data (unused mount/volume)") — and leaves
// an anonymous volume behind. keycloak and agent-db already mount the parent for exactly this reason.
// The pin and the mount are one change; asserted together.
test('both observability postgres services mount the 18 layout (/var/lib/postgresql), not the pre-18 /data path', () => {
  for (const rel of FILES) {
    const svc = load(rel)?.services ?? {};
    for (const name of ['langfuse-postgres', 'unleash-postgres']) {
      const mounts = (svc[name]?.volumes ?? []).map((v) => (typeof v === 'string' ? v.split(':')[1] : v?.target));
      assert.ok(
        mounts.includes('/var/lib/postgresql'),
        `${rel}: ${name} does not mount a volume at /var/lib/postgresql (mounts: ${JSON.stringify(mounts)}).\n` +
          '  postgres 18 keeps its cluster under /var/lib/postgresql/18/docker; without the parent mounted the ' +
          'cluster is not on the named volume.',
      );
      assert.ok(
        !mounts.includes('/var/lib/postgresql/data'),
        `${rel}: ${name} still mounts the pre-18 /var/lib/postgresql/data path — the postgres 18 entrypoint exits 1 on it.`,
      );
    }
  }
});

// The 18 cluster must NOT be pointed at the volume that held the 16 one. MEASURED 2026-10-20 (spec 081
// US8b rehearsal, on a copy of a 16 volume): postgres:18 REFUSES to start over a 16 data dir in BOTH
// layouts — mounted at the 18 parent ("there appears to be PostgreSQL data in: /var/lib/postgresql")
// and at the old /data path — exit 1, which `restart: unless-stopped` turns into a crash loop. In prod a
// merge IS a deploy (Komodo), so reusing the volume name would take Unleash and Langfuse down the moment
// this file lands. A NEW external volume instead fails the deploy up front ("external volume ... not
// found") with the 16 containers still running, until the operator pre-creates it and restores the
// Unleash dump into it. The 16 volumes stay untouched as the rollback (the agent-audit-opensearch-v3-data
// precedent, feature 071).
const PRE_18_VOLUME = {
  'langfuse-postgres': 'observability-langfuse-postgres-data',
  'unleash-postgres': 'observability-unleash-postgres-data',
};
test('the 18 clusters live on NEW volumes — never the volume that holds the 16 data (rollback kept intact)', () => {
  for (const rel of FILES) {
    const doc = load(rel) ?? {};
    for (const [name, pre18] of Object.entries(PRE_18_VOLUME)) {
      const mount = (doc.services?.[name]?.volumes ?? [])
        .map((v) => (typeof v === 'string' ? v.split(':') : [v?.source, v?.target]))
        .find(([, target]) => target === '/var/lib/postgresql');
      assert.ok(mount, `${rel}: ${name} has no /var/lib/postgresql mount (see the layout test)`);
      const key = mount[0];
      const resolved = doc.volumes?.[key]?.name ?? key;
      assert.notEqual(
        resolved,
        pre18,
        `${rel}: ${name} mounts '${resolved}', the volume holding the postgres 16 cluster.\n` +
          '  postgres 18 refuses to start on a 16 data dir (exit 1 -> crash loop; a merge is a prod deploy), and ' +
          'the 16 volume is the rollback. Give 18 its own volume and restore the Unleash dump into it.',
      );
      assert.match(resolved, /-v18-data$/, `${rel}: ${name} volume '${resolved}' does not carry the -v18 marker`);
    }
  }
});
