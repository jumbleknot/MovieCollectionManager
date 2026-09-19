#!/usr/bin/env node
// Prune the BFF runtime dependency tree to what `node server.js` can actually reach.
//
// WHY THIS EXISTS (measured, 2026-09-07 — backlog item #249). After item #244 the shipped
// `mcm-bff:latest` was 1.73 GB, and 1.2 GB of that was `/app/runtime/node_modules` — the
// production tree `pnpm deploy --prod` materializes (1513 packages). Those ARE genuine
// `dependencies` of `mcm-app`, so `--prod` keeps them; but they are dependencies of the WEB
// BUNDLE, which Metro has already compiled into `dist/` at build time. The runtime process is
// `node server.js`, whose reach is `@expo/server`, `express`, and their closure.
//
// This was NOT reasoned about — it was traced. A `--require` preload inside the running container
// recorded every `Module._resolveFilename`, ESM load, `process.dlopen` and raw `fs` read under
// `/app/runtime` while the full web E2E suite ran against it and a sweep hit every route in
// `dist/server/_expo/routes.json`. 76 of 1513 packages were ever touched, and every one of them
// falls inside the closure the roots below produce.
//
// WHY A CLOSURE WALK RATHER THAN A DELETE-LIST. A hand-maintained "packages to delete" list rots
// the moment a dependency moves, and its failure mode is a route that 500s lazily in production
// rather than a build that fails. Walking the pnpm symlink graph from a small ROOT set is exact —
// it is the same graph Node's resolver reads — and it self-maintains across version bumps. Only
// the roots are hand-held, and an absent root is a hard failure here rather than a silent
// prune-everything.
//
// WHY A TRACE ALONE IS NOT ENOUGH. Expo Router loads route handlers lazily per request, so a trace
// only proves what the paths it drove happened to load. The gap is closed statically rather than
// hopefully: every require-like call site in the exported bundle takes a STRING LITERAL (verified —
// all 10 `__require` sites and all 20 `$$require_external` sites), so the set of packages the
// runtime can name is finite and enumerable. `checkBundle()` enumerates it, and
// `KNOWN_DYNAMIC_SPECIFIERS` records the disposition of every member.
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
// Item #500 — the shared argument contract. THIS SCRIPT DELETES DIRECTORY TREES, and the safe mode
// used to be the one that required an exact spelling: `--dryrun`, `--dry_run` and `-dry-run` were
// each silently ignored, leaving the real delete running with an identical exit code.
import { ArgvError, dieOnArgvError, partitionArgs, wantsHelp } from './lib/argv-contract.mjs';

// The two packages `frontend/mcm-app/server.js` requires by name. Everything the runtime touches
// through them is reached by the closure walk below.
export const STATIC_ROOTS = ['express', '@expo/server'];

// Packages the EXPORTED BUNDLE reaches at runtime by bare specifier rather than through an import
// the closure walk can see — `@copilotkit/runtime`'s lazy provider adapters, called through the
// esbuild interop shim `__require = createRequire(globalThis.__ExpoImportMetaRegistry.url)`, which
// resolves from /app/runtime. Listed here because nothing links them into the graph: only a string
// in a minified bundle does.
//
// This list is SHORT because most of those specifiers do not resolve in the deployed tree TODAY —
// measured 2026-09-07 with `createRequire('/app/runtime/server.js').resolve(...)` inside
// `mcm-bff:latest`: of the fourteen bare specifiers in `dist/server`, thirteen already throw
// MODULE_NOT_FOUND (@langchain/*, @anthropic-ai/sdk, groq-sdk, ajv*) because `pnpm deploy --prod`
// hoists only mcm-app's DIRECT dependencies to the top level. A package that cannot be resolved
// before the prune cannot be broken by it — so only the one that does resolve is a root.
export const DYNAMIC_ROOTS = ['openai'];

export const RUNTIME_ROOTS = [...STATIC_ROOTS, ...DYNAMIC_ROOTS];

