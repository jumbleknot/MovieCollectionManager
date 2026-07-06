#!/usr/bin/env node
// Prod↔CI/dev host-port collision gate (feature 029).
//
// Why this exists: the prod stacks and the CI runner share ONE homelab host with two rootless Docker
// daemons publishing into the SAME host port space. Feature 028 changed prod Keycloak's admin bind to
// 0.0.0.0:8099, which (binding all interfaces incl. loopback) collided with the CI app-e2e Keycloak's
// 127.0.0.1:8099 → prod keycloak couldn't bind on redeploy → crash-loop → prod-auth outage (2026-07-06).
//
// The durable fix moves prod admin ports into a prod-reserved range (19000–19099) disjoint from every
// CI/dev-published host port. This gate makes that disjointness a REQUIRED, self-enforcing property: a
// future prod OR CI service that publishes an overlapping host port fails the check. A prod bind is on
// 0.0.0.0, so it collides with a CI bind on the SAME PORT regardless of the CI bind's host_ip — hence
// the comparison is over host PORT NUMBERS (conservative; host_ip ignored).
//
// PROD files:   infrastructure-as-code/docker/**/compose.prod.yaml
// CI/DEV files: every other tracked compose file (compose.yaml / compose.ci.yaml / compose.agent-e2e.yaml
//               / stacks/*.compose.yaml). Only FIXED host ports count (a bare/random-host publish or a
//               ${VAR}-host port can't deterministically collide → skipped).
//
// Usage:
//   node scripts/check-prod-ci-port-collision.mjs            # scan; exit 0 clean / 1 collision
//   node scripts/check-prod-ci-port-collision.mjs --selftest # prove detection; exit 0/1
//
// Exit codes: 0 clean / selftest passed · 1 collision / selftest broken · 2 bad args / unparseable.

import { readFileSync, globSync } from 'node:fs';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, posix } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (f) => f.replace(REPO_ROOT + '\\', '').replace(REPO_ROOT + '/', '').split('\\').join('/');

// --- Port parsing ------------------------------------------------------------
// Yield the FIXED host port number(s) for one compose `ports:` entry (string short-form or long-form
// object). Returns [] for entries with no deterministic fixed host port (bare container port = random
// host port; a ${VAR} in the host field; unparseable).
function hostPortsOf(entry) {
  // Long form: { target, published, host_ip, protocol }
  if (entry && typeof entry === 'object') {
    const p = entry.published;
    if (p == null) return [];
    const s = String(p);
    if (s.includes('${')) return [];
    return expandRange(s);
  }
  let s = String(entry).trim();
  if (!s) return [];
  s = s.split('/')[0]; // strip /proto
  const parts = s.split(':');
  let hostField;
  if (parts.length === 1) {
    // "C" → container port only, host port is random → no fixed host port.
    return [];
  } else if (parts.length === 2) {
    // "A:B" → HOST:CONTAINER, UNLESS A is an IP (then it's IP:CONTAINER with a random host port).
    hostField = isIp(parts[0]) ? null : parts[0];
  } else {
    // "IP:HOST:CONTAINER" (IP may be empty or a ${VAR}).
    hostField = parts[parts.length - 2];
  }
  if (hostField == null || hostField.includes('${')) return [];
  return expandRange(hostField);
}

function isIp(tok) {
  return /\d+\.\d+\.\d+\.\d+/.test(tok) || tok.includes('::') || /^\[.*\]$/.test(tok);
}

// "8099" → [8099]; "8000-8002" → [8000,8001,8002]. Non-numeric → [].
function expandRange(hostField) {
  const m = hostField.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return [];
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo || hi - lo > 4096) return lo ? [lo] : [];
  const out = [];
  for (let p = lo; p <= hi; p++) out.push(p);
  return out;
}

/** Map of hostPort -> Set(files) for a set of compose docs. */
function collectHostPorts(files) {
  const map = new Map();
  for (const { file, doc } of files) {
    const services = doc?.services;
    if (!services || typeof services !== 'object') continue;
    for (const def of Object.values(services)) {
      const ports = def?.ports;
      if (!Array.isArray(ports)) continue;
      for (const entry of ports) {
        for (const hp of hostPortsOf(entry)) {
          if (!map.has(hp)) map.set(hp, new Set());
          map.get(hp).add(rel(file));
        }
      }
    }
  }
  return map;
}

