#!/usr/bin/env node
//
// The agent-driven backlog tool — issue CRUD on this repository's forge tracker from inside the dev
// container, with no commit, branch, pull request or CI run involved.
//
// Feature: specs/049-forgejo-issue-tracking (FR-001 … FR-020). Decision rules for WHEN to file, close
// or label live in .claude/skills/forgejo-issues/SKILL.md; this file carries what must be right EVERY
// time. Long-form flag reference: `--help`.
//
// Conventions deliberately copied from ci-status.mjs, whose shape these problems already solved:
//   - one emit path, redaction applied there, so the forge host is `<forge>` by construction
//   - a bare 401/403 is never surfaced; it names the token used and the permission missing
//   - the API base and repo slug are derived from the git remote, never from a literal or an env var
//   - raw response payloads never reach stdout
//
// Measured forge behaviour this file defends against (research.md D2/D3, forge 15.0.3+gitea-1.22.0):
//   - omitting `type=issues` interleaves pull requests: 143 rows where 1 is correct
//   - `limit` caps hard at 50 (default 30); a 50-row answer is not evidence of a complete one
//   - `labels=<unknown-name>` is SILENTLY IGNORED and returns the UNFILTERED set — so a typo reads as
//     "matched everything". Every label and milestone name is resolved locally first, and refused here.

import { readFileSync, existsSync } from 'node:fs';

import { redactForPublication } from './ci-digest-redact.mjs';
import { forgeEndpoint, stripControlChars } from './ci-status.mjs';

/** Exit codes, so a caller (or CI) can branch without parsing prose. */
export const EXIT = { ok: 0, unexpected: 1, usage: 2, credential: 3, authorization: 4, transport: 5 };

export class BacklogError extends Error {
  constructor(message, code = EXIT.unexpected) {
    super(message);
    this.code = code;
  }
}

const MAX_BODY_BYTES = 64 * 1024;
const PAGE_LIMIT_CAP = 50; // measured: limit=60 and limit=200 both return 50
const DEFAULT_PAGE_LIMIT = 30; // measured: the API's own default

/** Every emitted line goes through redaction and control-char stripping, so the host is `<forge>` and
 *  a hostile issue title cannot inject terminal escapes into the operator's terminal. */
export const renderLine = (line) => stripControlChars(redactForPublication(String(line)));
const emit = (line = '') => console.log(renderLine(line));

// ── Labels ─────────────────────────────────────────────────────────────────────────────────────────

/** The taxonomy from data-model.md. `status/bot-managed` exists because the tracker already holds
 *  Renovate's Dependency Dashboard, which this tooling must never edit, close or sweep (research D4). */
export const TAXONOMY = [
  { name: 'type/bug', color: '#d73a4a', description: 'Something is wrong' },
  { name: 'type/feature', color: '#0e8a16', description: 'New capability' },
  { name: 'type/tech-debt', color: '#fbca04', description: 'Cost already incurred, not yet paid' },
  { name: 'type/chore', color: '#c5def5', description: 'Maintenance, no behaviour change' },
  { name: 'priority/p1', color: '#b60205', description: 'Do next' },
  { name: 'priority/p2', color: '#e99695', description: 'Do soon' },
  { name: 'priority/p3', color: '#f9d0c4', description: 'Do eventually' },
  { name: 'status/blocked', color: '#5319e7', description: 'Waiting on another item — graph is truth' },
  { name: 'status/needs-spec', color: '#1d76db', description: 'Too large to implement without spec→plan→tasks' },
  { name: 'status/bot-managed', color: '#bfd4f2', description: 'Another automation owns this — never edit' },
];

const PRIORITY_ORDER = ['priority/p1', 'priority/p2', 'priority/p3'];

// ── Credentials (FR-005, FR-006) ───────────────────────────────────────────────────────────────────

const present = (v) => typeof v === 'string' && v.trim().length > 0;

export function describeMissingWriteToken() {
  return (
    'MCM_FORGE_ISSUE_TOKEN is not set, so backlog WRITES are unavailable; reads continue read-only via ' +
    'MCM_FORGE_TOKEN. It is the dedicated credential permitted to write items and read the repository, ' +
    'passed into the dev container from the host via ${localEnv}. Set it on the host with ' +
    '`setx MCM_FORGE_ISSUE_TOKEN …`, then FULLY QUIT VS Code (a reload keeps the old environment, so ' +
    '${localEnv} resolves to empty and the token is silently absent) and rebuild.'
  );
}

/**
 * Writes require the issue token. Reads prefer it and fall back to the read-only diagnostics token.
 *
 * Preferring it for reads is deliberate: falling back on every read would keep the tool working while
 * the write credential is broken, hiding the breakage until the first write — the FR-006 failure mode.
 */
