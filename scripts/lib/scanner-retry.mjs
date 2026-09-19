#!/usr/bin/env node
// Transient-failure classification and bounded retry, shared by every network-dependent scanner.
//
// ONE MECHANISM, ON PURPOSE. This was extracted from scripts/sast-scan.mjs (item #449) when
// scripts/infra-image-scan.mjs needed the same behaviour (item #495). A second copy would drift:
// the hard part here is not the backoff loop, it is the SIGNATURE LIST, and a signature learned
// from one scanner's outage is exactly the thing the other one needs next.
//
// THE CONTRACT BOTH CALLERS DEPEND ON:
//   - FAIL-CLOSED SURVIVES. Exhausting the attempts still throws. A scanner that could not run must
//     never report clean, and neither item is about converting a red into a green.
//   - ONLY TRANSPORT FAILURES RETRY. Anything unrecognised is treated as REAL and fails on the first
//     attempt, so a genuine fault surfaces immediately instead of three identical tracebacks later.
//   - EVERY RETRY IS REPORTED. A silent retry is indistinguishable from no retry at all, which is
//     how this whole defect class stays invisible.
//
// Callers classify with `transientOr(message, output)` at each network-dependent throw site — the
// classifier only ever runs if the throw sites consult it.

// ── The signature list ───────────────────────────────────────────────────────
//
// The classification is deliberately NARROW, and this list grows only from a MEASURED failure.
// A finding's own title routinely contains "error" or "timeout"; matching on those would retry real
// findings three times and then report them anyway — slower, for nothing (item #449).
//
// Only signatures that can ONLY come from the transport or the remote service are listed.

/** Transport/service signatures. Each can only originate below the scanner's own logic. */
const TRANSIENT_SIGNATURES = [
  // pip-audit / requests / urllib3 (the osv.dev path that redded run 3328 — item #449)
  /\bServiceError\b/,
  /\bConnectionError\b/,
  /\bReadTimeout\b/, /\bConnectTimeout\b/,
  // ANCHORED TO THE TERMINATING PERIOD — item #499, and the same defect #495 fixed one
  // signature away. This was a bare /\bRead timed out\b/i, which is ordinary English: the
  // advisory title "openssl: read timed out while parsing a certificate" classified TRANSIENT,
  // so a genuine scanner fault whose output carried that finding would be retried three times
  // and then reported anyway — slower, for nothing, with a retry line misdescribing it as a
  // blip. Not theoretical: sast-scan.mjs hands the classifier `stderr + stdout`, so finding
  // titles DO reach it on the cargo-audit and pip-audit paths.
  //
  // requests emits a complete sentence — "HTTPSConnectionPool(host='api.osv.dev', port=443):
  // Read timed out. (read timeout=15)" — so requiring the period costs no coverage, and the
  // one measured sample (#449) independently matches ReadTimeout and HTTPSConnectionPool above
  // anyway. A phrase that is also ordinary English is not a transport signature.
  /\bRead timed out\.(?:\s|$)/i,
  /\bMaxRetryError\b/, /\bMax retries exceeded\b/i,
  /\bHTTPSConnectionPool\b/, /\bHTTPConnectionPool\b/,
  // HTTP statuses that are the server saying "not now" rather than "no".
  //
  // ANCHORED TO THE STATUS CODE — item #495. These arrived in #449 with a bare second form
  // (/\bService Unavailable\b/i and friends), and #495's control test caught it: the advisory title
  // "net/http: HTTP/2 server does not limit Service Unavailable responses" classified TRANSIENT, so a
  // finding would have been retried three times and then reported anyway — precisely the failure #449
  // set out to avoid, one signature short. Every sample #449 measured carries the code, so requiring
  // it costs no coverage. A phrase that is also ordinary English is not a transport signature.
  /\b(?:HTTP Error )?429\b[^\n]*Too Many Requests/i,
  /\b(?:HTTP Error )?50[234]\b[^\n]*(?:Bad Gateway|Service Unavailable|Gateway Timeout)/i,
  // The OCI/Docker registry rate-limit token. Not prose in any language, so it needs no anchor.
  /\bTOOMANYREQUESTS\b/,
  // Node / libc socket + DNS errors (pnpm audit, and anything using fetch)
  /\bECONNRESET\b/, /\bECONNREFUSED\b/, /\bETIMEDOUT\b/, /\bEAI_AGAIN\b/,
  /\bENOTFOUND\b/, /\bEHOSTUNREACH\b/, /\bENETUNREACH\b/, /\bEPIPE\b/,
  /\bsocket hang up\b/i,
  /\bTemporary failure in name resolution\b/i,
  // git / cargo-audit fetching the advisory DB
  /\bCould not resolve host\b/i,
  /\bfailed to fetch advisory database\b/i,
  /\bunable to access\b[^\n]*https?:\/\//i,
  /\bTLS connection\b[^\n]*\b(?:reset|timed out)\b/i,

  // ── Trivy fetching its vulnerability DB (item #495) ────────────────────────
  //
  // MEASURED, run 3622 (PR #494, 2026-09-19). The same commit passed as run 3619 nine minutes
  // earlier and failed here, before a single image was scanned:
  //
  //   INFO  [vulndb] Need to update DB
  //   INFO  [vulndb] Downloading artifact...  repo="mirror.gcr.io/aquasec/trivy-db:2"
  //   ERROR [vulndb] Failed to download artifact  repo="mirror.gcr.io/aquasec/trivy-db:2"
  //         err="oci download error: failed to fetch the layer: GET https://mirror.gcr.io/v2/…"
  //
  // Both of the leaf strings are scoped to Trivy's DB SUBSYSTEM — `[vulndb]`/`[javadb]` is Trivy's
  // own log prefix for the advisory-database fetch, and `oci download error` comes from the OCI
  // client underneath it. Neither can appear in a vulnerability report: findings are emitted as
  // JSON on STDOUT and this classifier is only ever handed STDERR.
  /\[(?:vulndb|javadb)\]\s+Failed to download artifact/i,
  /\boci download error\b/i,
  // The FATAL wrapper Trivy prints around the leaf above when every DB repository has been tried.
  // Included although it was TRUNCATED out of run 3622's captured log (see readTail below, and the
  // truncation fix in infra-image-scan.mjs): it is the documented parent of the measured leaf, and
  // "failed to download the vulnerability DB" can only ever be a fetch, never a finding.
  /\bfailed to download (?:the )?(?:vulnerability|java) DB\b/i,
];

