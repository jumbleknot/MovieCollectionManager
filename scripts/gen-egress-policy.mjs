#!/usr/bin/env node
// gen-egress-policy.mjs — feature 060 (dev container on Docker Sandbox)
//
// Governing: FR-007 (one canonical destination list; every enforcement configuration derived
//            from it rather than hand-maintained in parallel), FR-011 (no topology-sensitive
//            literal in git).
// Contract:  specs/060-devcontainer-docker-sandbox/contracts/egress-allowlist.md
//
// Emits the two enforcement forms of .devcontainer/egress-allowlist.json:
//
//   --format sbx-policy     one `allow network <domain>` directive per destination (host-side
//                           Docker Sandbox network policy)
//   --format ipset-domains  newline-separated domains, consumed by .devcontainer/init-firewall.sh
//                           in place of its former inline DOMAINS array (in-VM iptables/ipset)
//   --check                 validate the canonical file; exit 1 naming the offending entry
//
// Optional everywhere:
//   --forge-host <host>     append the project's forge registry host. The forge host is
//                           topology-sensitive and gated out of git, so it is NEVER stored in
//                           the canonical file — it is injected at runtime from
//                           FORGE_REGISTRY_HOST, exactly as init-firewall.sh has always done.
//                           ABSENT => the entry is omitted CLEANLY: no literal, no fallback,
//                           no error, exit 0. That mirrors the current script's unset-skips-
//                           cleanly behaviour, on which every developer without the variable set
//                           already depends.
//   --file <path>           read a different list (used by the contract test to probe --check
//                           against deliberately malformed shapes)
//
// This generator NEVER writes files. Both forms are piped by their consumer, so there is no
// generated artifact that can fall stale in git and silently disagree with its source.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LIST = resolve(REPO_ROOT, '.devcontainer/egress-allowlist.json');

const VALID_GROUPS = ['agent', 'source', 'registry', 'packages', 'app'];

// Emission order: group (in the order above), then domain alphabetically. Deterministic, so a
// regenerated form produces an empty diff, and readable, so related entries stay together in
// `sbx policy ls` output.
const groupRank = (g) => {
  const i = VALID_GROUPS.indexOf(g);
  return i === -1 ? VALID_GROUPS.length : i;
};

