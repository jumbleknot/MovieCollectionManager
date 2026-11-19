// The forge's WRITE credential, the one `git credential fill` returns for origin, obtained in one place.
//
// WHY THIS IS A MODULE AND NOT A RECIPE (item #1072). Opening, merging or dispatching used to mean
// re-typing `printf 'protocol=…\nhost=…' | git credential fill` by hand. On 2026-11-19 a session
// re-used a copy with `protocol=https` hard-coded. Origin is `http://` and the forge on :3000 speaks
// only HTTP. The helper returned an EMPTY password, the host's Git Credential Manager reported "The
// handshake failed due to an unexpected packet format", and the session told the operator their
// credential helper was broken. It wasn't. The scheme it had typed was the fault. A rule kept only as
// prose has to be read every time, so the rule now lives here: the scheme and host are READ from
// origin and never typed, and an empty password fails HERE, naming what was asked, instead of turning
// into a 401 or 404 three calls later.
//
// WHICH CREDENTIAL. This is the write-capable, repository-scoped credential: it can open and merge PRs
// and dispatch workflows. It is NOT `MCM_FORGE_TOKEN` (read-only; 403s on POST /pulls), and it can't
// read issue comments or packages (`ci-status.mjs` header). The token never touches argv, stdout or
// a file. It goes from the helper's stdout to an Authorization header and nowhere else.

import { execFileSync } from 'node:child_process';

export class ForgeCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForgeCredentialError';
  }
}

/**
 * Split an origin URL into what the API and the credential helper need.
 *
 * Only `http://` and `https://` are accepted, and the scheme is taken AS WRITTEN. An scp-style or
 * ssh origin has no HTTP API base to derive, and guessing `https` for it is the exact mistake this
 * module exists to stop. Embedded userinfo (`http://user@host/…`) is dropped: the helper is keyed on
 * host, and the API base must never carry a name.
 *
 * @returns {{scheme: 'http'|'https', host: string, apiBase: string, owner: string, repo: string}}
 */
export function parseOrigin(origin) {
  const m = String(origin ?? '')
    .trim()
    .replace(/\.git$/, '')
    .match(/^(https?):\/\/(?:[^@/]*@)?([^/@]+)\/([^/]+)\/([^/]+)\/?$/);
  if (!m) {
    throw new ForgeCredentialError(
      `origin is not an http(s) forge URL, so there is no API to talk to and no scheme to ask the ` +
        `credential helper about: ${JSON.stringify(String(origin ?? ''))}`,
    );
  }
  const [, scheme, host, owner, repo] = m;
  return { scheme, host, apiBase: `${scheme}://${host}/api/v1`, owner, repo };
}

/** The exact stdin `git credential fill` gets, built from the parsed origin. */
export function credentialQuery({ scheme, host }) {
  return `protocol=${scheme}\nhost=${host}\n\n`;
}

/** The real helper call. GIT_TERMINAL_PROMPT=0 so a missing credential fails instead of hanging a session on a prompt. */
function gitCredentialFill(input) {
  return execFileSync('git', ['credential', 'fill'], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** `git remote get-url origin`, the one source of the scheme. */
export function readOrigin() {
  return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
}

/**
 * The write token for origin's forge. Throws ForgeCredentialError, never returns '', when the helper
 * gives nothing.
 *
 * @param {{origin?: string, fill?: (input: string) => string}} [deps] injected for tests
 */
export function forgeWriteToken({ origin = readOrigin(), fill = gitCredentialFill } = {}) {
  const parsed = parseOrigin(origin);
  const query = credentialQuery(parsed);
  const asked = `protocol=${parsed.scheme} host=${parsed.host}`;
  let reply;
  try {
    reply = fill(query);
  } catch (err) {
    // The helper's stderr can be a TLS error that points at the wrong layer, as on 2026-11-19.
    // Lead with what was ASKED, so a scheme mismatch is the first thing the reader can check.
    throw new ForgeCredentialError(
      `git credential fill failed for ${asked} (read from origin).\n` +
        `helper said: ${String(err?.stderr || err?.message || err).trim().split('\n')[0]}\n` +
        remedy(parsed),
    );
  }
  const password = String(reply ?? '')
    .split('\n')
    .find((l) => l.startsWith('password='))
    ?.slice('password='.length)
    .replace(/\r$/, '');
  if (!password) {
    throw new ForgeCredentialError(
      `git credential fill returned NO password for ${asked} (read from origin).\n` + remedy(parsed),
    );
  }
  return password;
}

function remedy({ scheme, host }) {
  return (
    `The scheme and host above came from \`git remote get-url origin\`, not from a typed command, so a ` +
    `scheme mismatch is not the cause here. Check that a credential is stored for ${scheme}://${host}. ` +
    `In the dev container that needs VS Code attached (its credential-helper proxy); without it, push ` +
    `the branch and use the web UI (docs/runbooks/ci-diagnostics.md, "Opening a pull request").`
  );
}