export function selectToken(env = process.env, { write = false } = {}) {
  if (present(env.MCM_FORGE_ISSUE_TOKEN)) {
    return { token: env.MCM_FORGE_ISSUE_TOKEN.trim(), name: 'MCM_FORGE_ISSUE_TOKEN' };
  }
  if (write) throw new BacklogError(describeMissingWriteToken(), EXIT.credential);
  if (present(env.MCM_FORGE_TOKEN)) return { token: env.MCM_FORGE_TOKEN.trim(), name: 'MCM_FORGE_TOKEN' };
  throw new BacklogError(
    'Neither MCM_FORGE_ISSUE_TOKEN nor MCM_FORGE_TOKEN is set, so the backlog cannot even be read. ' +
      describeMissingWriteToken(),
    EXIT.credential,
  );
}

/** Endpoint family → the permission it needs. Order matters: the issue families are checked first. */
const PERMISSION_BY_ENDPOINT = [
  [/\/issues(\/|\?|$)/, 'write:issue'],
  [/\/labels(\/|\?|$)/, 'write:issue'],
  [/\/milestones(\/|\?|$)/, 'write:issue'],
  [/\/issue_config/, 'read:repository'],
];

/**
 * Turn a bare 401/403 into a message naming the token used AND the permission missing.
 *
 * A bare status code is indistinguishable from an expired credential, and this project has already paid
 * once for that ambiguity. The same token can return 200 on another endpoint in the same second.
 */
export function describeScopeFailure(status, endpoint, tokenName) {
  const hit = PERMISSION_BY_ENDPOINT.find(([re]) => re.test(endpoint));
  const permission = hit ? hit[1] : 'read:repository';
  const readNote =
    permission === 'write:issue' ? ' (or `read:issue`, if this call was a read rather than a write)' : '';
  return (
    `Forge returned ${status} for ${endpoint} using ${tokenName} — that credential is missing the ` +
    `\`${permission}\` permission${readNote}. This is granular scope, not expiry: the same credential ` +
    `can return 200 on other endpoints in the same second. Nothing was retried and nothing was ` +
    `downgraded. Note that the repository payload's \`permissions\` block is NOT a scope check — it ` +
    `reports what the owning account may do with the repository, not what the token may do.`
  );
}

// ── The same-repository write guard (FR-016) ────────────────────────────────────────────────────────

/**
 * Refuse any write whose target is not the repository the working copy points at.
 *
 * The write credential can reach items on other repositories by decision (research D5), so this is the
 * only client-side bound on blast radius. It runs before the request is issued, on every write path —
 * not only on the task fan-out.
 */
export function assertWriteTargetsOriginRepo(target, origin) {
  if (target.owner !== origin.owner || target.repo !== origin.repo) {
    throw new BacklogError(
      `Refusing to write to ${target.owner}/${target.repo}: this working copy's origin is ` +
        `${origin.owner}/${origin.repo}. Items are only ever created or modified on the repository the ` +
        `remote points at. The write credential can reach other repositories, so this guard — not the ` +
        `credential — is what keeps writes here.`,
      EXIT.usage,
    );
  }
}

/**
 * The same guard at the request boundary: a mutating request's path must address the origin repository.
 *
 * This catches what the slug-level check cannot — a mis-built path. It is the last thing between a
 * credential that can reach other trackers and a write landing in one of them.
 */
export function assertWritePathTargetsOriginRepo(pathAndQuery, origin) {
  const m = pathAndQuery.match(/^\/repos\/([^/]+)\/([^/?]+)/);
  if (!m) {
    throw new BacklogError(`Refusing a write to a path outside /repos/: ${pathAndQuery}`, EXIT.usage);
  }
  assertWriteTargetsOriginRepo({ owner: m[1], repo: m[2] }, origin);
}

// ── Transport (FR-006, FR-008) ─────────────────────────────────────────────────────────────────────

/**
 * One request. Returns distilled `{ data, total }` — never the raw text, which must not reach stdout.
 * `fetchImpl` is injectable so the unit tier stays offline and token-free.
 */