function usage(msg) {
  if (msg) process.stderr.write(`gen-egress-policy: ${msg}\n`);
  process.stderr.write(
    [
      'Usage:',
      '  node scripts/gen-egress-policy.mjs --format sbx-policy    [--forge-host <host>] [--file <path>]',
      '  node scripts/gen-egress-policy.mjs --format ipset-domains [--forge-host <host>] [--file <path>]',
      '  node scripts/gen-egress-policy.mjs --check                [--file <path>]',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { format: null, forgeHost: null, check: false, file: DEFAULT_LIST };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--format') out.format = argv[++i] ?? usage('--format needs a value');
    else if (a === '--forge-host') out.forgeHost = argv[++i] ?? usage('--forge-host needs a value');
    else if (a === '--file') out.file = resolve(argv[++i] ?? usage('--file needs a value'));
    else usage(`unknown argument: ${a}`);
  }
  return out;
}

function loadList(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    process.stderr.write(`gen-egress-policy: cannot read ${file}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`gen-egress-policy: ${file} is not valid JSON — ${e.message}\n`);
    process.exit(1);
  }
}

// --- validation --------------------------------------------------------------------------------
// A bare IP is rejected because CDN-backed hosts rotate: the list is resolved by DOMAIN and is
// re-runnable, and an IP literal silently stops tracking its host. A topology-sensitive name is
// rejected because it must never enter git at all (FR-011) — the forge host arrives by parameter.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6ISH = /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/;

// Private-network and overlay suffixes. A destination under any of these is by definition not a
// public egress target, so its presence here means someone pasted internal topology into the file.
const TOPOLOGY_SUFFIXES = ['.ts.net', '.internal', '.local', '.lan', '.home', '.home.arpa', '.intranet'];

function validate(list, file) {
  const problems = [];
  const push = (i, domain, msg) =>
    problems.push(`entry ${i}${domain ? ` (${domain})` : ''}: ${msg}`);

  if (!list || typeof list !== 'object' || !Array.isArray(list.destinations)) {
    problems.push('top level: "destinations" must be an array');
    return problems;
  }
  if (list.destinations.length === 0) problems.push('top level: "destinations" is empty');

  const seen = new Map();
  list.destinations.forEach((d, i) => {
    if (!d || typeof d !== 'object') return push(i, null, 'not an object');
    const { domain, group, reason, cdnRotating } = d;

    if (typeof domain !== 'string' || domain.trim() === '') {
      push(i, null, 'missing or empty "domain"');
    } else {
      const dom = domain.trim();
      if (IPV4.test(dom) || IPV6ISH.test(dom)) {
        push(i, dom, 'is a bare IP — destinations must be FQDNs (CDN hosts rotate)');
      }
      if (!dom.includes('.')) {
        push(i, dom, 'is a bare hostname with no dot — topology-sensitive or malformed');
      }
      const lower = dom.toLowerCase();
      for (const suffix of TOPOLOGY_SUFFIXES) {
        if (lower.endsWith(suffix)) {
          push(i, dom, `ends with "${suffix}" — topology-sensitive, must not enter git (FR-011)`);
          break;
        }
      }
      // If the forge host happens to be set in this environment, catch it having been pasted in.
      const forgeEnv = (process.env.FORGE_REGISTRY_HOST || '').trim().toLowerCase();
      if (forgeEnv && lower === forgeEnv) {
        push(i, dom, 'is the forge registry host — inject it at runtime via --forge-host, never store it');
      }
      if (seen.has(lower)) push(i, dom, `duplicate of entry ${seen.get(lower)}`);
      else seen.set(lower, i);
    }

    if (typeof group !== 'string' || !VALID_GROUPS.includes(group)) {
      push(i, domain, `group "${group}" is not one of: ${VALID_GROUPS.join(' | ')}`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      push(i, domain, 'has an empty "reason" — an unexplained allowlist entry is an unreviewable one');
    }
    if (typeof cdnRotating !== 'boolean') {
      push(i, domain, '"cdnRotating" must be a boolean');
    }
  });

  return problems;
}

// --- emission ----------------------------------------------------------------------------------

function orderedDomains(list) {
  return [...list.destinations]
    .sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.domain.localeCompare(b.domain))
    .map((d) => d.domain);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.check && !args.format) usage('one of --check or --format is required');
  if (args.check && args.format) usage('--check and --format are mutually exclusive');

  const list = loadList(args.file);

  if (args.check) {
    const problems = validate(list, args.file);
    if (problems.length > 0) {
      process.stderr.write(`gen-egress-policy: ${args.file} failed validation\n`);
      for (const p of problems) process.stderr.write(`  - ${p}\n`);
      process.exit(1);
    }
    process.stdout.write(
      `gen-egress-policy: ${list.destinations.length} destinations valid\n`,
    );
    process.exit(0);
  }

  // Emitting always validates first: piping a malformed list straight into an enforcement layer
  // is how a bad entry becomes a live firewall rule nobody reviewed.
  const problems = validate(list, args.file);
  if (problems.length > 0) {
    process.stderr.write(`gen-egress-policy: refusing to emit — ${args.file} failed validation\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.exit(1);
  }

  const domains = orderedDomains(list);

  // The forge host is appended LAST rather than sorted in, so that its presence or absence never
  // reorders the rest of the output. Absent => omitted cleanly, no error, exit 0.
  if (args.forgeHost && args.forgeHost.trim() !== '') {
    domains.push(args.forgeHost.trim());
  }

  let out;
  if (args.format === 'sbx-policy') {
    out = domains.map((d) => `allow network ${d}`).join('\n');
  } else if (args.format === 'ipset-domains') {
    out = domains.join('\n');
  } else {
    usage(`unknown --format: ${args.format}`);
  }
  process.stdout.write(out + '\n');
}

main();
