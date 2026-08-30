// Unit tests for the pure logic of scripts/infra-image-scan.mjs (feature 035).
// Runs on any host (no Trivy needed) via `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateImages, normalizeTrivy, buildProposedAllowlist } from '../infra-image-scan.mjs';
import { parse as parseYaml } from 'yaml';
import { readFileSync, globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEV = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', UNKNOWN: 'Low' };

test('enumerateImages excludes jumbleknot/* and built-image local tags', () => {
  const files = [{
    path: 'infrastructure-as-code/docker/bff/compose.prod.yaml',
    content: [
      '    image: "${REGISTRY_HOST}/jumbleknot/mcm-bff@${MCM_BFF_DIGEST}"',
      '    image: mcm-bff:latest',
      '    image: redis:8.6.2-alpine3.23',
    ].join('\n'),
  }];
  const refs = enumerateImages(files).map((i) => i.ref);
  assert.deepEqual(refs, ['redis:8.6.2-alpine3.23']);
});

test('enumerateImages excludes ${..}-interpolated refs', () => {
  const files = [{ path: 'a.yaml', content: '    image: ${REGISTRY_HOST}/jumbleknot/mc-service@${MC_SERVICE_DIGEST}\n    image: postgres:18.3-alpine3.23' }];
  const refs = enumerateImages(files).map((i) => i.ref);
  assert.deepEqual(refs, ['postgres:18.3-alpine3.23']);
});

test('enumerateImages dedups across files and records all locations', () => {
  const files = [
    { path: 'keycloak/compose.yaml', content: '    image: postgres:18.3-alpine3.23' },
    { path: 'agents/compose.prod.yaml', content: 'x\n    image: postgres:18.3-alpine3.23' },
  ];
  const imgs = enumerateImages(files);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].ref, 'postgres:18.3-alpine3.23');
  assert.deepEqual(imgs[0].locations, [
    { path: 'keycloak/compose.yaml', line: 1 },
    { path: 'agents/compose.prod.yaml', line: 2 },
  ]);
});

test('enumerateImages flags floating (:latest / non-versioned) tags', () => {
  const files = [{ path: 'a.yaml', content: '    image: grafana/otel-lgtm:latest\n    image: quay.io/keycloak/keycloak:26.5.5' }];
  const imgs = enumerateImages(files);
  const otel = imgs.find((i) => i.ref.startsWith('grafana'));
  const kc = imgs.find((i) => i.ref.startsWith('quay'));
  assert.equal(otel.floatingTag, true);
  assert.equal(kc.floatingTag, false);
});

test('enumerateImages handles quotes and registry-prefixed refs', () => {
  const files = [{ path: 'a.yaml', content: "    image: 'quay.io/keycloak/keycloak:26.5.5'\n    image: \"mongodb/mongodb-community-server:8.0.8-ubi9\"" }];
  const refs = enumerateImages(files).map((i) => i.ref);
  assert.deepEqual(refs, ['mongodb/mongodb-community-server:8.0.8-ubi9', 'quay.io/keycloak/keycloak:26.5.5']);
});

test('enumerated set is disjoint from the six cd-deploy built images (SC-002 / T018)', () => {
  const built = ['mcm-bff', 'mc-service', 'agent-gateway', 'movie-mcp', 'web-api-mcp', 'spreadsheet-mcp'];
  const files = [{ path: 'a.yaml', content: built.map((n) => `    image: ${n}:latest`).join('\n') + '\n    image: redis:7-alpine' }];
  const refs = enumerateImages(files).map((i) => i.ref);
  for (const b of built) assert.ok(!refs.some((r) => r.startsWith(b + ':')), `${b} must be excluded`);
  assert.deepEqual(refs, ['redis:7-alpine']);
});

test('normalizeTrivy blocks ONLY fixable Critical (matches cd-deploy); fixable High + unfixable + Medium are non-blocking', () => {
  const json = {
    Results: [{
      Vulnerabilities: [
        { VulnerabilityID: 'CVE-0', PkgName: 'z', InstalledVersion: '0.9', FixedVersion: '1.0', Severity: 'CRITICAL' },    // fixable Critical → blocking
        { VulnerabilityID: 'CVE-1', PkgName: 'a', InstalledVersion: '1.0', FixedVersion: '1.1', Severity: 'HIGH' },        // fixable High → NON-blocking (report-only)
        { VulnerabilityID: 'CVE-2', PkgName: 'b', InstalledVersion: '2.0', Severity: 'CRITICAL' },                          // unfixable Critical → non-blocking
        { VulnerabilityID: 'CVE-3', PkgName: 'c', InstalledVersion: '3.0', FixedVersion: '3.1', Severity: 'MEDIUM' },       // fixable Medium → non-blocking
      ],
    }],
  };
  const out = normalizeTrivy(json, 'redis:7-alpine', [{ path: 'a.yaml', line: 1 }], SEV);
  assert.equal(out.length, 4);
  assert.equal(out[0].blocking, true);  // fixable Critical
  assert.equal(out[0].fixAvailable, true);
  assert.equal(out[1].blocking, false); // fixable High — report-only
  assert.equal(out[1].fixAvailable, true);
  assert.equal(out[2].blocking, false); // unfixable Critical
  assert.equal(out[3].blocking, false); // Medium
  assert.equal(out[0].location[0], 'a.yaml:1');
});

