#!/usr/bin/env node
// build-devcontainer-image.mjs — feature 038 (full dev-container toolchain).
// Plan: specs/038-devcontainer-full-toolchain/plan.md · research D1/D2 · tasks T007.
//
// The OFFLINE / no-forge one-time fallback: builds the heavy toolchain image from
// .devcontainer/toolchain.Dockerfile and tags it `mcm-devcontainer` (= :latest), so the
// devcontainer.json `build.args` default `BASE_IMAGE=${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer}`
// resolves without setting any env or reaching the forge registry (SC-011).
//
// NOTE: the tag is COLON-FREE on purpose — the devcontainer ${localEnv:VAR:default} parser
// truncates a default at its first colon, so a `:local` default would silently become
// `mcm-devcontainer`. Keeping the built tag colon-free keeps the default and the build in sync.
//
// The FAST path is instead pulling the CI-published forge image and pointing
// MCM_DEVCONTAINER_IMAGE at its @sha256 digest — this script is only the local escape hatch.
//
// Usage:
//   node scripts/build-devcontainer-image.mjs               # docker build → mcm-devcontainer:local
//   node scripts/build-devcontainer-image.mjs --tag <ref>   # override the tag
//
// Exit codes: 0 ok · 1 docker build failed · 2 bad args / missing prereq.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = resolve(REPO_ROOT, '.devcontainer/toolchain.Dockerfile');
const DEFAULT_TAG = 'mcm-devcontainer'; // colon-free — see the ${localEnv} default-truncation note above

function parseArgs(argv) {
  let tag = DEFAULT_TAG;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') {
      tag = argv[++i];
      if (!tag) fail(2, '--tag requires a value');
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/build-devcontainer-image.mjs [--tag <ref>]');
      process.exit(0);
    } else {
      fail(2, `unknown argument: ${argv[i]}`);
    }
  }
  return { tag };
}

function fail(code, msg) {
  console.error(`build-devcontainer-image: ${msg}`);
  process.exit(code);
}

function main() {
  const { tag } = parseArgs(process.argv.slice(2));

  if (!existsSync(DOCKERFILE)) fail(2, `missing ${DOCKERFILE}`);

  // Prereq: docker on PATH.
  const dv = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (dv.status !== 0) fail(2, 'docker not found on PATH — install/start Docker Desktop');

  console.log(`build-devcontainer-image: building ${tag} from .devcontainer/toolchain.Dockerfile`);
  console.log('build-devcontainer-image: this is the SC-011 one-time cost (several minutes; Rust toolchain compiles).');

  // Build context is the repo root (the Dockerfile does not COPY anything from it, but the
  // build context must exist). `-f` points at the heavy toolchain Dockerfile.
  const build = spawnSync(
    'docker',
    ['build', '-f', DOCKERFILE, '-t', tag, REPO_ROOT],
    { stdio: 'inherit' },
  );
  if (build.status !== 0) fail(1, `docker build failed (exit ${build.status ?? 'signal'})`);

  console.log(`build-devcontainer-image: done — ${tag} ready.`);
  console.log('build-devcontainer-image: `devcontainer up` will now resolve BASE_IMAGE to this local image (no env needed).');
}

main();