// Every bare specifier the exported server bundle can pass to a require-like call, and what this
// script does about each. `checkBundle()` re-derives this set from the built bundle and fails when
// something appears that is not accounted for here — a CopilotKit/LangChain upgrade that adds a new
// lazy provider must be a RED BUILD, not a route that 500s the first time someone hits it.
export const KNOWN_DYNAMIC_SPECIFIERS = {
  // Resolves today → kept as a root.
  openai: 'root',
  // Optional peer dependencies of @copilotkit/runtime's LangChain adapters. None is a dependency of
  // mcm-app, so none is hoisted to /app/runtime/node_modules and all already throw at the call site,
  // pruned or not.
  '@anthropic-ai/sdk': 'unresolvable',
  '@langchain/aws': 'unresolvable',
  '@langchain/community': 'unresolvable',
  '@langchain/core': 'unresolvable',
  '@langchain/google-gauth': 'unresolvable',
  'groq-sdk': 'unresolvable',
  langchain: 'unresolvable',
  // Emitted into ajv's own generated validator code, which the bundle inlines; the runtime require
  // never fires because the generated code is never evaluated, and ajv is not hoisted either.
  ajv: 'unresolvable',
  'ajv-formats': 'unresolvable',
};

const PNPM = '.pnpm';

/** The `.pnpm/<entry>` directory name a resolved package path lives under, or null if it does not. */
export function pnpmEntryOf(p) {
  const parts = String(p).split(sep);
  const i = parts.lastIndexOf(PNPM);
  return i === -1 || i + 1 >= parts.length ? null : parts[i + 1];
}

/** The nearest ancestor directory named `node_modules` — where a package resolves its deps from. */
export function depsRootOf(pkgDir) {
  let d = dirname(pkgDir);
  while (d !== dirname(d)) {
    if (basename(d) === 'node_modules') return d;
    d = dirname(d);
  }
  return null;
}

/** Package names directly under a node_modules dir, expanding `@scope/` one level. */
export function packageNamesIn(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      let scoped;
      try {
        scoped = readdirSync(join(dir, name));
      } catch {
        continue;
      }
      for (const child of scoped) out.push(`${name}/${child}`);
    } else {
      out.push(name);
    }
  }
  return out;
}

/**
 * Every `.pnpm/<entry>` reachable from the roots by following the symlink graph pnpm lays down —
 * the same edges Node's resolver walks. A missing REQUIRED root throws: a rename or a dependency
 * drop must fail the build, never silently prune the whole tree. A missing OPTIONAL root is fine —
 * it is a lazy specifier that already does not resolve, so keeping nothing for it changes nothing.
 */
export function computeClosure(nmDir, requiredRoots = STATIC_ROOTS, optionalRoots = DYNAMIC_ROOTS) {
  const keep = new Set();
  const visited = new Set();
  const queue = [];

  for (const root of requiredRoots) {
    const link = join(nmDir, root);
    if (!existsSync(link)) {
      throw new Error(`runtime root "${root}" is not present in ${nmDir} — refusing to prune`);
    }
    queue.push(realpathSync(link));
  }
  for (const root of optionalRoots) {
    const link = join(nmDir, root);
    if (existsSync(link)) queue.push(realpathSync(link));
  }

  while (queue.length > 0) {
    const pkgDir = queue.pop();
    if (visited.has(pkgDir)) continue;
    visited.add(pkgDir);

    const entry = pnpmEntryOf(pkgDir);
    if (entry) keep.add(entry);

    const depsRoot = depsRootOf(pkgDir);
    // A package sitting directly in the top-level node_modules resolves its deps from there too,
    // but its SIBLINGS are the app's other direct dependencies, not its own — enumerating them
    // would pull the whole tree back in. Only `.pnpm/<entry>/node_modules/` holds a package's own
    // resolved dependencies, so that is the only edge set we follow.
    if (!depsRoot || depsRoot === nmDir) continue;

    for (const name of packageNamesIn(depsRoot)) {
      const link = join(depsRoot, name);
      let real;
      try {
        real = realpathSync(link);
      } catch {
        continue; // a dangling optional-dependency link
      }
      if (real !== pkgDir) queue.push(real);
    }
  }

  return keep;
}

