#!/usr/bin/env node
// Item #1127 — the (version, sha256) pins in the CI installers, verified against their publishers.
//
// FIVE INSTALLERS pin a downloaded binary by version AND sha256: Trivy, rustup-init, cargo-audit and,
// since item #1147, Docker Compose and Maestro.
// Renovate moves the `*_VERSION` alone (its managers match nothing else), and the `*_SHA256_FOR` beside
// the checksum names the version it was taken for — so a bump arrives RED until the checksum follows.
// Before this script, following meant a human reading a hash off a release page and pasting it.
//
//   --check   (CI, guardrails' renovate-config job) for every pin: `*_SHA256_FOR` equals the version,
//             and each pinned sha256 equals what the PUBLISHER states for that version. Cheap: it
//             reads the publisher's checksum, never the artifact. Exit 1 names every disagreement.
//   --write   for every pin whose `*_SHA256_FOR` is stale (or every pin, with --all): DOWNLOAD the
//             artifact, hash it, REQUIRE the hash to equal the publisher's stated one, then rewrite
//             the checksum lines and `*_SHA256_FOR`. A download that disagrees with its publisher
//             writes nothing and exits 1 — the hash is never taken on the download's word alone.
//
// Publishers: Trivy's `trivy_<v>_checksums.txt`; rustup's `rustup-init.sha256` beside the binary;
// cargo-audit's release-asset `digest` from the GitHub releases API; Compose's `checksums.txt` and
// Maestro's `checksums_sha256.txt`, each beside its release assets.
//
// Node built-ins only: guardrails runs this before any `pnpm install`.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgvError, partitionArgs, wantsHelp, dieOnArgvError } from './lib/argv-contract.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TRIVY = 'https://github.com/aquasecurity/trivy/releases/download';
const RUSTUP = 'https://static.rust-lang.org/rustup/archive';
const RUSTSEC = 'https://github.com/rustsec/rustsec/releases/download';
const COMPOSE = 'https://github.com/docker/compose/releases/download';
const MAESTRO = 'https://github.com/mobile-dev-inc/maestro/releases/download';

/**
 * Every pinned (version, sha256) pair. `assets(version)` lists each checksum line with the URL of the
 * artifact it covers; `published(version, io)` returns { [var]: sha256 } as the publisher states it.
 */
export const PINS = [
  {
    name: 'trivy',
    file: 'scripts/ci-install-trivy.sh',
    version: 'TRIVY_VERSION',
    shaFor: 'TRIVY_SHA256_FOR',
    assets: (v) =>
      [
        ['TRIVY_SHA256_LINUX_64BIT', 'Linux-64bit'],
        ['TRIVY_SHA256_LINUX_ARM64', 'Linux-ARM64'],
      ].map(([variable, platform]) => ({
        variable,
        name: `trivy_${v.slice(1)}_${platform}.tar.gz`,
        url: `${TRIVY}/${v}/trivy_${v.slice(1)}_${platform}.tar.gz`,
      })),
    async published(v, io) {
      const text = await io.text(`${TRIVY}/${v}/trivy_${v.slice(1)}_checksums.txt`);
      const out = {};
      for (const a of this.assets(v)) out[a.variable] = checksumFileEntry(text, a.name);
      return out;
    },
  },
  {
    name: 'rustup-init',
    file: 'scripts/ci-install-rustup.sh',
    version: 'RUSTUP_VERSION',
    shaFor: 'RUSTUP_INIT_SHA256_FOR',
    assets: (v) => [
      { variable: 'RUSTUP_INIT_SHA256', name: 'rustup-init', url: `${RUSTUP}/${v}/x86_64-unknown-linux-gnu/rustup-init` },
    ],
    async published(v, io) {
      const text = await io.text(`${RUSTUP}/${v}/x86_64-unknown-linux-gnu/rustup-init.sha256`);
      return { RUSTUP_INIT_SHA256: firstSha(text, 'rustup-init.sha256') };
    },
  },
  {
    name: 'cargo-audit',
    file: 'scripts/ci-install-rust-audit.sh',
    version: 'CARGO_AUDIT_VERSION',
    shaFor: 'CARGO_AUDIT_SHA256_FOR',
    assets: (v) => {
      const asset = `cargo-audit-x86_64-unknown-linux-musl-v${v}.tgz`;
      return [{ variable: 'CARGO_AUDIT_SHA256', name: asset, url: `${RUSTSEC}/cargo-audit%2Fv${v}/${asset}` }];
    },
    async published(v, io) {
      const rel = await io.json(`https://api.github.com/repos/rustsec/rustsec/releases/tags/cargo-audit%2Fv${v}`);
      const [{ name }] = this.assets(v);
      const asset = (rel?.assets ?? []).find((a) => a?.name === name);
      const digest = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest ?? '')?.[1];
      if (!digest) throw new Error(`the cargo-audit v${v} release states no sha256 digest for ${name}`);
      return { CARGO_AUDIT_SHA256: digest };
    },
  },
  {
    name: 'docker-compose',
    file: 'scripts/ci-install-compose.sh',
    version: 'COMPOSE_VERSION',
    shaFor: 'COMPOSE_SHA256_FOR',
    assets: (v) =>
      [
        ['COMPOSE_SHA256_LINUX_X86_64', 'linux-x86_64'],
        ['COMPOSE_SHA256_LINUX_AARCH64', 'linux-aarch64'],
      ].map(([variable, platform]) => ({
        variable,
        name: `docker-compose-${platform}`,
        url: `${COMPOSE}/${v}/docker-compose-${platform}`,
      })),
    async published(v, io) {
      const text = await io.text(`${COMPOSE}/${v}/checksums.txt`);
      const out = {};
      for (const a of this.assets(v)) out[a.variable] = checksumFileEntry(text, a.name);
      return out;
    },
  },
  {
    name: 'maestro',
    file: 'scripts/ci-install-maestro.sh',
    version: 'MAESTRO_VERSION',
    shaFor: 'MAESTRO_SHA256_FOR',
    assets: (v) => [{ variable: 'MAESTRO_SHA256', name: 'maestro.zip', url: `${MAESTRO}/cli-${v}/maestro.zip` }],
    async published(v, io) {
      const text = await io.text(`${MAESTRO}/cli-${v}/checksums_sha256.txt`);
      return { MAESTRO_SHA256: checksumFileEntry(text, 'maestro.zip') };
    },
  },
];

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────

