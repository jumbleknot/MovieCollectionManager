// Feature 068 / US2 — every @mcp.tool() declares a PRECISE return annotation.
//
// Contract: specs/068-mcp-2x-migration/contracts/mcp-tool-result.md §2 (INV-5).
//
// This is not style. Measured against a real mcp 2.2.0 install:
//
//   dict[str, Any]        -> structured_content is the mapping          (same as 1.x)
//   list[dict[str, Any]]  -> structured_content is {"result": [...]}    (same as 1.x)
//   bare `dict`           -> structured_content is None                 <-- SILENT LOSS
//
// A tool loosened to a bare `dict` would still return its text content, so nothing raises and no
// existing test fails — the assistant just stops receiving structured data. All 15 tools comply
// today; this guard is what keeps that true.
//
// It parses the decorator/signature structurally rather than by regex on purpose: a decorator and
// its signature span lines, and a regex over `@mcp.tool()` followed by `def` was measured finding
// only 7 of 9 tools in movie-mcp and 2 of 4 in spreadsheet-mcp — a guard that silently checks
// two-thirds of the surface is worse than none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

export const MCP_SERVERS = ['movie-mcp', 'spreadsheet-mcp', 'web-api-mcp'];
const IMPRECISE = new Set(['dict', 'list', 'Any', 'object', 'tuple', 'set', '']);

/**
 * Tool name -> return annotation, read from the module's structure.
 *
 * Walks balanced parentheses from the `def` to its `->`, so a multi-line parameter list (which the
 * naive regex choked on) is handled.
 */
export function toolReturnAnnotations(source) {
  const out = [];
  const decorator = /@mcp\.tool\(\s*\)\s*\n\s*(?:async\s+)?def\s+(\w+)\s*\(/g;
  let m;
  while ((m = decorator.exec(source)) !== null) {
    const name = m[1];
    let i = decorator.lastIndex - 1; // at the opening '('
    let depth = 0;
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
    }
    const tail = source.slice(i, source.indexOf('\n', source.indexOf(':', i)) + 1);
    const arrow = tail.match(/->\s*([^:]+):/);
    out.push({ name, annotation: arrow ? arrow[1].trim() : '' });
  }
  return out;
}

export function imprecise(annotations) {
  return annotations.filter((a) => IMPRECISE.has(a.annotation));
}

test('feature 068: every @mcp.tool() declares a precise return annotation (contract INV-5)', () => {
  let total = 0;
  for (const server of MCP_SERVERS) {
    const src = readFileSync(resolve(REPO_ROOT, `mcp-servers/${server}/src/server.py`), 'utf8');
    const anns = toolReturnAnnotations(src);
    assert.ok(anns.length > 0, `${server}: found no @mcp.tool() functions — the parser is broken, not the server`);
    total += anns.length;
    const bad = imprecise(anns);
    assert.deepEqual(
      bad, [],
      `${server}: ${bad.map((b) => `${b.name} -> ${b.annotation || '(none)'}`).join(', ')} — a bare ` +
      `dict/list/Any return yields structured_content: None on mcp 2.x, silently. Annotate precisely ` +
      `(e.g. dict[str, Any] or list[dict[str, Any]]).`,
    );
  }
  // Guards the guard: if a refactor moves tools out of server.py, the loop above would pass vacuously.
  assert.equal(total, 15, `expected 15 MCP tools across the three servers, parsed ${total}`);
});

test('feature 068: the annotation parser handles a MULTI-LINE signature (regex did not)', () => {
  const src = [
    '@mcp.tool()',
    'async def list_movies(',
    '    collectionId: str,  # noqa: N803',
    '    limit: int = 20,',
    ') -> dict[str, Any]:',
    '    """doc."""',
  ].join('\n');
  assert.deepEqual(toolReturnAnnotations(src), [{ name: 'list_movies', annotation: 'dict[str, Any]' }]);
});

test('feature 068: a bare `dict` return IS caught (the silent-loss case)', () => {
  const src = '@mcp.tool()\nasync def bad() -> dict:\n    """doc."""\n';
  assert.deepEqual(imprecise(toolReturnAnnotations(src)), [{ name: 'bad', annotation: 'dict' }]);
});

// ── Transport configuration must reach streamable_http_app() on EVERY server ────────────────────
//
// Contract: specs/068-mcp-2x-migration/contracts/mcp-tool-result.md §4 (INV-10, INV-11).
//
// mcp 2.x moved `stateless_http`, `json_response` and `transport_security` off the constructor and
// onto `streamable_http_app()`. Miss them on one server and the SDK's auto-enable branch fires:
//
//     if transport_security is None and host in ("127.0.0.1", "localhost", "::1"):
//         transport_security = TransportSecuritySettings(...)   # DNS-rebinding protection ON
//
// ...which 421-rejects a Docker service-name Host and breaks every containerized gateway->MCP call.
//
// This guard exists because that is EXACTLY what happened: web-api-mcp wraps its app in
// `TmdbKeyMiddleware(...)` — a third wrapper the migration's edit did not match — so it kept a bare
// `streamable_http_app()` while the other two were converted. Nothing caught it: the unit tiers
// never call build_app(), and the integration suites drive the server in-memory via Client(mcp),
// which never goes through the HTTP app at all. It surfaced only in CI, as
// `gateway -> web-api-mcp returned 421`.

export function streamableHttpAppCalls(source) {
  const out = [];
  const re = /\bmcp\.streamable_http_app\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    let i = re.lastIndex - 1;
    let depth = 0;
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
    }
    out.push(source.slice(m.index, i));
  }
  return out;
}

test('feature 068: every server passes the transport config to streamable_http_app (INV-10/INV-11)', () => {
  for (const server of MCP_SERVERS) {
    const src = readFileSync(resolve(REPO_ROOT, `mcp-servers/${server}/src/server.py`), 'utf8');
    const calls = streamableHttpAppCalls(src);
    assert.equal(calls.length, 1, `${server}: expected exactly one streamable_http_app() call, found ${calls.length}`);
    const [call] = calls;
    for (const kwarg of ['transport_security', 'stateless_http', 'json_response']) {
      assert.ok(
        call.includes(kwarg),
        `${server}: streamable_http_app() does not pass \`${kwarg}\`. On mcp 2.x these are app ` +
        `parameters, not constructor kwargs — omitting transport_security auto-enables ` +
        `DNS-rebinding protection, which 421-rejects the Docker service-name Host the gateway uses.`,
      );
    }
  }
});

test('feature 068: the call parser survives a middleware-wrapped app (the case that was missed)', () => {
  const wrapped = 'def build_app():\n    return TmdbKeyMiddleware(mcp.streamable_http_app(\n        stateless_http=True,\n    ))\n';
  const [call] = streamableHttpAppCalls(wrapped);
  assert.ok(call.includes('stateless_http'));
});