/**
 * What a prune would remove: unreachable `.pnpm` entries, the top-level links pointing into them,
 * and the `.bin` shims those packages installed — the shims are what turn a removed package into a
 * DANGLING SYMLINK rather than an absent one, and a tree full of broken links is a needless puzzle
 * for the next person (and for the image scanners that walk it).
 */
export function planPrune(nmDir, keep) {
  const pnpmDir = join(nmDir, PNPM);
  const pnpmDelete = readdirSync(pnpmDir)
    .filter((name) => !name.startsWith('.') && !keep.has(name))
    .map((name) => join(pnpmDir, name));

  const topDelete = [];
  for (const name of packageNamesIn(nmDir)) {
    const link = join(nmDir, name);
    let entry = null;
    try {
      entry = lstatSync(link).isSymbolicLink() ? pnpmEntryOf(realpathSync(link)) : null;
    } catch {
      topDelete.push(link); // dangling
      continue;
    }
    // Real directories (an injected workspace package) and links into a kept entry stay.
    if (entry !== null && !keep.has(entry)) topDelete.push(link);
  }

  const binDir = join(nmDir, '.bin');
  const binDelete = [];
  if (existsSync(binDir)) {
    for (const name of readdirSync(binDir)) {
      const link = join(binDir, name);
      let entry = null;
      try {
        // readlink + resolve, NOT realpath: a shim names a FILE inside the package, and realpath
        // throws when that file is missing — which would read as "dangling" and delete the shim of
        // a package we are keeping. The link text alone says which .pnpm entry it belongs to.
        entry = pnpmEntryOf(resolve(binDir, readlinkSync(link)));
      } catch {
        continue; // not a symlink (a real file in .bin) — leave it alone
      }
      if (entry !== null && !keep.has(entry)) binDelete.push(link);
    }
  }

  return { pnpmDelete, topDelete, binDelete };
}

/**
 * Bare specifiers passed to a require-like call in an exported bundle. THREE shapes appear in Metro
 * output, and missing any one of them makes this guard a comment rather than a check:
 *
 *   • a plain `require("x")` that survived bundling;
 *   • esbuild's interop shim, called as `(0,n.__require)("x")` — the `.` before `__require` is why a
 *     single naive pattern misses every LangChain adapter (measured: it found only the ajv strings);
 *   • Metro's own `$$require_external("x")` escape hatch, defined in every exported bundle.
 *
 * `node:` builtins are excluded: they resolve out of Node itself and no prune can affect them.
 * Verified 2026-09-07 against the shipped bundle: all 10 `__require` sites and all 20
 * `$$require_external` sites take a string LITERAL, so this enumeration is exhaustive rather than
 * a sample — every `$$require_external` argument was a `node:` builtin.
 */
export function extractDynamicSpecifiers(text) {
  const patterns = [
    /(?:__require\)|(?:^|[^\w$.])require)\(\s*["']([^"'./][^"']*)["']\s*\)/g,
    /\$\$require_external\(\s*["']([^"'./][^"']*)["']\s*\)/g,
  ];
  const out = new Set();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      // `isBuiltin` rather than a `node:` prefix test: the bundle contains BOTH spellings, and the
      // bare one is the trap — the first real build of this gate failed on `require("fs")`, which a
      // prefix test reads as a package name. Builtins come out of Node itself; no prune reaches them.
      if (!isBuiltin(m[1])) out.add(m[1]);
    }
  }
  return out;
}