export async function forgeRequest(
  pathAndQuery,
  { base, token, tokenName, method = 'GET', body = null, fetchImpl = fetch, timeoutMs = 30000 } = {},
) {
  const url = `${base}${pathAndQuery}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Distinct from an authorization refusal on purpose: this exact failure, produced by a base URL
    // built without the forge's port, reads like a blocked firewall and cost Phase 0 a full probe pass.
    throw new BacklogError(
      `Could not reach the forge at ${base} (${e.name}: ${e.message}). This is a transport failure, ` +
        `not a permission problem — check that the base above carries the right host AND port, that the ` +
        `container firewall allows it, and that the forge is up.`,
      EXIT.transport,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new BacklogError(describeScopeFailure(res.status, pathAndQuery, tokenName), EXIT.authorization);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new BacklogError(
      `Forge returned ${res.status} for ${method} ${pathAndQuery}: ${renderLine(text).slice(0, 300)}`,
      EXIT.unexpected,
    );
  }
  let data = null;
  if (text.trim().length) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new BacklogError(`Forge returned unparseable JSON for ${pathAndQuery}`, EXIT.unexpected);
    }
  }
  return { data, total: readTotalCount(res.headers), status: res.status };
}

// ── Listing (FR-008) ───────────────────────────────────────────────────────────────────────────────

/**
 * `type=issues` is not optional: without it, pull requests interleave, because the tracker stores them
 * as issues internally. Measured on this repository: 1 backlog item vs 143 rows.
 *
 * `page` and `limit` always travel together. Measured: `limit` alone IS honoured here (the
 * `actions/runs` quirk does not transfer), so this is explicitness, not a workaround — the real hazard
 * is the hard cap of 50.
 */
export function buildIssueQuery({ state = 'open', labels, milestone, q, page = 1, limit } = {}) {
  const params = new URLSearchParams();
  params.set('type', 'issues');
  params.set('state', state);
  params.set('page', String(page));
  params.set('limit', String(Math.min(Number(limit) || DEFAULT_PAGE_LIMIT, PAGE_LIMIT_CAP)));
  if (labels?.length) params.set('labels', labels.join(','));
  if (milestone) params.set('milestones', milestone);
  if (q) params.set('q', q);
  return params;
}

/** The authoritative total. Present on list endpoints only — absent on a single-item GET. */
export function readTotalCount(headers) {
  const raw = headers?.get?.('x-total-count');
  return raw === null || raw === undefined || raw === '' ? null : Number(raw);
}

/** FR-008 forbids inferring the total from the row count, so a short page must say so out loud. */
export function describeTruncation(total, rows) {
  if (total === null || total === undefined || rows >= total) return null;
  return `⚠ showing ${rows} of ${total} — result truncated (the API caps a page at ${PAGE_LIMIT_CAP}); narrow the filter or page through the rest.`;
}

// ── Name resolution (FR-012, FR-014) ───────────────────────────────────────────────────────────────

/**
 * Resolve label or milestone NAMES to the repository's own entries, and refuse an unknown one.
 *
 * This is not defensive politeness. Measured: `labels=<unknown-name>` is silently ignored server-side
 * and returns the UNFILTERED set, so a typo'd filter reads as "matched everything" — and a caller acting
 * on that answer is confidently wrong. Refusing locally is the only way the typo becomes visible.
 */
export function resolveNames(requested, available, kind = 'label') {
  if (!requested?.length) return [];
  const byName = new Map(available.map((a) => [a.name ?? a.title, a]));
  return requested.map((name) => {
    const hit = byName.get(name);
    if (!hit) {
      const valid = [...byName.keys()].sort().join(', ') || '(none defined yet)';
      throw new BacklogError(
        `No such ${kind}: "${name}". Valid ${kind}s on this repository: ${valid}. ` +
          `Refused locally on purpose — the API silently ignores an unknown ${kind} filter and returns ` +
          `the UNFILTERED set, which would look like a successful match.`,
        EXIT.usage,
      );
    }
    return hit;
  });
}

// ── Dependency edges (FR-011, US5) ─────────────────────────────────────────────────────────────────

/**
 * Would "subject blocked by object" close a cycle? Walks the existing blocker graph from `object`.
 *
 * A cycle is not merely untidy: every item in it becomes permanently uncloseable, because the forge
 * refuses to close an item with open dependencies (measured: 412). Refusing before the call is the only
 * cheap moment — afterwards the operator has to break it by hand in the web UI.
 */
export function wouldCreateCycle(subject, object, blockers = {}, maxDepth = 32) {
  if (subject === object) return true;
  const seen = new Set();
  const walk = (n, depth) => {
    if (depth > maxDepth || seen.has(n)) return false;
    seen.add(n);
    for (const b of blockers[n] ?? []) {
      if (b.number === subject) return true;
      if (walk(b.number, depth + 1)) return true;
    }
    return false;
  };
  return walk(object, 0);
}

// ── Ready-work selection (FR-011) ──────────────────────────────────────────────────────────────────

const labelNames = (item) => (item.labels ?? []).map((l) => l.name);

/**
 * Open, not bot-managed, not blocked, ordered by priority then number.
 *
 * `status/blocked` is the CHEAP pre-filter; the dependency graph is the AUTHORITY. When `blockers` has
 * an entry for an item, the graph decides — including overriding a stale label. When it has none, the
 * graph was never consulted for that item, so the label stands. Any disagreement is reported rather
 * than silently reconciled, because a label quietly diverging from the graph is how the state forks.
 */
export function selectReadyItems(items, blockers = {}) {
  const warnings = [];
  const candidates = [];
  for (const item of items) {
    const names = labelNames(item);
    if (names.includes('status/bot-managed')) continue;
    const labelled = names.includes('status/blocked');
    const consulted = Object.prototype.hasOwnProperty.call(blockers, item.number);
    const openBlockers = consulted
      ? (blockers[item.number] ?? []).filter((b) => b.state !== 'closed')
      : [];
    if (consulted && labelled !== openBlockers.length > 0) {
      warnings.push(
        openBlockers.length
          ? `⚠ item #${item.number} is blocked by ${openBlockers.map((b) => `#${b.number}`).join(', ')} but carries no status/blocked label — the graph wins; consider labelling it`
          : `⚠ item #${item.number} carries status/blocked but has no unresolved blocker — the graph wins; consider removing the label`,
      );
    }
    const blocked = consulted ? openBlockers.length > 0 : labelled;
    if (!blocked) candidates.push(item);
  }
  const rank = (item) => {
    const i = labelNames(item).findIndex((n) => PRIORITY_ORDER.includes(n));
    return i === -1 ? PRIORITY_ORDER.length : PRIORITY_ORDER.indexOf(labelNames(item)[i]);
  };
  candidates.sort((a, b) => rank(a) - rank(b) || a.number - b.number);
  return { ready: candidates, warnings };
}

