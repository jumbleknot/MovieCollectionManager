// Feature 105 US3 — one activity label per turn (data-model.md "Labelling"; FR-023, FR-024).
// Rules run IN ORDER and the first match wins; each has a stable id stored in `turns.activity_rule`.
// The inputs (command text, paths) exist only in the container; the signals here are already reduced
// to skill names, top-level areas and tags, and only the label and rule id ship.

const SPECKIT = { 'speckit-specify': 'specify', 'speckit-clarify': 'clarify', 'speckit-plan': 'plan', 'speckit-tasks': 'tasks', 'speckit-analyze': 'analyze' };
const CODE_AREAS = new Set(['frontend', 'backend', 'agents', 'mcp-servers']);
const INFRA_AREAS = new Set(['.devcontainer', 'infrastructure-as-code']);
const DOC_AREAS = new Set(['docs', 'openwiki']);
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'ToolSearch', 'TodoWrite', 'TaskList', 'TaskGet']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The words of a command after a `cd … &&` prefix, env assignments and wrapper words. */
function words(command) {
  let w = String(command ?? '').trim().split(/\s+/).filter(Boolean);
  const amp = w.lastIndexOf('&&');
  if (w[0] === 'cd' && amp !== -1) w = w.slice(amp + 1);
  while (w.length && (ASSIGNMENT.test(w[0]) || ['rtk', 'sudo', 'env', 'time', 'npx', 'exec'].includes(w[0]))) w.shift();
  return w;
}

/** Tags of one Bash command, from its text (never shipped): test | ci | backlog | forge-pr | git | infra. */
export function bashTags(command) {
  const text = String(command ?? '');
  const w = words(text);
  const tags = [];
  const s = w.join(' ');
  if (/\bnx\s+(run\s+\S+:)?(test|e2e)\b|\bnx\s+run-many\b.*(-t|--targets?)[= ](test|e2e)|\bnx\s+affected\b.*(-t|--targets?)[= ](test|e2e)|\bnx\s+(test|e2e)(:\S+)?\b|^playwright\b|\bplaywright\s+test\b|^maestro\b|\bcargo\s+(nextest|test)\b|\bnode\s+(--\S+\s+)*--test\b/.test(s)) tags.push('test');
  if (/\bci-status\.mjs\b|\bci-failure-digest\.mjs\b/.test(s)) tags.push('ci');
  if (/\bbacklog\.mjs\b/.test(s)) tags.push('backlog');
  if (/\bforge-pr\.mjs\b/.test(s)) tags.push('forge-pr');
  if (w[0] === 'git') tags.push('git');
  if (['docker', 'docker-compose', 'compose', 'sbx'].includes(w[0])) tags.push('infra');
  return tags;
}

/**
 * @param {{skills: string[], editAreas: string[], bash: {family: string, tags: string[]}[], tools: string[]}} s
 * @returns {{activity: string, activity_rule: string}}
 */
export function labelActivity(s) {
  const skills = new Set(s.skills ?? []);
  const edit = new Set(s.editAreas ?? []);
  const bash = s.bash ?? [];
  const tools = s.tools ?? [];
  const tagged = (t) => bash.some((b) => b.tags?.includes(t));
  const hit = (activity, activity_rule) => ({ activity, activity_rule });

  for (const [skill, label] of Object.entries(SPECKIT)) if (skills.has(skill)) return hit(label, 'speckit-skill');
  if (skills.has('speckit-implement')) return hit('implement', 'implement-skill');
  if ([...edit].some((a) => CODE_AREAS.has(a))) return hit('implement', 'implement-edit');
  if (tagged('test')) return hit('test', 'test-tier');
  if (tagged('ci')) return hit('ci-diagnosis', 'ci-diagnosis');
  if (tagged('infra')) return hit('infra', 'infra-command');
  if ([...edit].some((a) => INFRA_AREAS.has(a))) return hit('infra', 'infra-edit');
  if ([...edit].some((a) => DOC_AREAS.has(a))) return hit('docs', 'docs-edit');
  if (skills.has('wiki-refresh')) return hit('docs', 'docs-skill');
  if (tagged('backlog')) return hit('backlog', 'backlog-command');
  if (skills.has('forgejo-issues')) return hit('backlog', 'backlog-skill');
  if (tools.length > 0 && tools.every((t) => t === 'Bash') && bash.length > 0 && bash.every((b) => b.tags?.includes('git') || b.tags?.includes('forge-pr'))) return hit('git', 'git-only');
  if (tools.length > 0 && tools.every((t) => READ_ONLY_TOOLS.has(t))) return hit('explore', 'read-only');
  if (tools.length === 0) return hit('conversation', 'no-tools');
  return hit('unclassified', 'unclassified');
}