/** The value of `NAME=value` on a line of its own, or null. */
export function readVar(text, name) {
  return new RegExp(`^${name}=(\\S+)$`, 'm').exec(text)?.[1] ?? null;
}

/** Rewrite `NAME=…` (which must exist exactly once) to `NAME=value`. */
export function setVar(text, name, value) {
  const re = new RegExp(`^${name}=\\S+$`, 'gm');
  const hits = text.match(re)?.length ?? 0;
  if (hits !== 1) throw new Error(`expected exactly one ${name}= line, found ${hits}`);
  return text.replace(re, `${name}=${value}`);
}

/** The sha256 a `sha256sum`-format file states for exactly one entry named `file`. */
export function checksumFileEntry(text, file) {
  const hits = text
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter(([, f]) => f === file || f === `*${file}`);
  if (hits.length !== 1 || !/^[0-9a-f]{64}$/.test(hits[0][0])) {
    throw new Error(`the publisher's checksums state ${hits.length === 1 ? 'no valid sha256' : `${hits.length} entries`} for ${file}`);
  }
  return hits[0][0];
}

function firstSha(text, what) {
  const sha = /^([0-9a-f]{64})\b/.exec(text.trim())?.[1];
  if (!sha) throw new Error(`${what} carries no sha256`);
  return sha;
}

/** The pin as committed: { version, shaFor, hashes: { [var]: sha256|null } }. */
export function readPin(pin, text) {
  const version = readVar(text, pin.version);
  if (!version) throw new Error(`${pin.file}: no ${pin.version}= line`);
  const hashes = {};
  for (const a of pin.assets(version)) hashes[a.variable] = readVar(text, a.variable);
  return { version, shaFor: readVar(text, pin.shaFor), hashes };
}

/**
 * --check for one pin. Returns a list of problems (empty = verified).
 * @param {{text: (url: string) => Promise<string>, json: (url: string) => Promise<any>}} io
 */
export async function checkPin(pin, text, io) {
  const cur = readPin(pin, text);
  const problems = [];
  if (cur.shaFor !== cur.version) {
    problems.push(`${pin.file}: ${pin.version} is ${cur.version} but its checksums were taken for ${cur.shaFor} — run: node scripts/refresh-pinned-sha256.mjs --write`);
    return problems; // comparing the old checksums with the new version's publisher would only repeat this
  }
  const stated = await pin.published(cur.version, io);
  for (const [variable, sha] of Object.entries(cur.hashes)) {
    if (sha !== stated[variable]) {
      problems.push(`${pin.file}: ${variable} is ${sha ?? '<missing>'} but the publisher states ${stated[variable]} for ${pin.name} ${cur.version}`);
    }
  }
  return problems;
}