// ── Distillation (FR-008) ──────────────────────────────────────────────────────────────────────────

/** What a decision needs, and nothing else. The raw payload carries ~40 fields; none of them reach
 *  stdout, and every string is redacted so a transcript stays topology-clean. */
export function distillItem(raw, deps = null) {
  const clean = (s) => (s === null || s === undefined ? s : renderLine(s));
  const base = {
    number: raw.number,
    title: clean(raw.title),
    state: raw.state,
    labels: (raw.labels ?? []).map((l) => l.name),
    milestone: raw.milestone?.title ?? null,
    author: raw.user?.login ?? null,
    updatedAt: raw.updated_at ?? null,
    url: clean(raw.html_url),
    body: clean(raw.body ?? ''),
  };
  // Dependency and comment fields are OMITTED when they were not fetched, rather than defaulted to [].
  // An empty array reads as "no blockers"; the truth is "nobody asked", and a listing does not ask (one
  // dependency call per row would be an N+1). A field that quietly means two different things is the
  // same defect class as a filter that fails open — so the key is absent instead, and the API's own
  // comment COUNT is surfaced, which is true without a second call.
  if (!deps) return { ...base, commentCount: raw.comments ?? 0 };
  return {
    ...base,
    blockedBy: (deps.blockers ?? []).map((b) => b.number),
    blocks: (deps.blocks ?? []).map((b) => b.number),
    comments: (deps.comments ?? []).map((c) => ({ author: c.user?.login ?? null, body: clean(c.body ?? '') })),
  };
}

// ── Body input (FR-009) ────────────────────────────────────────────────────────────────────────────

/**
 * Bodies and comments come from a file or stdin. There is deliberately no `--body "text"` flag: argv is
 * visible in shell history and in a process listing, and an item body can carry anything the operator
 * pasted into the session.
 */
export function readBodyFrom(pathOrDash, { stdin } = {}) {
  let text;
  if (pathOrDash === '-') {
    text = stdin ? stdin() : readFileSync(0, 'utf8');
  } else {
    if (!existsSync(pathOrDash)) {
      throw new BacklogError(`Body file not found: ${pathOrDash}`, EXIT.usage);
    }
    text = readFileSync(pathOrDash, 'utf8');
  }
  if (!text || !text.trim().length) {
    throw new BacklogError('Refusing an empty body — an item with no context is not a backlog item.', EXIT.usage);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new BacklogError(
      `Body is larger than the 64 KB cap; shorten it or link to a document instead of pasting it.`,
      EXIT.usage,
    );
  }
  return text;
}

/**
 * The operator edited the item between our read and our write — surfaced, never silently overwritten.
 * Returns null when the timestamps match. Equal timestamps are the only safe case; anything else is
 * reported rather than reconciled, because the operator's newer intent is not ours to discard.
 */
export function describeDivergence(n, before, after) {
  if (before === after) return null;
  return (
    `⚠ item #${n} changed on the forge between read and write (${before} → ${after}). Not overwriting ` +
    `silently — re-read it with \`show ${n}\` and re-issue if the change is still wanted.`
  );
}

// ── Duplicate detection (spec Edge Cases) ──────────────────────────────────────────────────────────

const normalizeTitle = (t) => String(t).trim().toLowerCase().replace(/\s+/g, ' ');

/** Report an existing open item covering the same work instead of filing a second one. */
export function findDuplicateOpenItem(title, openItems) {
  const wanted = normalizeTitle(title);
  return openItems.find((i) => i.state === 'open' && normalizeTitle(i.title) === wanted) ?? null;
}

// ── Idempotent setup (FR-012, FR-014) ──────────────────────────────────────────────────────────────

/**
 * What is missing, and only what is missing. An existing entry is never queued: the operator may have
 * adjusted a label's colour or description in the web UI, and re-creating would silently revert it.
 */
export function planMissingNames(desired, existing) {
  const have = new Set(existing.map((e) => e.name ?? e.title));
  return desired.filter((name) => !have.has(name));
}

/**
 * Report whether the repository's issue form is actually in effect.
 *
 * MEASURED 2026-08-08, and it contradicts what this feature originally assumed: `issue_config/validate`
 * is **not** a form parser. It answered `{"valid":true,"message":""}` on a repository with ZERO templates
 * — it validates the issue *config* (blank-issues, contact links), not the YAML forms. So `valid:true`
 * alone proves nothing, and the real assertion is that `issue_templates` ENUMERATES the form.
 *
 * Also measured in the same run: the forge reads templates from the DEFAULT BRANCH only. The file existed
 * on a pushed feature branch (`contents/…?ref=<branch>` → 200) and `issue_templates` still returned
 * `null` — which is what makes the default-branch claim proven rather than merely plausible.
 */
