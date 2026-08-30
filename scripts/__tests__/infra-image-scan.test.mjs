// Unit tests for the pure logic of scripts/infra-image-scan.mjs (feature 035).
// Runs on any host (no Trivy needed) via `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateImages, normalizeTrivy, buildProposedAllowlist } from '../infra-image-scan.mjs';
import { parse as parseYaml } from 'yaml';

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
