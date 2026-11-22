// Feature 105 US4 — efficiency rules against the developer's own baseline (FR-028–FR-031; data-model.md
// `findings`). Pure: the baseline (v_baseline), the recent sessions' metrics (v_session_metrics, the last
// week) and the age of the data in. A rule fires for an activity when its recent median is beyond the
// baseline's p90 (p10 where lower is worse), with enough samples and at least 14 days of data (FR-029).
// Every finding names its watch metric and a quality counter-metric (FR-031). Suggestions are fixed text
// worded as hypotheses (FR-030), never generated.

export const MIN_DATA_DAYS = 14;
export const CONFIRM_WINDOW_DAYS = 7;
const DAY = 86_400_000;

const rule = (id, metric, direction, suggestion, { min_n = 10, counter_metric = 'rework_share', scope = 'activity' } = {}) =>
  ({ id, metric, direction, suggestion, min_n, counter_metric, watch_metric: metric, scope });

export const RULES = [
  rule('weighted-tokens', 'weighted_tokens', 'high', 'Sessions of this kind cost more than usual lately. Could a narrower task framing, or starting a fresh session per task, bring them back down?'),
  rule('tokens-per-merged-pr', 'tokens_per_merged_pr', 'high', 'Recent merged features took more weighted tokens per PR than usual. Might smaller PRs, or settling the plan before implementing, help?', { min_n: 5, counter_metric: 'ci_first_pass_rate', scope: 'features' }),
  rule('rework-share', 'rework_share', 'high', 'More tokens than usual went into work after a red CI run. Could running the tiers the diff touches before pushing catch these earlier?', { counter_metric: 'ci_first_pass_rate' }),
  rule('session-floor', 'floor_tokens', 'high', 'The context at the first turn is higher than usual. If always-loaded context (instruction files, MCP tool schemas, memory) grew, could trimming it lower the floor?'),
  rule('cache-read-ratio', 'cache_read_ratio', 'low', 'Less of the context is being read from cache than usual. Might edits to always-loaded files mid-session, or long pauses, be invalidating it?'),
  rule('idle-tax', 'idle_tax', 'high', 'More cache writes than usual follow idle gaps of over 5 minutes, which rebuild the context. Could ending a session before a break, or a /compact first, help?'),
  rule('context-growth', 'context_growth', 'high', 'Context grows further within a session than usual. Might a /compact or a fresh session at natural break points keep it smaller?'),
  rule('compactions', 'compactions', 'high', 'Sessions compact more often than usual. Could splitting the work into smaller sessions avoid repeated compaction?'),
  rule('tool-output-weight', 'tool_output_bytes', 'high', 'Tool outputs per turn are larger than usual. Could narrower commands (a filter, --quiet, reading a range instead of a whole file) cut them?'),
  rule('compression-share', 'rtk_share', 'low', 'Fewer Bash calls than usual went through RTK compression. Is the RTK hook still active for the commands now being run?'),
  rule('reread-rate', 'reread_rate', 'high', 'Files are re-read more often than usual. Might keeping a short note of what a file says, or reading the relevant range once, help?'),
  rule('subagent-return', 'subagent_share', 'high', 'Subagents take a larger share of tokens than usual. Could some delegated searches be done directly, or briefed more narrowly?', { counter_metric: 'ci_first_pass_rate' }),
  rule('model-mix', 'premium_share', 'high', 'A larger share than usual of tokens went to the premium model on this kind of work. If the work is mostly low-judgment, might a smaller model do?'),
  rule('plan-limit-burn', 'limit_burn', 'high', 'This kind of work burns more of the plan limit than usual. Could it be scheduled away from limit-heavy periods, or made lighter?', { min_n: 5 }),
];

const HIGHER_IS_WORSE = { rework_share: true, ci_first_pass_rate: false };

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Monday (UTC) of the week containing `now`, YYYY-MM-DD. */
function weekStart(now) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Deterministic: the same rule, scope and week give the same id, so re-running analysis upserts. */
export function findingId(ruleId, scope, now) {
  return `${ruleId}:${scope}:${weekStart(now)}`;
}

/**
 * @param {{baseline: object[], recent: object[], dataDays: number, now: number}} input
 * @returns {{findings: object[], notEnough: object[]}}
 */
export function evaluateRules({ baseline, recent, dataDays, now }) {
  if (!(dataDays >= MIN_DATA_DAYS)) return { findings: [], notEnough: [{ reason: 'baseline under 14 days', data_days: dataDays ?? 0 }] };
  const findings = [];
  const notEnough = [];
  for (const r of RULES) {
    for (const b of baseline.filter((x) => x.metric === r.metric)) {
      const n = Number(b.n);
      if (n < r.min_n) {
        notEnough.push({ rule: r.id, metric: r.metric, activity: b.activity, n, reason: `n ${n} < ${r.min_n}` });
        continue;
      }
      const rows = recent.filter((x) => x.activity === b.activity && x[r.metric] !== null && x[r.metric] !== undefined);
      if (!rows.length) continue;
      const values = rows.map((x) => Number(x[r.metric]));
      const rm = median(values);
      const high = r.direction === 'high';
      const limit = Number(high ? b.p90 : b.p10);
      if (!Number.isFinite(limit) || !(high ? rm > limit : rm < limit)) continue;
      const scope = r.scope === 'features' ? 'features' : `activity:${b.activity}`;
      findings.push({
        finding_id: findingId(r.id, scope, now),
        rule: r.id,
        scope,
        evidence: {
          metric: r.metric,
          recent_median: rm,
          recent_n: rows.length,
          baseline_median: Number(b.median),
          [high ? 'baseline_p90' : 'baseline_p10']: limit,
          sample_size: n,
          sessions: rows.filter((x) => (high ? Number(x[r.metric]) > limit : Number(x[r.metric]) < limit)).map((x) => x.session_id),
        },
        sample_size: n,
        suggestion: r.suggestion,
        watch_metric: r.watch_metric,
        counter_metric: r.counter_metric,
        status: 'open',
      });
    }
  }
  return { findings, notEnough };
}

/**
 * The experiment's state (data-model.md `findings.status`). Only an accepted finding moves: a worse
 * counter-metric is a regression whatever the watch metric did (FR-031); a better watch metric with the
 * counter not worse, once the window has elapsed, is confirmed.
 */
export function nextStatus(f, { after, counterAfter, now }) {
  if (f.status !== 'accepted') return f.status;
  const counterWorseIfHigher = HIGHER_IS_WORSE[f.counter_metric ?? 'rework_share'] ?? true;
  const cb = f.counter_baseline;
  if (cb !== null && cb !== undefined && counterAfter !== null && counterAfter !== undefined) {
    if (counterWorseIfHigher ? counterAfter > cb : counterAfter < cb) return 'regressed';
  }
  const r = RULES.find((x) => x.metric === f.watch_metric);
  const improved = after !== null && after !== undefined && (r?.direction === 'low' ? after > f.baseline_value : after < f.baseline_value);
  const elapsed = now - Date.parse(f.accepted_at) >= CONFIRM_WINDOW_DAYS * DAY;
  return improved && elapsed ? 'confirmed' : 'accepted';
}