export function describeFormValidation(templates, config) {
  const list = Array.isArray(templates) ? templates : [];
  if (!list.length) {
    return (
      'No issue form is in effect: `issue_templates` enumerates none. The forge reads ' +
      '.forgejo/issue_template/ from the DEFAULT BRANCH only (measured), so this is the expected answer ' +
      'while the form is on a feature branch — re-run after it merges. Note that ' +
      '`issue_config/validate` reporting valid is NOT evidence of a working form: it answers valid with ' +
      'zero templates present, because it validates the issue config rather than the YAML.'
    );
  }
  // Filter by TYPE, not by `id`: the forge assigns the markdown intro block `id: "0"` — a truthy string
  // — so an `if (b.id)` filter lists a meaningless "0" alongside the real sections (measured after the
  // form reached the default branch). Only these four types collect operator input.
  const COLLECTS_INPUT = new Set(['textarea', 'input', 'dropdown', 'checkboxes']);
  const described = list
    .map((t) => {
      const fields = (t.body ?? []).filter((b) => COLLECTS_INPUT.has(b.type)).map((b) => b.id);
      return `  • ${t.name ?? t.file_name ?? '(unnamed)'}${fields.length ? ` — fields: ${fields.join(', ')}` : ''}`;
    })
    .join('\n');
  const configNote =
    config && config.valid === false ? `\n⚠ issue config reports invalid: ${config.message}` : '';
  return `Issue form(s) in effect on the default branch:\n${described}${configNote}`;
}

// ── Command layer ──────────────────────────────────────────────────────────────────────────────────

const HELP = `backlog.mjs — the agent-driven backlog on this repository's forge tracker

  Reads (need MCM_FORGE_TOKEN or MCM_FORGE_ISSUE_TOKEN):
    list [--state open|closed|all] [--label L]... [--milestone M] [--q TEXT] [--page N] [--limit N] [--json]
    ready [--limit N] [--json]
    show <n> [--json]
    validate-form

  Writes (need MCM_FORGE_ISSUE_TOKEN):
    create --title T (--body-file F | --body-file -) [--label L]... [--milestone M] [--allow-duplicate]
    update <n> [--state open|closed] [--title T] [--body-file F] [--add-label L]... [--remove-label L]... [--milestone M|none]
    comment <n> --body-file F
    dep <n> (--blocked-by <m> | --blocks <m>) [--remove]
    setup-labels [--dry-run]
    setup-milestone <name> [--description D]

  Exit codes: 0 ok · 1 unexpected · 2 usage/validation · 3 missing credential · 4 authorization · 5 transport

  Measured forge behaviour this tool defends against (forge 15.0.3+gitea-1.22.0):
    - type=issues is mandatory: without it pull requests interleave (143 rows where 1 is correct)
    - a page caps at 50 rows (default 30); totals come from x-total-count, never from the row count
    - labels=<unknown> is SILENTLY IGNORED and returns the unfiltered set, so unknown names are
      refused locally instead of being sent
    - closing is a state change on update; there is no close verb
    - a blocked item cannot be closed until it is unblocked
    - issue and pull-request numbers share ONE sequence — write "item #N" when you mean a backlog item
    - Renovate owns item #29 (Dependency Dashboard); it carries status/bot-managed and is never touched
    - Projects boards expose no API in this build: labels are the shared truth, the board is not

  --repo owner/name on any write asserts the intended target against the origin remote and refuses
  a mismatch before issuing the call. Every write path is asserted at the request boundary too.

  Bodies and comments come from a file or stdin only — never argv (shell history, process listings).
  Every write is refused unless it targets the repository this working copy's origin points at.`;

function parseArgs(argv) {
  const out = { _: [], labels: [], addLabels: [], removeLabels: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new BacklogError(`${a} needs a value`, EXIT.usage);
      return v;
    };
    if (a === '--label') out.labels.push(val());
    else if (a === '--add-label') out.addLabels.push(val());
    else if (a === '--remove-label') out.removeLabels.push(val());
    else if (a === '--title') out.title = val();
    else if (a === '--body-file') out.bodyFile = val();
    else if (a === '--milestone') out.milestone = val();
    else if (a === '--state') out.state = val();
    else if (a === '--q') out.q = val();
    else if (a === '--page') out.page = Number(val());
    else if (a === '--limit') out.limit = Number(val());
    else if (a === '--blocked-by') out.blockedBy = Number(val());
    else if (a === '--blocks') out.blocks = Number(val());
    else if (a === '--description') out.description = val();
    else if (a === '--repo') out.repo = val();
    else if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--remove') out.remove = true;
    else if (a === '--allow-duplicate') out.allowDuplicate = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) throw new BacklogError(`Unknown flag: ${a}`, EXIT.usage);
    else out._.push(a);
  }
  return out;
}

const itemNumber = (raw) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new BacklogError(`Not an item number: ${raw}`, EXIT.usage);
  return n;
};

