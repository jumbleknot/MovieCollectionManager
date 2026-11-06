// Feature 087 (FR-005, FR-010): every BFF container's healthcheck must probe a page AND an API route.
//
// WHY THIS EXISTS. During the SDK 58 spike every page answered 404 while the container reported
// healthy, because the healthcheck only asked an API route. Pages and API routes are served by the same
// process but come from different parts of the export, so one can fail while the other answers.
//
// The probes must be joined by `&&`. `wget api; wget page || exit 1` mentions both paths and still
// reports healthy when the API fails, so a text match on the two paths would not be enough.
//
// It fails when it finds no BFF service, so it cannot pass by reading the wrong file. The synthetic
// documents below are its lasting proof that it can fail.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILES = [
  'infrastructure-as-code/docker/bff/compose.yaml',
  'infrastructure-as-code/docker/bff/compose.prod.yaml',
];

/** Services running the BFF image. A proxy, cache or store has its own image and is left out. */
function bffServices(doc) {
  return Object.entries(doc?.services ?? {}).filter(([, service]) =>
    /(^|\/)mcm-bff(:|@)/.test(String(service?.image ?? '')),
  );
}

/** What is wrong with one service's healthcheck, or an empty list. */
function healthcheckProblems(name, service) {
  const test = service?.healthcheck?.test;
  if (test === undefined) return [`${name}: has no healthcheck`];
  const command = Array.isArray(test) ? test.join(' ') : String(test);
  const paths = [...command.matchAll(/https?:\/\/[^/\s"']+(\/[^\s"']*)/g)].map((m) => m[1]);
  const problems = [];
  if (!paths.some((p) => p.startsWith('/bff-api/'))) {
    problems.push(`${name}: healthcheck requests no /bff-api/ path: ${command}`);
  }
  if (!paths.some((p) => !p.startsWith('/bff-api/'))) {
    problems.push(`${name}: healthcheck requests no page path, so pages can fail while it reports healthy: ${command}`);
  }
  if (paths.length > 1 && !/^[^;|&]*(&&[^;|&]*)+(\|\|[^;|&]*)?$/.test(command)) {
    problems.push(`${name}: healthcheck probes must be joined by &&, or one can fail unnoticed: ${command}`);
  }
  return problems;
}

/** Every problem in one compose document. Finding no BFF service is itself a problem. */
function composeProblems(label, text) {
  const services = bffServices(parseYaml(text));
  if (services.length === 0) return [`${label}: no BFF service found, so nothing was checked`];
  return services.flatMap(([name, service]) => healthcheckProblems(`${label}: ${name}`, service));
}

const compose = (test, image = 'mcm-bff:latest') =>
  `services:\n  bff:\n    image: ${image}\n    healthcheck:\n      test: ${JSON.stringify(test)}\n`;
const API = 'wget -q --spider http://127.0.0.1:3000/bff-api/auth/init';
const PAGE = 'wget -q --spider http://127.0.0.1:3000/login';

describe('the guard can fail (FR-010)', () => {
  it('rejects an API-only probe, which is what the spike ran on', () => {
    const problems = composeProblems('synthetic', compose(['CMD-SHELL', `${API} || exit 1`]));
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /no page path/);
  });

  it('rejects a page-only probe', () => {
    const problems = composeProblems('synthetic', compose(['CMD-SHELL', `${PAGE} || exit 1`]));
    assert.match(problems.join('\n'), /no \/bff-api\/ path/);
  });

  it('rejects two probes not joined by &&, because the first result is thrown away', () => {
    const problems = composeProblems('synthetic', compose(['CMD-SHELL', `${API}; ${PAGE} || exit 1`]));
    assert.match(problems.join('\n'), /joined by &&/);
  });

  it('rejects a BFF service with no healthcheck', () => {
    const problems = composeProblems('synthetic', 'services:\n  bff:\n    image: mcm-bff:latest\n');
    assert.match(problems.join('\n'), /has no healthcheck/);
  });

  it('rejects a document with no BFF service, so it cannot pass on the wrong file', () => {
    const problems = composeProblems('synthetic', 'services:\n  cache:\n    image: redis:8\n');
    assert.match(problems.join('\n'), /no BFF service found/);
  });

  it('accepts the shape this feature requires, and recognises a digest-pinned image', () => {
    const good = ['CMD-SHELL', `${API} && ${PAGE} || exit 1`];
    assert.deepEqual(composeProblems('synthetic', compose(good)), []);
    const pinned = compose(good, '${REGISTRY_HOST:?set}/jumbleknot/mcm-bff@${MCM_BFF_DIGEST:?set}');
    assert.deepEqual(composeProblems('synthetic', pinned), []);
  });
});

describe('the real compose files', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file}: every BFF service probes a page and an API route`, () => {
      const problems = composeProblems(file, readFileSync(resolve(REPO_ROOT, file), 'utf8'));
      assert.deepEqual(problems, []);
    });
  }

  it('covers the three BFF services that exist today', () => {
    const names = COMPOSE_FILES.flatMap((file) =>
      bffServices(parseYaml(readFileSync(resolve(REPO_ROOT, file), 'utf8'))).map(([name]) => name),
    );
    assert.deepEqual(names.sort(), ['mcm-bff-service', 'mcm-bff-service-nonsecure', 'mcm-bff-service-secure']);
  });
});