/** `@langchain/core/messages` → `@langchain/core`; `ajv/dist/runtime/uri` → `ajv`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function jsFilesUnder(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  }
  return out;
}

/**
 * Fail the BUILD when the exported bundle grows a lazy bare require this script has not accounted
 * for. Without this the prune is a bet on a bundle nobody re-reads: a CopilotKit or LangChain
 * upgrade that adds one more optional provider would silently make the pruned tree wrong, and the
 * symptom would be one route 500ing in production rather than anything a build or a test shows.
 */
export function checkBundle(distServerDir, log = console.log) {
  if (!existsSync(distServerDir)) {
    throw new Error(`${distServerDir} does not exist — nothing to check`);
  }
  const seen = new Map();
  for (const file of jsFilesUnder(distServerDir)) {
    for (const spec of extractDynamicSpecifiers(readFileSync(file, 'utf8'))) {
      if (!seen.has(spec)) seen.set(spec, file);
    }
  }
  const unaccounted = [...seen].filter(([spec]) => !(packageNameOf(spec) in KNOWN_DYNAMIC_SPECIFIERS));
  log(`[prune-bff-runtime] bundle check: ${seen.size} dynamic specifiers, ${unaccounted.length} unaccounted`);
  if (unaccounted.length > 0) {
    const lines = unaccounted.map(([spec, file]) => `  ${spec}  (${file})`).join('\n');
    throw new Error(
      `the exported server bundle reaches for ${unaccounted.length} bare specifier(s) that ` +
        `scripts/prune-bff-runtime-modules.mjs does not account for:\n${lines}\n` +
        'Decide for each: does it resolve from /app/runtime? If yes add it to DYNAMIC_ROOTS so the ' +
        'prune keeps it; if no record it as "unresolvable" in KNOWN_DYNAMIC_SPECIFIERS. Never ' +
        'delete this check to get a green build.'
    );
  }
  return seen;
}

function duBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += statSync(p).size;
        } catch {
          /* raced or unreadable */
        }
      }
    }
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function prune({ runtime, dryRun = false, log = console.log }) {
  const nmDir = join(runtime, 'node_modules');
  if (!existsSync(join(nmDir, PNPM))) {
    throw new Error(`${nmDir} has no ${PNPM}/ — this is not a pnpm deploy output`);
  }

  const before = { bytes: duBytes(nmDir), packages: readdirSync(join(nmDir, PNPM)).filter((n) => !n.startsWith('.')).length };
  const keep = computeClosure(nmDir);
  const { pnpmDelete, topDelete, binDelete } = planPrune(nmDir, keep);

  log(`[prune-bff-runtime] roots: ${RUNTIME_ROOTS.join(', ')}`);
  log(`[prune-bff-runtime] before: ${before.packages} packages, ${mb(before.bytes)}`);
  log(`[prune-bff-runtime] reachable: ${keep.size} packages`);
  log(
    `[prune-bff-runtime] removing: ${pnpmDelete.length} .pnpm entries, ` +
      `${topDelete.length} top-level links, ${binDelete.length} .bin shims`
  );

  if (dryRun) {
    log('[prune-bff-runtime] DRY RUN (the default): nothing removed — pass --apply to delete');
    return { before, keep, pnpmDelete, topDelete, binDelete, after: null };
  }

  for (const p of [...binDelete, ...topDelete, ...pnpmDelete]) rmSync(p, { recursive: true, force: true });

  const after = { bytes: duBytes(nmDir), packages: readdirSync(join(nmDir, PNPM)).filter((n) => !n.startsWith('.')).length };
  log(`[prune-bff-runtime] after:  ${after.packages} packages, ${mb(after.bytes)} (saved ${mb(before.bytes - after.bytes)})`);
  return { before, keep, pnpmDelete, topDelete, binDelete, after };
}

// ── The argument contract (item #500) ────────────────────────────────────────────────────────────

/** Every argument this script accepts. Anything else is an ERROR — see resolveCommand. */
export const ACCEPTED_FLAGS = ['--check-bundle', '--apply', '--dry-run', '--help', '-h'];