/**
 * One connection context: derived base + slug, plus the credential the operation needs.
 *
 * `intendedRepo` ("owner/name", from `--repo`) is what makes the guard real. Comparing the derived slug
 * against itself would be a tautology that protects nothing; the guard has to check a target that came
 * from somewhere else — a flag, a skill, a fan-out caller — against the origin remote.
 *
 * Belt and braces: every write path is also asserted at the request boundary, so a path-construction
 * bug cannot route a POST at another repository even with no `--repo` given.
 */
function connect({ write = false, intendedRepo } = {}) {
  const { base, owner, repo } = forgeEndpoint();
  const { token, name } = selectToken(process.env, { write });
  const origin = { owner, repo };
  if (intendedRepo) {
    const [io, ir] = String(intendedRepo).split('/');
    assertWriteTargetsOriginRepo({ owner: io, repo: ir }, origin);
  }
  const R = `/repos/${owner}/${repo}`;
  const call = (path, opts = {}) => {
    if (opts.method && opts.method !== 'GET') assertWritePathTargetsOriginRepo(path, origin);
    return forgeRequest(path, { base, token, tokenName: name, ...opts });
  };
  return { base, owner, repo, R, call, tokenName: name };
}

const fetchLabels = async (c) => (await c.call(`${c.R}/labels?page=1&limit=${PAGE_LIMIT_CAP}`)).data ?? [];
const fetchMilestones = async (c) =>
  (await c.call(`${c.R}/milestones?state=all&page=1&limit=${PAGE_LIMIT_CAP}`)).data ?? [];

async function resolveLabelIds(c, names) {
  return resolveNames(names, await fetchLabels(c), 'label').map((l) => l.id);
}

async function resolveMilestoneId(c, name) {
  if (!name || name === 'none') return name === 'none' ? 0 : undefined;
  return resolveNames([name], await fetchMilestones(c), 'milestone')[0].id;
}

const priorityOf = (item) => labelNames(item).find((n) => PRIORITY_ORDER.includes(n)) ?? '—';
const typeOf = (item) => labelNames(item).find((n) => n.startsWith('type/')) ?? '—';

function renderTable(items) {
  if (!items.length) {
    emit('(no matching backlog items)');
    return;
  }
  const w = Math.max(...items.map((i) => String(i.number).length), 3);
  for (const i of items) {
    emit(
      `#${String(i.number).padEnd(w)}  ${priorityOf(i).padEnd(12)} ${typeOf(i).padEnd(15)} ` +
        `${i.state.padEnd(6)} ${i.milestone?.title ? `[${i.milestone.title}] ` : ''}${i.title}`,
    );
  }
}

async function listItems(c, opts) {
  const labels = opts.labels?.length ? resolveNames(opts.labels, await fetchLabels(c), 'label') : [];
  if (opts.milestone) await resolveMilestoneId(c, opts.milestone);
  const q = buildIssueQuery({
    state: opts.state ?? 'open',
    labels: labels.map((l) => l.name),
    milestone: opts.milestone,
    q: opts.q,
    page: opts.page ?? 1,
    limit: opts.limit,
  });
  const { data, total } = await c.call(`${c.R}/issues?${q}`);
  return { items: data ?? [], total };
}

async function blockersFor(c, items, concurrency = 4) {
  const out = {};
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const { data } = await c.call(`${c.R}/issues/${item.number}/dependencies?page=1&limit=50`);
      out[item.number] = data ?? [];
    }
  });
  await Promise.all(workers);
  return out;
}

