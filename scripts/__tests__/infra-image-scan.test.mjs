// Unit tests for the pure logic of scripts/infra-image-scan.mjs (feature 035).
// Runs on any host (no Trivy needed) via `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateImages, normalizeTrivy } from '../infra-image-scan.mjs';

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

test('normalizeTrivy marks fixable High/Critical as blocking, unfixable + Medium/Low as non-blocking', () => {
  const json = {
    Results: [{
      Vulnerabilities: [
        { VulnerabilityID: 'CVE-1', PkgName: 'a', InstalledVersion: '1.0', FixedVersion: '1.1', Severity: 'HIGH' },       // fixable High → blocking
        { VulnerabilityID: 'CVE-2', PkgName: 'b', InstalledVersion: '2.0', Severity: 'CRITICAL' },                          // unfixable Critical → non-blocking
        { VulnerabilityID: 'CVE-3', PkgName: 'c', InstalledVersion: '3.0', FixedVersion: '3.1', Severity: 'MEDIUM' },       // fixable Medium → non-blocking
      ],
    }],
  };
  const out = normalizeTrivy(json, 'redis:7-alpine', [{ path: 'a.yaml', line: 1 }], SEV);
  assert.equal(out.length, 3);
  assert.equal(out[0].blocking, true);
  assert.equal(out[0].fixAvailable, true);
  assert.equal(out[1].blocking, false); // unfixable
  assert.equal(out[1].fixAvailable, false);
  assert.equal(out[2].blocking, false); // Medium
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
