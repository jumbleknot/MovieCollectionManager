// Transcript file layout under a CLAUDE_CONFIG_DIR (feature 105, research R3/R4): IO only, no parsing
// rules. projects/<projectDir>/<sessionId>.jsonl is the main transcript;
// projects/<projectDir>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json) are its subagents.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeSession } from './parse-transcript.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every session under `configDir/projects`, across EVERY project directory (research R4). */
export function listSessions(configDir) {
  const root = join(configDir, 'projects');
  if (!existsSync(root)) return [];
  const out = [];
  for (const projectDir of readdirSync(root).sort()) {
    const dir = join(root, projectDir);
    let names;
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const ids = new Set();
    for (const n of names) {
      const id = n.endsWith('.jsonl') ? n.slice(0, -'.jsonl'.length) : n;
      if (UUID.test(id)) ids.add(id);
    }
    for (const sessionId of [...ids].sort()) out.push({ projectDir, sessionId, ...sessionPaths(configDir, projectDir, sessionId) });
  }
  return out;
}

/** Paths of one session's files (main may not exist). */
export function sessionPaths(configDir, projectDir, sessionId) {
  const dir = join(configDir, 'projects', projectDir);
  const main = join(dir, `${sessionId}.jsonl`);
  const subDir = join(dir, sessionId, 'subagents');
  const subagents = [];
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir).filter((n) => /^agent-.+\.meta\.json$/.test(n)).sort()) {
      const agentId = f.slice('agent-'.length, -'.meta.json'.length);
      subagents.push({ agentId, metaPath: join(subDir, f), transcriptPath: join(subDir, `agent-${agentId}.jsonl`) });
    }
    // A subagent transcript without a meta file still counts (its parent turn is then unknown).
    for (const f of readdirSync(subDir).filter((n) => /^agent-.+\.jsonl$/.test(n)).sort()) {
      const agentId = f.slice('agent-'.length, -'.jsonl'.length);
      if (!subagents.some((s) => s.agentId === agentId)) subagents.push({ agentId, metaPath: null, transcriptPath: join(subDir, f) });
    }
  }
  return { mainPath: main, subagents };
}

const readOrNull = (p) => (p && existsSync(p) ? readFileSync(p) : null);
const jsonOrNull = (p) => {
  try {
    return p ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};

/** Read and summarize one session in a single pass. */
export function readSession(configDir, projectDir, sessionId) {
  const { mainPath, subagents } = sessionPaths(configDir, projectDir, sessionId);
  return summarizeSession({
    sessionId,
    projectDir,
    main: readOrNull(mainPath),
    subagents: subagents.map((s) => ({ agentId: s.agentId, meta: jsonOrNull(s.metaPath), transcript: readOrNull(s.transcriptPath) })),
  });
}

/** Per-session token totals in the oracle's shape (main + subagents), for sessions with a main transcript. */
export function sessionTotals(configDir) {
  const out = {};
  for (const { projectDir, sessionId } of listSessions(configDir)) {
    const s = readSession(configDir, projectDir, sessionId);
    if (s.session.capture_status === 'not_captured') continue;
    const sum = (f) => s.modelCalls.reduce((n, c) => n + f(c), 0);
    out[sessionId] = {
      input: sum((c) => c.input_tokens),
      output: sum((c) => c.output_tokens),
      cache_write: sum((c) => c.cache_write_5m_tokens + c.cache_write_1h_tokens),
      cache_read: sum((c) => c.cache_read_tokens),
    };
  }
  return out;
}