test('normalizeTrivy throws on an unmapped severity (no silent default)', () => {
  const json = { Results: [{ Vulnerabilities: [{ VulnerabilityID: 'CVE-X', PkgName: 'p', Severity: 'BOGUS' }] }] };
  assert.throws(() => normalizeTrivy(json, 'img:1', [{ path: 'a', line: 1 }], SEV), /unmapped Trivy severity/);
});

test('normalizeTrivy tolerates an image with no vulnerabilities', () => {
  assert.deepEqual(normalizeTrivy({ Results: [] }, 'clean:1', [{ path: 'a', line: 1 }], SEV), []);
  assert.deepEqual(normalizeTrivy({}, 'clean:1', [{ path: 'a', line: 1 }], SEV), []);
});

test('buildProposedAllowlist emits only blocking findings as valid, gate-matchable entries', () => {
  const findings = [
    { image: 'quay.io/keycloak/keycloak:26.5.5', id: 'CVE-1', pkg: 'a', fixedVersion: '1.1', severity: 'High', blocking: true },
    { image: 'redis:7-alpine', id: 'CVE-2', pkg: 'b', fixedVersion: '', severity: 'Critical', blocking: false }, // unfixable → excluded
  ];
  const parsed = parseYaml(buildProposedAllowlist(findings));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'CVE-1');
  assert.equal(parsed[0].addedBy, 'seed');
  assert.ok(parsed[0].justification.length > 0);
  // The proposed `image` is an escaped regex that matches the real ref.
  assert.ok(new RegExp(parsed[0].image).test('quay.io/keycloak/keycloak:26.5.5'));
});

// ---------------------------------------------------------------------------------------------
// THE BUG (2026-08-30, item #297). `docker:pinDigests` rewrote every ref to `tag@sha256:...`, and
// the tag parser was `ref.split(':').pop()` — which on a digest-pinned ref returns the DIGEST HEX,
// not the tag. `floatingTag` then reduced to "does this image's digest happen to start with a
// digit", a coin flip per image.
//
// Measured on main immediately after PR #289 landed: of the eight `latest`-tagged infra images,
// the four whose digests begin with a letter (mailpit c969…, otel-lgtm d6b2…, minio/mc a7fe…,
// opa:latest-debug f6aa…) were reported FLOATING, and the four beginning with a digit
// (opa:latest 39da…, minio/minio 14ce…, unleash 16f3…, curl 7c12…) were reported version-pinned.
// A `latest` image reported as pinned is the exact opposite of what this flag exists to say, and
// item #297's acceptance criterion is written against this output.

test('(fd) THE BUG: a digest-pinned :latest ref is still FLOATING — the digest is not the tag', () => {
  const files = [{ path: 'c.yaml', content: [
    '    image: axllent/mailpit:latest@sha256:c96991d9bef73594c246d89ca81411d4e916f03e76a7d2d72fa2ab5dd3c9ce24',
    '    image: openpolicyagent/opa:latest@sha256:39daf255ae7f25d81103f03a0c18308a50b7b5bb67907bed6166f70e24a970ff',
    '    image: unleashorg/unleash-server:latest@sha256:16f3ffb914880e7d0f23629a0c1b77aebea3aa619b0305f76eb50b3fb75998a9',
  ].join('\n') }];
  for (const img of enumerateImages(files)) {
    assert.equal(img.floatingTag, true, `${img.ref} is :latest but was reported as version-pinned`);
  }
});

test('(fd2) a digest-pinned VERSION ref is not floating — the fix must not flag everything', () => {
  const files = [{ path: 'c.yaml', content: [
    '    image: caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648',
    '    image: hashicorp/vault:1.18@sha256:750bb37c1638fa194ab37053a81618c61bb0491ddec6fccac87c07a8e6cd8166',
  ].join('\n') }];
  for (const img of enumerateImages(files)) {
    assert.equal(img.floatingTag, false, `${img.ref} is version-pinned but was reported floating`);
  }
});