export const USAGE = `prune-bff-runtime-modules.mjs — shrink the shipped BFF runtime tree to its closure.

  node scripts/prune-bff-runtime-modules.mjs [dir]                 DRY RUN — report what would be
                                                                   removed and delete NOTHING (default)
  node scripts/prune-bff-runtime-modules.mjs --dry-run [dir]       the same, stated explicitly
  node scripts/prune-bff-runtime-modules.mjs --apply [dir]         DELETE the prunable packages
  node scripts/prune-bff-runtime-modules.mjs --check-bundle [dir]  audit the exported bundle's
                                                                   dynamic specifiers; deletes nothing
  node scripts/prune-bff-runtime-modules.mjs --help                this text

[dir] defaults to /app/runtime for a prune and dist/server for --check-bundle.
DELETING REQUIRES --apply. frontend/mcm-app/Dockerfile is the caller that passes it.`;

/**
 * Resolve argv into the action to take — and REJECT anything not recognised.
 *
 * TWO CHANGES, and the second is the one that matters (item #500).
 *
 * 1. REJECTION. `--dry-run` used to be tested with `argv.includes(...)`, so every near-miss spelling
 *    — `--dryrun`, `--dry_run`, `-dry-run` — was a silently-ignored token that left the default
 *    running. The default deleted files.
 *
 * 2. INVERSION, which REMOVES the class rather than policing it. Dry-run is now the default and
 *    `--apply` is required to delete. A guard is only as good as its coverage of the inputs someone
 *    will actually type; an inversion means that even an input nobody anticipated — or a future
 *    caller that bypasses this function outright — can only ever fail SAFE. On a script whose
 *    failure mode is an irreversible `rmSync(…, { recursive: true })` inside a container image
 *    build, that difference is worth the one-line Dockerfile change it cost.
 *
 * `--apply --dry-run` is REFUSED rather than resolved by precedence. Neither "last flag wins" nor
 * "safe wins" is honest: an operator who typed both does not know what they asked for, and this
 * script deletes.
 *
 * @returns {{command: 'help'|'check-bundle'|'prune', target: string, apply: boolean}}
 * @throws {ArgvError} when any argument is not in ACCEPTED_FLAGS, or the flags contradict
 */
export function resolveCommand(argv = []) {
  const args = (argv ?? []).filter((a) => a !== '');
  // Help wins outright: someone asking what this does must never trigger what it does.
  if (wantsHelp(args)) return { command: 'help', target: '', apply: false };

  const { flags, positionals } = partitionArgs(args, {
    accepted: ACCEPTED_FLAGS,
    maxPositionals: 1,
    usage: USAGE,
  });

  if (flags.has('--apply') && flags.has('--dry-run')) {
    throw new ArgvError(
      'both --apply and --dry-run were given, and they contradict each other.\n' +
        'Pick one: --apply deletes, --dry-run (the default) does not.\n\n' + USAGE,
    );
  }
  if (flags.has('--check-bundle') && flags.has('--apply')) {
    throw new ArgvError(
      '--check-bundle audits the exported bundle and deletes nothing, so --apply is meaningless ' +
        'with it.\n\n' + USAGE,
    );
  }

  if (flags.has('--check-bundle')) {
    return { command: 'check-bundle', target: positionals[0] ?? 'dist/server', apply: false };
  }
  return { command: 'prune', target: positionals[0] ?? '/app/runtime', apply: flags.has('--apply') };
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  let resolved;
  try {
    resolved = resolveCommand(process.argv.slice(2));
  } catch (err) {
    dieOnArgvError(err);
  }
  const { command, target, apply } = resolved;
  try {
    if (command === 'help') {
      console.log(USAGE);
    } else if (command === 'check-bundle') {
      checkBundle(target);
    } else {
      prune({ runtime: target, dryRun: !apply });
    }
  } catch (err) {
    console.error(`[prune-bff-runtime] ${err.message}`);
    process.exit(1);
  }
}
