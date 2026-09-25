# Quickstart — reproducing the bundle measurement

## Export the web bundle

```bash
cd frontend/mcm-app
npx expo export --platform web --source-maps --output-dir /tmp/dist-check
ls -l /tmp/dist-check/client/_expo/static/js/web/
```

The entry chunk is `entry-<hash>.js`. After this feature there is also a second chunk for the
deferred assistant runtime. **A single chunk means the deferral has regressed.**

`luxon` is declared by `frontend/mcm-app/package.json` — if the export fails with
`Unable to resolve module luxon`, the workspace install is stale: run
`CI=true pnpm install --frozen-lockfile` from the repository root. (This cost one session a
false "main is broken" conclusion.)

## Check the budget

```bash
pnpm nx bundle-budget mcm-app          # exports if needed, then checks
node scripts/check-web-bundle-budget.mjs --dist frontend/mcm-app/dist   # against an existing export
node scripts/check-web-bundle-budget.mjs --selftest                     # prove the gate fails and passes
```

## Attribute bytes to packages

Save as `/tmp/attribute.mjs` and run
`node /tmp/attribute.mjs /tmp/dist-check/client/_expo/static/js/web/entry-*.js.map package 30`.
The third argument groups by `package`, `area` or `file`; the fourth limits rows.

```js
import { readFileSync } from 'node:fs';
const mapPath = process.argv[2], groupTo = process.argv[3] ?? 'package';
const m = JSON.parse(readFileSync(mapPath, 'utf8'));
const jsPath = mapPath.replace(/\.map$/, '');
const lines = readFileSync(jsPath, 'utf8').split('\n');
const B64 = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));
function decodeVlq(str) {
  const out = []; let shift = 0, value = 0;
  for (const c of str) {
    const d = B64.get(c);
    value += (d & 31) << shift;
    if (d & 32) { shift += 5; continue; }
    const neg = value & 1; value >>= 1;
    out.push(neg ? -value : value); shift = 0; value = 0;
  }
  return out;
}
const bytes = new Map();
let srcIdx = 0;
const glines = m.mappings.split(';');
for (let gl = 0; gl < glines.length; gl++) {
  const segs = glines[gl].split(',').filter(Boolean);
  let gcol = 0; const spans = [];
  for (const s of segs) {
    const f = decodeVlq(s);
    gcol += f[0];
    if (f.length >= 4) { srcIdx += f[1]; spans.push([gcol, srcIdx]); } else spans.push([gcol, null]);
  }
  const lineLen = (lines[gl] ?? '').length;
  for (let i = 0; i < spans.length; i++) {
    const [c, si] = spans[i];
    if (si === null) continue;
    const end = i + 1 < spans.length ? spans[i + 1][0] : lineLen;
    const src = m.sources[si] ?? '<unknown>';
    bytes.set(src, (bytes.get(src) ?? 0) + Math.max(0, end - c));
  }
}
function key(src) {
  if (groupTo === 'file') return src;
  const nm = src.lastIndexOf('node_modules/');
  if (nm === -1) return 'APP: ' + src.replace(/^.*?\/mcm-app\//, 'mcm-app/');
  const parts = src.slice(nm + 'node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
const agg = new Map();
for (const [src, n] of bytes) agg.set(key(src), (agg.get(key(src)) ?? 0) + n);
const total = [...agg.values()].reduce((a, b) => a + b, 0);
console.log(`attributed ${(total / 1024).toFixed(0)} KB of ${(readFileSync(jsPath).length / 1024).toFixed(0)} KB`);
for (const [k, n] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[4] ?? 40)))
  console.log(`${(n / 1024).toFixed(0).padStart(7)} KB  ${(100 * n / total).toFixed(1).padStart(5)}%  ${k}`);
```

## Confirm a package left the entry chunk

```bash
node -e "
const g=require('glob'),fs=require('fs');
const m=JSON.parse(fs.readFileSync(g.sync('/tmp/dist-check/client/_expo/static/js/web/entry-*.js.map')[0],'utf8'));
for (const p of ['text-encoding','zod','graphql','luxon','bff-server'])
  console.log(p, m.sources.filter(s=>s.includes(p)).length);
"
```

All five must print `0` after this feature.

## Measure cold TTI the way the gate does

```bash
pnpm nx e2e mcm-app -- --grep "bundle \+ cold TTI"
```

The test attaches a `perf-metrics` JSON payload with `jsTransferredKB` and `slow3gColdTtiMs`.
See [docs/runbooks/e2e-testing.md](../../docs/runbooks/e2e-testing.md) for standing up the
stack, and note that a skipped test reads as a pass — check the skip count.
