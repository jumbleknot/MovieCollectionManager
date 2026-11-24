// Renovate's permitted window, derived from renovate.json and evaluated at one real instant.
//
// Moved here from check-lockfile-refresh.mjs when item #1124 retired that check: the Renovate run's
// own verdict (scripts/renovate-verdict.mjs) and the weekly health digest (scripts/renovate-health.mjs)
// both need "was this moment inside the lockFileMaintenance window?", and two copies of a cron
// evaluator is how the #153 class (a cron and a window that never intersect) comes back.

/** Expand a cron field over `min..max`. `*`, `N`, `A-B` and comma lists only — anything else throws. */
export function expandCronField(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    if (part === '*') for (let v = min; v <= max; v += 1) out.add(v);
    else if (/^\d+$/.test(part)) out.add(Number(part));
    else if (/^\d+-\d+$/.test(part)) {
      const [lo, hi] = part.split('-').map(Number);
      for (let v = lo; v <= hi; v += 1) out.add(v);
    } else throw new Error(`unsupported cron field '${part}' — extend expandCronField before using it`);
  }
  return out;
}

/**
 * The lockFileMaintenance window, DERIVED from renovate.json rather than restated — if the schedule
 * moves, every consumer moves with it. `lockFileMaintenance`'s own schedule wins over the inherited
 * top-level one, which is how Renovate resolves it (and is why that key is load-bearing).
 */
export function parseWindow(config) {
  const schedules = config?.lockFileMaintenance?.schedule ?? config?.schedule ?? [];
  if (!schedules.length) throw new Error('renovate.json carries no schedule for lockFileMaintenance');
  const hours = new Set();
  const dow = new Set();
  for (const expr of schedules) {
    const f = String(expr).trim().split(/\s+/);
    if (f.length !== 5) throw new Error(`expected a 5-field cron, got '${expr}'`);
    if (f[0] !== '*' || f[2] !== '*' || f[3] !== '*') {
      throw new Error(`only minute/day-of-month/month '*' are supported, got '${expr}'`);
    }
    for (const h of expandCronField(f[1], 0, 23)) hours.add(h);
    for (const d of expandCronField(f[4], 0, 6)) dow.add(d);
  }
  return { timezone: config?.timezone ?? 'UTC', hours, dow };
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Is `iso` inside the window, in the window's OWN timezone?
 *
 * Evaluated with `Intl` against the specific instant, deliberately: unlike the workflow guard — which
 * hard-codes both offsets because it must check both halves of the year at once — this asks about one
 * real timestamp, so the offset actually in force at that moment is the correct one.
 */
export function inWindow(iso, window) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: window.timezone, hourCycle: 'h23', hour: '2-digit', weekday: 'short',
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const day = DOW[parts.find((p) => p.type === 'weekday')?.value];
  return window.hours.has(hour) && window.dow.has(day);
}