test('(fd3) a v-prefixed semver tag is a VERSION, not a floating tag', () => {
  // Directly load-bearing for item #297: mailpit publishes `v1.9.x`, so the migration this flag is
  // meant to verify would otherwise land and still be reported as floating.
  const files = [{ path: 'c.yaml', content: '    image: axllent/mailpit:v1.9.9@sha256:c96991d9bef7' }];
  assert.equal(enumerateImages(files)[0].floatingTag, false);
});

test('(fd4) a digest-only ref with no tag is floating, and a registry PORT is not a tag', () => {
  const files = [{ path: 'c.yaml', content: [
    '    image: minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727',
    '    image: registry.example.com:5000/some/app',
  ].join('\n') }];
  const imgs = enumerateImages(files);
  assert.equal(imgs.find((i) => i.ref.startsWith('minio/mc')).floatingTag, true, 'no tag == latest == floating');
  assert.equal(imgs.find((i) => i.ref.includes(':5000')).floatingTag, true, 'a registry port was parsed as the tag');
});

// ---------------------------------------------------------------------------------------------
// THE DECLARED-EXCEPTION COUNT — feature 063 / item #297, contract C5 / SC-006.
//
// After the eight floating references are version-pinned, two remain floating BY DESIGN:
// `minio/minio` and `minio/mc` publish `RELEASE.<iso-date>` tags, which `isFloatingTag` cannot
// order and therefore — correctly — refuses to call version-pinned.
//
// THE TEMPTING FIX IS THE ONE THE SPEC FORBIDS. Widening `isFloatingTag` to recognise `RELEASE.*`
// would make the report read clean, and would couple a general-purpose classifier to one vendor's
// tag convention while teaching it to vouch for an ordering it does not have. The classifier's job
// is to be suspicious of tags it cannot order, and these genuinely are such tags (research R4).
//
// So the exceptions are DECLARED rather than hidden, and the declaration is machine-readable: the
// images carrying the date-tagged regex-versioning rule in renovate.json ARE the declared set. That
// makes this assertion two-directional without a second list to drift out of step:
//
//   MORE floating than declared  -> a reference regressed to a floating tag, or a new one arrived
//   FEWER (and 0 in particular)  -> the classifier was widened to quieten the output
//
// A count assertion alone would accept the wrong two images, so the SET is compared as well.

test('(063) the floating references are EXACTLY the declared exceptions — not fewer, not more', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

  // The declaration: every image under a `regex:^RELEASE\.` versioning rule. Read from renovate.json
  // rather than restated here, so the declaration and the exception cannot disagree.
  const renovate = JSON.parse(readFileSync(resolve(repoRoot, 'renovate.json'), 'utf8'));
  const declared = new Set(
    (renovate.packageRules ?? [])
      .filter((r) => typeof r.versioning === 'string' && r.versioning.startsWith('regex:^RELEASE'))
      .flatMap((r) => r.matchPackageNames ?? []),
  );

  // The reality: the same enumeration the scanner and the CI gate run, over the real infra tree.
  const files = globSync('infrastructure-as-code/**/*.{yaml,yml}', { cwd: repoRoot }).map((p) => ({
    path: p,
    content: readFileSync(resolve(repoRoot, p), 'utf8'),
  }));
  const floating = enumerateImages(files).filter((i) => i.floatingTag);
  // repository = the ref with `@<digest>` and any tag removed (the grammar isFloatingTag uses).
  const floatingRepos = new Set(floating.map((i) => {
    const withoutDigest = i.ref.split('@')[0];
    const lastColon = withoutDigest.lastIndexOf(':');
    return lastColon > withoutDigest.lastIndexOf('/') ? withoutDigest.slice(0, lastColon) : withoutDigest;
  }));

  assert.ok(
    declared.size > 0,
    'renovate.json declares no date-tagged exceptions at all. SC-006 measures the floating count\n' +
      '  against a DECLARED list; with an empty list the count is being compared to nothing.',
  );

  assert.deepEqual(
    [...floatingRepos].sort(),
    [...declared].sort(),
    'The floating references are not the declared exceptions.\n' +
      `  floating in infrastructure-as-code/**: ${JSON.stringify(floating.map((i) => i.ref))}\n` +
      `  declared in renovate.json:            ${JSON.stringify([...declared].sort())}\n` +
      '  MORE than declared means a reference is floating without a recorded reason (FR-001).\n' +
      '  FEWER — and a count of 0 especially — means isFloatingTag was widened to hide the\n' +
      '  exceptions rather than declare them, which is the move research R4 rejected.',
  );

  assert.equal(
    floating.length,
    2,
    `expected exactly 2 floating references (minio/minio, minio/mc), found ${floating.length}: ` +
      JSON.stringify(floating.map((i) => i.ref)),
  );
});

