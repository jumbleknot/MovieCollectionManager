// Feature 071 / item #439 — provisioning scripts must not PRINT the credentials they provision.
//
// WHAT HAPPENED. `init-audit-user.sh` ended with:
//
//     echo "  Admin:         ${ADMIN_USER} / ${ADMIN_PASS}"
//     echo "  Write-only:    agent-audit / ${AUDIT_PASS}"
//
// which is a direct violation of the never-log list in openwiki/invariants/logging-and-audit.md
// ("Never log, anywhere in the stack: raw tokens, session IDs, passwords ..."). It was harmless when the
// script was a DEV convenience run by hand. It stopped being harmless the moment `agent-audit-init` began
// running it in PRODUCTION — the output goes to container stdout, so both live credentials sat in
// `docker logs`, in Komodo's log view, and in anything shipping those logs.
//
// Nothing caught it. It was found by eye, on 2026-09-13, while reading those logs for an unrelated reason.
// This test is so the next one is caught by CI instead.
//
// NOT flagged: piping a secret into a command's stdin (`echo "$TOKEN" | docker login --password-stdin`).
// That is the CORRECT way to pass a credential — it keeps it out of process args — and scan-push.sh does
// exactly that. The rule is about secrets reaching a LOG, not about secrets reaching a program.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET_VAR = /\$\{?[A-Za-z_]*(PASS|PASSWD|PASSWORD|SECRET|TOKEN|APIKEY|API_KEY)[A-Za-z_]*\}?/;

const shellScripts = () =>
  globSync('{infrastructure-as-code,scripts}/**/*.sh', { cwd: REPO_ROOT })
    .filter((p) => !p.includes('node_modules'));

test('no shell script echoes a secret-named variable to stdout (item #439)', () => {
  const hits = [];
  for (const rel of shellScripts()) {
    const lines = readFileSync(resolve(REPO_ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.split('#')[0];                    // ignore comments, including this rule's own prose
      if (!/^\s*echo\b/.test(code)) return;
      if (!SECRET_VAR.test(code)) return;
      // Piping into a command's stdin is the CORRECT way to hand over a credential — not a log leak.
      if (/\|\s*\S/.test(code)) return;
      hits.push(`  ${rel}:${i + 1}  ${code.trim().slice(0, 100)}`);
    });
  }

  assert.deepEqual(
    hits,
    [],
    'Shell script(s) echo a secret-named variable, which puts the value in container logs, CI logs and\n' +
      'anything shipping them — the never-log list forbids it:\n' +
      hits.join('\n') +
      '\n  Print WHERE the credential lives (the env var name, the Komodo Variable), never WHAT it is.\n' +
      '  If you are piping it into a command (`| docker login --password-stdin`), that is fine and this\n' +
      '  guard already allows it.',
  );
});
