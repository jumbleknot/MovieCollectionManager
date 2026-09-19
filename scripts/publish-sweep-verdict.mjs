#!/usr/bin/env node
// Item #485 — publish the weekly CVE sweep's verdict as a commit status.
//
// WHY THIS EXISTS. A `schedule`-triggered `infra-image-scan` run posts NO
// `infra-image-scan / infra-image-scan` commit status. Its red is visible only in the runs listing,
// the job log and the evidence bundle — nothing attached to the commit says `main` is failing its
// weekly CVE sweep. Measured over three scheduled runs whose API status is `failure`:
//
//   run 1948  2026-08-21  7a9ff92c  → no infra contexts on that sha
//   run 2132  2026-08-28  b3c77867  → no infra contexts on that sha
//   run 3521  2026-09-18  3cbe637e  → only infra-image-scan/expiry, posted by the job itself
//
// The endpoint is not the problem: 3cbe637e carries 40 statuses from the previous day's push.
// Run 3521 went red at 07:02Z and NOTHING said so; it surfaced ~41 minutes later when Renovate's
// PR #478 opened, ran the same sweep on its own head, and became unmergeable over three CVEs with
// no bearing on its diff. The first signal that `main` was failing a required gate was an unrelated
// pull request failing it.
//
// WHY NOT REVIVE THE FAILURE DIGEST'S COMMIT-STATUS BRANCH. `ci-failure-digest.mjs` routes
// everything that is not a `pull_request` to the evidence bundle only; its status branch was removed
// deliberately (FR-008, amended by T040) because it needs `write:repository`, measured as a 403 on
// smoke run 986. That decision stands and is not reopened here. The `infra-image-scan/expiry`
// recorder (item #418) proves a NARROW status posts fine with `github.token`, and this reuses
// exactly that shape — one context, one line, written by the job about itself.
//
// WHY A SCRIPT RATHER THAN INLINE SHELL, which is what the `expiry` recorder does. Because the
// mapping below is a DECISION, not a formatting step, and item #485 requires it to be
// mutation-tested. Pinned as inline shell it could only be asserted by regexp over the step body,
// and a mutation that flipped `state=failure` to `state=success` in one branch went undetected by
// exactly such an assertion while writing this. `sweepStatusFor` is pure and unit-tested; the I/O
// below is thin on purpose.
//
// THIS STATUS CANNOT GATE ANYTHING. Branch protection requires the glob
// `infra-image-scan / infra-image-scan*`; `infra-image-scan/weekly` has no ` / ` separator and does
// not match — the same reason `infra-image-scan/expiry` has never blocked a merge. Protection is
// evaluated on PR HEADS, and this posts only on the scheduled run's own commit.

/** The context this publishes under. Deliberately NOT matching the required glob — see the header. */
export const CONTEXT = 'infra-image-scan/weekly';

/**
 * Map the measured step outcomes to the status to publish.
 *
 * Reads the GATE's outcome, not just the job's: the job can also be red for an install or a Trivy
 * failure, and "the sweep could not run" is a different fact from "the sweep found blocking CVEs".
 * A fail-closed Trivy/pull/parse error is a red job that has found NOTHING, and reporting it as a
 * CVE verdict would be a claim about images nobody scanned.
 *
 * @param {{gate?:string, scan?:string, job?:string}} measured raw step outcomes / job status
 * @returns {{state:'success'|'failure', description:string}|null} null means "publish nothing"
 */
export function sweepStatusFor({ gate, scan, job } = {}) {
  const g = String(gate ?? '<unset>');
  const s = String(scan ?? '<unset>');
  const j = String(job ?? '<unset>');

  // A superseded run is not a broken one — the same suppression FR-001a applies to the failure
  // digest. Publishing `failure` here would report a commit as failing its CVE sweep when the sweep
  // simply never finished.
  if (j === 'cancelled') return null;

  if (g === 'failure') {
    return {
      state: 'failure',
      description: `weekly sweep RED — un-allowlisted fixable High/Critical (gate=${g}). Read the evidence bundle.`,
    };
  }
  if (s === 'failure') {
    return {
      state: 'failure',
      description: `weekly sweep COULD NOT RUN — Trivy/pull/parse failed (scan=${s}). This is NOT a clean report.`,
    };
  }
  if (j === 'failure') {
    return {
      state: 'failure',
      description: `weekly sweep job failed outside the scan/gate (job=${j} gate=${g} scan=${s}).`,
    };
  }
  return { state: 'success', description: `weekly sweep green (gate=${g} scan=${s} job=${j}).` };
}

async function main() {
  const verdict = sweepStatusFor({
    gate: process.env.MEASURED_GATE_OUTCOME,
    scan: process.env.MEASURED_SCAN_OUTCOME,
    job: process.env.MEASURED_JOB_STATUS,
  });
  if (!verdict) {
    console.log('[sweep-verdict] job.status=cancelled — superseded run. Publishing no verdict.');
    return;
  }
  console.log(`[sweep-verdict] state=${verdict.state} ${verdict.description}`);

  const server = (process.env.GITHUB_SERVER_URL ?? '').replace(/\/$/, '');
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const sha = process.env.GITHUB_SHA ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';
  if (!server || !repository || !sha || !token) {
    console.error('[sweep-verdict] missing GITHUB_SERVER_URL/REPOSITORY/SHA/TOKEN — publishing nothing.');
    return;
  }

  // Bounded, like every other forge call in this repository: an unbounded POST from a
  // `continue-on-error` bookkeeping step would sit here until the job's 30-minute timeout, turning a
  // status that cannot fail the job into one that can still delay it by half an hour.
  const res = await fetch(`${server}/api/v1/repos/${repository}/statuses/${sha}`, {
    method: 'POST',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: CONTEXT, state: verdict.state, description: verdict.description }),
    signal: AbortSignal.timeout(Number(process.env.CI_HTTP_TIMEOUT_MS) || 30000),
  });
  if (!res.ok) {
    // The ABSENCE of the status is its own tell, and the job's own conclusion is already the truth.
    // This is a report on the sweep, never a second gate, so it must not fail the job it observes.
    console.error(`[sweep-verdict] POST → ${res.status}; the status was not published.`);
    return;
  }
  console.log(`[sweep-verdict] published ${CONTEXT} = ${verdict.state}`);
}

const invoked = process.argv[1] ?? '';
if (invoked.endsWith('publish-sweep-verdict.mjs')) {
  // Always exit 0: a bookkeeping POST must never mask, replace or delay the real job result.
  main().catch((err) => console.error(`[sweep-verdict] FAILED: ${err.message}`));
}