/**
 * --write for one pin. Returns the new file text, or null when nothing needed refreshing.
 * @param {{text: Function, json: Function, bytes: (url: string) => Promise<Uint8Array>}} io
 */
export async function refreshPin(pin, text, io, { all = false } = {}) {
  const cur = readPin(pin, text);
  if (!all && cur.shaFor === cur.version) return null;
  const stated = await pin.published(cur.version, io);
  let out = text;
  for (const a of pin.assets(cur.version)) {
    const got = createHash('sha256').update(await io.bytes(a.url)).digest('hex');
    if (got !== stated[a.variable]) {
      throw new Error(`${pin.name} ${cur.version}: downloaded ${a.name} hashes to ${got}, but the publisher states ${stated[a.variable]} — nothing written`);
    }
    out = setVar(out, a.variable, got);
  }
  return setVar(out, pin.shaFor, cur.version);
}

// ── The I/O shell ────────────────────────────────────────────────────────────────────────────────

async function get(url) {
  const headers = { 'User-Agent': 'refresh-pinned-sha256' };
  if (url.startsWith('https://api.github.com/') && process.env.GITHUB_COM_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_COM_TOKEN}`;
  }
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res;
}

export const NET_IO = {
  text: async (url) => (await get(url)).text(),
  json: async (url) => (await get(url)).json(),
  bytes: async (url) => new Uint8Array(await (await get(url)).arrayBuffer()),
};

async function main(command, { all }) {
  let failed = 0;
  for (const pin of PINS) {
    const path = resolve(REPO_ROOT, pin.file);
    const text = readFileSync(path, 'utf8');
    try {
      if (command === 'check') {
        const problems = await checkPin(pin, text, NET_IO);
        for (const p of problems) console.error(`✗ ${p}`);
        if (problems.length) failed++;
        else console.log(`✓ ${pin.name} ${readPin(pin, text).version}: every pinned sha256 matches its publisher`);
      } else {
        const next = await refreshPin(pin, text, NET_IO, { all });
        if (next === null) console.log(`= ${pin.name}: checksums already taken for ${readPin(pin, text).version}`);
        else if (next === text) console.log(`= ${pin.name}: unchanged`);
        else {
          writeFileSync(path, next);
          console.log(`✎ ${pin.name} ${readPin(pin, next).version}: checksums refreshed (downloaded, hashed, matched the publisher)`);
        }
      }
    } catch (err) {
      failed++;
      console.error(`✗ ${pin.name}: ${err.message}`);
    }
  }
  return failed ? 1 : 0;
}

// ── The argument contract (item #500) ────────────────────────────────────────────────────────────

export const ACCEPTED_FLAGS = ['--check', '--write', '--all', '--help', '-h'];

export const USAGE = `refresh-pinned-sha256.mjs — the CI installers' (version, sha256) pins vs their publishers (item #1127).

  node scripts/refresh-pinned-sha256.mjs --check         verify every pinned sha256 against its publisher (CI)
  node scripts/refresh-pinned-sha256.mjs --write         refresh the checksums of every pin whose *_SHA256_FOR is stale
  node scripts/refresh-pinned-sha256.mjs --write --all   refresh every pin, stale or not
  node scripts/refresh-pinned-sha256.mjs --help          this text

Exactly one of --check / --write is required: a bare invocation does nothing and says so.`;

/** @returns {{command: 'help'|'check'|'write', all: boolean}} @throws {ArgvError} */
export function resolveCommand(argv = []) {
  const args = (argv ?? []).filter((a) => a !== '');
  if (wantsHelp(args)) return { command: 'help', all: false };
  const { flags } = partitionArgs(args, { accepted: ACCEPTED_FLAGS, maxPositionals: 0, usage: USAGE });
  const check = flags.has('--check');
  const write = flags.has('--write');
  if (check === write) {
    throw new ArgvError(`exactly one of --check / --write is required\n\n${USAGE}`);
  }
  if (flags.has('--all') && !write) {
    throw new ArgvError(`--all applies to --write only\n\n${USAGE}`);
  }
  return { command: check ? 'check' : 'write', all: flags.has('--all') };
}

if (isMain(import.meta.url)) {
  let cmd;
  try {
    cmd = resolveCommand(process.argv.slice(2));
  } catch (err) {
    dieOnArgvError(err);
  }
  if (cmd.command === 'help') console.log(USAGE);
  else {
    main(cmd.command, cmd)
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        console.error(`[refresh-pinned-sha256] FAILED: ${err.message}`);
        process.exitCode = 1;
      });
  }
}