// --- File discovery ----------------------------------------------------------
function loadComposeDocs() {
  const globs = [
    'infrastructure-as-code/docker/**/compose*.yaml',
    'infrastructure-as-code/docker/stacks/*.compose.yaml',
  ];
  const seen = new Set();
  const prod = [];
  const ci = [];
  for (const g of globs) {
    for (const f of globSync(g, { cwd: REPO_ROOT })) {
      const abs = resolve(REPO_ROOT, f);
      if (seen.has(abs)) continue;
      seen.add(abs);
      let doc;
      try {
        doc = parse(readFileSync(abs, 'utf8'));
      } catch (e) {
        console.error(`✗ failed to parse ${rel(abs)}: ${e.message}`);
        process.exit(2);
      }
      (posix.basename(f).endsWith('.prod.yaml') ? prod : ci).push({ file: abs, doc });
    }
  }
  return { prod, ci };
}

function runScan() {
  const { prod, ci } = loadComposeDocs();
  const prodPorts = collectHostPorts(prod);
  const ciPorts = collectHostPorts(ci);
  const collisions = [];
  for (const [port, prodFiles] of prodPorts) {
    if (ciPorts.has(port)) {
      collisions.push({ port, prodFiles: [...prodFiles], ciFiles: [...ciPorts.get(port)] });
    }
  }
  if (collisions.length) {
    console.error('✗ prod↔CI port-collision gate FAILED — a prod-published host port overlaps a CI/dev one:\n');
    for (const c of collisions.sort((a, b) => a.port - b.port)) {
      console.error(`  port ${c.port}`);
      console.error(`    prod: ${c.prodFiles.join(', ')}`);
      console.error(`    ci  : ${c.ciFiles.join(', ')}`);
    }
    console.error(
      `\n${collisions.length} collision(s). Prod and CI share one host's port space — move the prod port into the ` +
        `prod-reserved range 19000–19099 (feature 029), or pick a non-overlapping port. See docs/runbooks/prod-reboot-resilience.md.`
    );
    process.exit(1);
  }
  console.log(
    `✓ prod↔CI port-collision gate passed (${prodPorts.size} prod host-port(s) vs ${ciPorts.size} CI/dev; no overlap)`
  );
}

function selftest() {
  const prodDoc = { services: { k: { ports: ['19099:8080'] } } };
  const ciClean = { services: { k: { ports: ['127.0.0.1:8099:8080', '5432:5432'] } } };
  const ciCollide = { services: { k: { ports: ['127.0.0.1:19099:8080'] } } };
  const fails = [];

  // 1) disjoint → no collision
  let p = collectHostPorts([{ file: 'p.prod.yaml', doc: prodDoc }]);
  let c = collectHostPorts([{ file: 'ci.compose.yaml', doc: ciClean }]);
  if ([...p.keys()].some((x) => c.has(x))) fails.push('disjoint sample false-positived');

  // 2) planted overlap on 19099 → detected
  c = collectHostPorts([{ file: 'ci.compose.yaml', doc: ciCollide }]);
  if (![...p.keys()].some((x) => c.has(x))) fails.push('planted 19099 overlap NOT detected');

  // 3) parser: forms
  const cases = [
    ['8099:8080', [8099]],
    ['127.0.0.1:8099:8080', [8099]],
    ['0.0.0.0:8200', []], // IP:CONTAINER → random host port, no fixed
    ['3000', []], // bare container → random host
    ['8000-8001:9000-9001', [8000, 8001]],
    ['${TS_ADMIN_IP}:3030:3000', [3030]],
    ['${PORT}:3000', []], // ${VAR} host → skip
    ['19099:8080/tcp', [19099]],
  ];
  for (const [input, want] of cases) {
    const got = hostPortsOf(input);
    if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`parse "${input}" → [${got}], want [${want}]`);
  }
  // long form
  if (JSON.stringify(hostPortsOf({ target: 3000, published: 19030 })) !== JSON.stringify([19030]))
    fails.push('long-form published parse failed');

  if (fails.length) {
    console.error('✗ prod↔CI port-collision gate --selftest FAILED:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('✓ prod↔CI port-collision gate --selftest passed (detects planted overlap; disjoint + parser cases pass)');
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--selftest');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: check-prod-ci-port-collision.mjs [--selftest]`);
  process.exit(2);
}
if (args.includes('--selftest')) selftest();
else runScan();