/**
 * Is this scanner output a transport/service failure rather than a scanner fault or a finding?
 *
 * Returns false for anything unrecognised, on purpose: an unknown failure is treated as REAL and
 * fails on the first attempt. Retrying an unknown fault would only delay a genuine red by the whole
 * backoff budget while hiding its cause behind three identical tracebacks.
 */
export function isTransientScannerFailure(output) {
  const text = String(output ?? '');
  if (!text.trim()) return false;
  return TRANSIENT_SIGNATURES.some((re) => re.test(text));
}

/** A failure the retry driver is allowed to re-attempt. Everything else propagates immediately. */
export class TransientScannerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransientScannerError';
    this.transient = true;
  }
}

/**
 * Build the error for a failed scanner invocation, classified from what the scanner actually printed.
 * Use at every network-dependent throw site so the classifier is consulted rather than bypassed.
 *
 * `ErrorClass` lets a caller keep its own error type for the non-transient branch (infra-image-scan
 * throws ScanError) without losing the classification.
 */
export function transientOr(message, output, ErrorClass = Error) {
  return isTransientScannerFailure(output) ? new TransientScannerError(message) : new ErrorClass(message);
}

/**
 * The LAST `n` characters of a scanner's output, which is where its fatal error is.
 *
 * Not a detail. infra-image-scan.mjs truncated Trivy's stderr with `.slice(0, 500)` — the HEAD — and
 * Trivy opens with several INFO lines, so run 3622's captured failure ends mid-URL, exactly where the
 * HTTP status would have been. A 403, a 429 and a 500 imply three different remedies and the digest
 * could name none of them (item #495). Truncate the boring end, never the verdict.
 */
export function readTail(output, n = 2000) {
  const text = String(output ?? '');
  return text.length <= n ? text : `…(${text.length - n} earlier chars omitted)…\n${text.slice(-n)}`;
}

/** Block the thread without a busy-loop. The scanners are synchronous (spawnSync), so the wait is too. */
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn`, re-attempting only a TransientScannerError, with deterministic exponential backoff.
 *
 * Deterministic rather than jittered: jitter exists to de-synchronize a herd, and there is one CI
 * runner running one scan — so it would buy nothing and cost testability.
 *
 * FAIL-CLOSED IS PRESERVED. When the attempts are exhausted this still throws; items #449 and #495
 * are about not failing on the FIRST blip, never about tolerating a scanner that cannot run.
 *
 * `opts.logPrefix` names the tool in the default retry report, so a retry in the job log says which
 * scanner orchestrator emitted it.
 */
export function retryTransient(scanner, fn, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  const sleep = opts.sleep ?? sleepSync;
  const logPrefix = opts.logPrefix ?? 'scan';
  const onRetry = opts.onRetry ?? ((info) => reportScannerRetry({ ...info, logPrefix }));
  let waitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      // Not transient, or out of attempts on the last try → decide here.
      if (!err?.transient) throw err;
      if (attempt >= attempts) {
        throw new Error(
          `[${scanner}] TRANSPORT/SERVICE ERROR — the advisory service could not be reached, so this ` +
            `is NOT a security finding and nothing was detected in this repository. Failed all ` +
            `${attempts} attempt(s) over ${(waitedMs / 1000).toFixed(1)}s of backoff and did not ` +
            `recover. Failing closed: a ` +
            `scanner that could not run must never report clean. Last error: ${err.message}`,
        );
      }
      const delay = baseDelayMs * 2 ** (attempt - 1);
      onRetry({ scanner, attempt, attempts, delayMs: delay, reason: err.message });
      sleep(delay);
      waitedMs += delay;
    }
  }
}

/** Default retry reporter. A silent retry is indistinguishable from no retry, which is how this hides. */
function reportScannerRetry({ logPrefix, scanner, attempt, attempts, delayMs, reason }) {
  console.error(
    `[${logPrefix}] [${scanner}] transient transport/service failure on attempt ${attempt}/${attempts} — ` +
      `retrying in ${delayMs}ms. This is NOT a security finding. Cause: ${String(reason).slice(-200)}`,
  );
}