const COMMANDS = {
  async list(opts) {
    const c = connect();
    const { items, total } = await listItems(c, opts);
    if (opts.json) return void emit(JSON.stringify(items.map((i) => distillItem(i)), null, 2));
    renderTable(items);
    const note = describeTruncation(total, items.length);
    if (note) emit(note);
    else if (total !== null) emit(`(${total} item${total === 1 ? '' : 's'})`);
  },

  async ready(opts) {
    const c = connect();
    const { items, total } = await listItems(c, { ...opts, state: 'open', limit: opts.limit ?? PAGE_LIMIT_CAP });
    // A page caps at 50. Without this notice `ready` would silently answer from the first 50 open items,
    // so the genuinely highest-priority item could be invisible — and "what should I work on next" is
    // exactly the question where a silently partial answer is worse than no answer.
    const truncated = describeTruncation(total, items.length);
    // The label is the cheap pre-filter; only the survivors cost a dependency call.
    const preFiltered = items.filter((i) => !labelNames(i).includes('status/blocked') && !labelNames(i).includes('status/bot-managed'));
    const blockers = await blockersFor(c, preFiltered);
    const { ready, warnings } = selectReadyItems(items, blockers);
    if (opts.json) {
      return void emit(JSON.stringify({ truncated: truncated ?? null, ready: ready.map((i) => distillItem(i)) }, null, 2));
    }
    if (truncated) {
      emit(`${truncated}  ⚠ this answer is drawn from those rows only — the top priority may be outside it.`);
      emit('');
    }
    warnings.forEach(emit);
    if (warnings.length) emit('');
    renderTable(ready);
  },

  async show(opts) {
    const n = itemNumber(opts._[0]);
    const c = connect();
    const [item, comments, blockers, blocks] = await Promise.all([
      c.call(`${c.R}/issues/${n}`),
      c.call(`${c.R}/issues/${n}/comments?page=1&limit=${PAGE_LIMIT_CAP}`),
      c.call(`${c.R}/issues/${n}/dependencies?page=1&limit=${PAGE_LIMIT_CAP}`),
      c.call(`${c.R}/issues/${n}/blocks?page=1&limit=${PAGE_LIMIT_CAP}`),
    ]);
    const d = distillItem(item.data, {
      comments: comments.data ?? [],
      blockers: blockers.data ?? [],
      blocks: blocks.data ?? [],
    });
    if (opts.json) return void emit(JSON.stringify(d, null, 2));
    emit(`item #${d.number}  ${d.state}  ${d.labels.join(' ') || '(no labels)'}`);
    emit(`  ${d.title}`);
    emit(`  milestone: ${d.milestone ?? 'none (free backlog)'}   author: ${d.author}   updated: ${d.updatedAt}`);
    if (d.blockedBy.length) emit(`  blocked by: ${d.blockedBy.map((x) => `#${x}`).join(', ')}`);
    if (d.blocks.length) emit(`  blocks: ${d.blocks.map((x) => `#${x}`).join(', ')}`);
    emit('');
    emit(d.body);
    for (const cm of d.comments) {
      emit('');
      emit(`  — ${cm.author}: ${cm.body}`);
    }
  },

  async create(opts) {
    if (!opts.title?.trim()) throw new BacklogError('create needs --title', EXIT.usage);
    if (!opts.bodyFile) throw new BacklogError('create needs --body-file (a path or - for stdin)', EXIT.usage);
    const c = connect({ write: true, intendedRepo: opts.repo });
    const body = readBodyFrom(opts.bodyFile);
    const labelIds = await resolveLabelIds(c, opts.labels);
    const milestoneId = await resolveMilestoneId(c, opts.milestone);
    if (!opts.allowDuplicate) {
      const { items } = await listItems(c, { state: 'open', limit: PAGE_LIMIT_CAP });
      const dup = findDuplicateOpenItem(opts.title, items);
      if (dup) {
        throw new BacklogError(
          `An open item already covers this: item #${dup.number} "${renderLine(dup.title)}". ` +
            `Comment on it instead, or pass --allow-duplicate if this really is separate work.`,
          EXIT.usage,
        );
      }
    }
    const { data } = await c.call(`${c.R}/issues`, {
      method: 'POST',
      body: {
        title: opts.title.trim(),
        body,
        ...(labelIds.length ? { labels: labelIds } : {}),
        ...(milestoneId ? { milestone: milestoneId } : {}),
      },
    });
    emit(`created item #${data.number}`);
  },

  async update(opts) {
    const n = itemNumber(opts._[0]);
    const c = connect({ write: true, intendedRepo: opts.repo });
    const before = (await c.call(`${c.R}/issues/${n}`)).data;

    if (opts.addLabels.length) {
      await c.call(`${c.R}/issues/${n}/labels`, {
        method: 'POST',
        body: { labels: await resolveLabelIds(c, opts.addLabels) },
      });
      emit(`added ${opts.addLabels.join(', ')}`);
    }
    for (const name of opts.removeLabels) {
      const [{ id }] = resolveNames([name], await fetchLabels(c), 'label');
      await c.call(`${c.R}/issues/${n}/labels/${id}`, { method: 'DELETE' });
      emit(`removed ${name}`);
    }

    const patch = {};
    if (opts.state) patch.state = opts.state;
    if (opts.title) patch.title = opts.title;
    if (opts.bodyFile) patch.body = readBodyFrom(opts.bodyFile);
    if (opts.milestone !== undefined) patch.milestone = await resolveMilestoneId(c, opts.milestone);
    if (!Object.keys(patch).length) return;

    // The divergence check compares the item's timestamp against the one read at the start of this
    // command. It is SKIPPED when this invocation already wrote labels: our own write moved the
    // timestamp, so the comparison would report a concurrent change that never happened. (Caught while
    // writing the test for this path — `--add-label` plus `--state closed` in one invocation aborted.)
    const wroteAlready = opts.addLabels.length > 0 || opts.removeLabels.length > 0;
    if (!wroteAlready) {
      const after = (await c.call(`${c.R}/issues/${n}`)).data;
      const divergence = describeDivergence(n, before.updated_at, after.updated_at);
      if (divergence) {
        emit(divergence);
        throw new BacklogError('aborted on a concurrent change', EXIT.usage);
      }
    }

    try {
      await c.call(`${c.R}/issues/${n}`, { method: 'PATCH', body: patch });
    } catch (e) {
      throw classifyUpdateFailure(e, n);
    }
    emit(`updated item #${n}${patch.state ? ` → ${patch.state}` : ''}`);
  },

  async comment(opts) {
    const n = itemNumber(opts._[0]);
    if (!opts.bodyFile) throw new BacklogError('comment needs --body-file', EXIT.usage);
    const c = connect({ write: true, intendedRepo: opts.repo });
    await c.call(`${c.R}/issues/${n}/comments`, { method: 'POST', body: { body: readBodyFrom(opts.bodyFile) } });
    emit(`commented on item #${n}`);
  },

  async dep(opts) {
    const n = itemNumber(opts._[0]);
    const other = opts.blockedBy ?? opts.blocks;
    if (!other) throw new BacklogError('dep needs --blocked-by <m> or --blocks <m>', EXIT.usage);
    const c = connect({ write: true, intendedRepo: opts.repo });
    // `dependencies` on X records "X is blocked by Y", so `--blocks` is the same call from the other end.
    const [subject, object] = opts.blockedBy ? [n, other] : [other, n];
    if (!opts.remove) {
      // Read the existing graph for the pair before writing, so a cycle is refused at the only cheap
      // moment. Every item in a dependency cycle becomes permanently uncloseable (the forge answers 412).
      const graph = {};
      for (const num of [subject, object]) {
        graph[num] = (await c.call(`${c.R}/issues/${num}/dependencies?page=1&limit=${PAGE_LIMIT_CAP}`)).data ?? [];
      }
      if (wouldCreateCycle(subject, object, graph)) {
        throw new BacklogError(
          `Refusing to record "item #${subject} blocked by item #${object}": it would create a dependency ` +
            `cycle, and every item in a cycle becomes permanently uncloseable (the forge refuses to close ` +
            `an item with open dependencies).`,
          EXIT.usage,
        );
      }
    }
    // The body is an IssueMeta, not a bare index: `{index}` alone makes the forge try to resolve an
    // empty owner/repo and answer 404 IsErrRepoNotExist. Measured live, 2026-08-08 — the docs do not
    // say so, and the error names the repository rather than the missing fields.
    await c.call(`${c.R}/issues/${subject}/dependencies`, {
      method: opts.remove ? 'DELETE' : 'POST',
      body: { owner: c.owner, repo: c.repo, index: object },
    });
    emit(`${opts.remove ? 'removed' : 'added'}: item #${subject} blocked by item #${object}`);
  },

  async 'setup-labels'(opts) {
    const c = connect({ write: !opts.dryRun, intendedRepo: opts.repo });
    const missing = planMissingNames(TAXONOMY.map((l) => l.name), await fetchLabels(c));
    if (!missing.length) return void emit('all taxonomy labels already present — nothing to create');
    if (opts.dryRun) return void emit(`would create: ${missing.join(', ')}`);
    for (const name of missing) {
      const spec = TAXONOMY.find((l) => l.name === name);
      await c.call(`${c.R}/labels`, {
        method: 'POST',
        body: { name: spec.name, color: spec.color, description: spec.description },
      });
      emit(`created label ${name}`);
    }
    emit(`created ${missing.length} label(s); existing labels were left untouched`);
  },

  async 'setup-milestone'(opts) {
    const name = opts._[0];
    if (!name) throw new BacklogError('setup-milestone needs a name (convention: NNN-slug)', EXIT.usage);
    const c = connect({ write: true, intendedRepo: opts.repo });
    if (!planMissingNames([name], await fetchMilestones(c)).length) {
      return void emit(`milestone "${name}" already exists — nothing to create`);
    }
    await c.call(`${c.R}/milestones`, {
      method: 'POST',
      body: { title: name, ...(opts.description ? { description: opts.description } : {}) },
    });
    emit(`created milestone ${name}`);
  },

  async 'validate-form'() {
    const c = connect();
    const templates = (await c.call(`${c.R}/issue_templates`)).data;
    const config = (await c.call(`${c.R}/issue_config/validate`)).data;
    emit(describeFormValidation(templates, config));
  },
};

/**
 * A refusal to close a blocked item must be distinguishable from every other failure (FR-010).
 *
 * MEASURED live 2026-08-08 (T038, fixture at __tests__/fixtures/backlog/blocked-close-412.json): this
 * forge answers **412** with `cannot close this issue because it still has open dependencies`. The match
 * stays broad on the message rather than keying on 412 alone — a future build could change either — and
 * the original response is always preserved rather than replaced, so a near-miss is still diagnosable.
 */
export function classifyUpdateFailure(error, n) {
  if (/dependenc|blocked|blocking/i.test(error.message)) {
    return new BacklogError(
      `Item #${n} is BLOCKED and cannot be closed until its blockers are resolved — unblock it first ` +
        `(\`dep ${n} --blocked-by <m> --remove\`, or close the blocker). The item is unchanged. ` +
        `Original response: ${error.message}`,
      EXIT.usage,
    );
  }
  return error;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const command = opts._.shift();
  if (opts.help || !command) {
    emit(HELP);
    return EXIT.ok;
  }
  const run = COMMANDS[command];
  if (!run) {
    emit(`Unknown command: ${command}`);
    emit(HELP);
    return EXIT.usage;
  }
  await run(opts);
  return EXIT.ok;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('backlog.mjs');
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      emit(e instanceof BacklogError ? e.message : `Unexpected: ${e?.stack ?? e}`);
      process.exit(e instanceof BacklogError ? e.code : EXIT.unexpected);
    });
}