// ---------------------------------------------------------------------------------------------
// SUPPRESSIONS MUST BE DISCHARGEABLE BY AN UPGRADE — feature 063 / item #297, FR-007, US2.
//
// `check-infra-image-findings.mjs` matches an allowlist entry's `image` as an UNANCHORED regex
// against the full scanned reference. That one property decides whether a suppression can ever end:
//
//   `hashicorp/vault:1\.18`  still matches `hashicorp/vault:1.18@sha256:…` (a digest appended to the
//                            ref does not break the key) but STOPS matching `1.21`. When PR #289
//                            bumped vault, five Criticals surfaced — a dischargeable key doing its
//                            job, loudly, which is the behaviour wanted.
//   `minio/minio`            matches EVERY tag of that image that will ever exist. It cannot stop
//                            matching, so it suppresses the Critical it was written for and every
//                            future one in the same image, in silence and for ever.
//
// The second shape is the defect. A suppression keyed to a floating reference is not an accepted
// risk with a review date, it is a permanent hole that no upgrade can close.
//
// TWO DIRECTIONS ARE ASSERTED, because each alone is satisfiable by a broken key:
//   (1) the entry STILL MATCHES the reference in the compose files today — a re-key that matches
//       nothing suppresses nothing, and the gate reports it only as an `unmatched` line;
//   (2) the entry STOPS MATCHING a later version of the same image — which is what discharges it.

/** An entry may fail (2) only by SAYING SO. A declaration, not a way around the assertion. */
const NOT_KEYABLE = 'NOT VERSION-KEYABLE:';

test('(063) every allowlist entry for a formerly-floating image can be discharged by an upgrade', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const allowlist = parseYaml(readFileSync(resolve(repoRoot, 'security/infra-images/allowlist.yaml'), 'utf8'));

  // The reference as the SCANNER reports it — read from the compose files, so this cannot drift.
  const files = globSync('infrastructure-as-code/**/*.{yaml,yml}', { cwd: repoRoot }).map((p) => ({
    path: p, content: readFileSync(resolve(repoRoot, p), 'utf8'),
  }));
  const refFor = (repository) => enumerateImages(files).map((i) => i.ref)
    .find((r) => r.startsWith(`${repository}:`) || r.startsWith(`${repository}@`));

  // A plausible NEXT version of each image, with a different digest — the upgrade that must
  // discharge the entry. Synthetic on purpose: what upstream publishes next is Renovate's network
  // step, and a test that guessed it would be asserting its own fixture rather than the key.
  const NEXT = {
    'grafana/otel-lgtm': 'grafana/otel-lgtm:0.33.0@sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'minio/minio': 'minio/minio:RELEASE.2026-01-15T10-00-00Z@sha256:2222222222222222222222222222222222222222222222222222222222222222',
    'minio/mc': 'minio/mc:RELEASE.2026-01-15T10-00-00Z@sha256:3333333333333333333333333333333333333333333333333333333333333333',
  };

  let checked = 0;
  for (const [repository, nextRef] of Object.entries(NEXT)) {
    const currentRef = refFor(repository);
    assert.ok(currentRef, `${repository} is not referenced in infrastructure-as-code/** any more — is this list stale?`);

    for (const entry of allowlist) {
      // Only the entries written FOR this image. Keyed on the repository appearing in the entry's
      // own pattern, so an unrelated entry that happens to match nothing is not dragged in.
      if (!entry.image.includes(repository)) continue;
      checked += 1;
      const re = new RegExp(entry.image);

      assert.ok(
        re.test(currentRef),
        `allowlist key ${JSON.stringify(entry.image)} (${entry.id}) NO LONGER MATCHES ${currentRef}.\n` +
          '  It suppresses nothing, so the finding it was written for is now un-allowlisted and the\n' +
          '  gate blocks — while the gate reports the entry only as an UNMATCHED line, which is easy\n' +
          '  to read as tidy-up rather than as the cause.',
      );

      if (entry.justification.includes(NOT_KEYABLE)) continue; // declared, with its reason stated
      assert.ok(
        !re.test(nextRef),
        `allowlist key ${JSON.stringify(entry.image)} (${entry.id}) STILL MATCHES ${nextRef}.\n` +
          `  It is keyed to a floating reference, so no upgrade can ever discharge it: it suppresses\n` +
          '  the advisory it was written for AND every future one in the same image, silently and\n' +
          `  permanently (FR-007). Key it to the version, or record why it cannot be with a\n` +
          `  justification beginning "${NOT_KEYABLE}".`,
      );
    }
  }

  assert.ok(checked > 0, 'no allowlist entries were examined — the repository names above are stale, so this test asserts nothing.');
});
