// Item #485 — unit tests for the weekly CVE sweep's verdict mapping.
//
// This logic was inline shell in infra-image-scan.yml first. A mutation flipping `state=failure` to
// `state=success` in one branch went UNDETECTED by a regexp over the step body — the assertion
// matched a different, untouched occurrence of the same string. That is exactly the "wiring
// assertion never shown to fail is indistinguishable from one that asserts nothing" trap item #484
// names, so the decision moved into a pure function and these tests were mutation-checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepStatusFor, CONTEXT } from '../publish-sweep-verdict.mjs';

test('(#485) a red GATE publishes a FAILURE — this is the whole point of the status', () => {
  // Run 3521, 2026-09-18: three amqp091-go CRITICALs on grafana/otel-lgtm:0.32.1. Nothing on the
  // commit said so, and the first signal was an unrelated PR inheriting the block 41 minutes later.
  const v = sweepStatusFor({ gate: 'failure', scan: 'success', job: 'failure' });
  assert.equal(v.state, 'failure');
  assert.match(v.description, /RED/, 'the description must say what happened, not merely that it happened');
});

test('(#485) a green sweep publishes SUCCESS — it is a verdict, not an alarm', () => {
  // The control. Without it, every assertion above is satisfied by a function that always returns
  // `failure`, which would paint `main` red every week and train people to ignore the context.
  const v = sweepStatusFor({ gate: 'success', scan: 'success', job: 'success' });
  assert.equal(v.state, 'success');
});

test('(#485) "could not run" is NOT reported as a CVE verdict', () => {
  // A fail-closed Trivy/pull/parse error is a red job that has found NOTHING. Publishing it as a
  // CVE finding would be a claim about images nobody scanned — the same class of false green the
  // scanner's own exit-2-on-missing-REGISTRY_HOST exists to prevent, inverted.
  const v = sweepStatusFor({ gate: 'skipped', scan: 'failure', job: 'failure' });
  assert.equal(v.state, 'failure', 'a sweep that could not run must still be red');
  assert.match(v.description, /COULD NOT RUN/, 'it must be distinguishable from a CVE finding');
  assert.doesNotMatch(v.description, /un-allowlisted/, 'it must not claim a finding it never made');
});

test('(#485) a job that failed outside the scan and the gate is still reported', () => {
  // An install or checkout failure. Silent here would mean a sweep that never happened reads as one
  // that passed — the absence-as-health fault, one layer down.
  const v = sweepStatusFor({ gate: 'skipped', scan: 'skipped', job: 'failure' });
  assert.equal(v.state, 'failure');
  assert.match(v.description, /outside the scan\/gate/);
});

test('(#485) a CANCELLED run publishes NOTHING — superseded is not broken', () => {
  // FR-001a, the same suppression the failure digest applies. Publishing `failure` for a cancelled
  // sweep would report a commit as failing its CVE gate when the sweep simply never finished.
  assert.equal(sweepStatusFor({ gate: 'failure', scan: 'failure', job: 'cancelled' }), null);
  assert.equal(sweepStatusFor({ gate: 'success', scan: 'success', job: 'cancelled' }), null);
});

test('(#485) the gate outranks the scan, so a real finding is never downgraded', () => {
  // If both are red the CVE finding is the more actionable message — it names what to allowlist.
  const v = sweepStatusFor({ gate: 'failure', scan: 'failure', job: 'failure' });
  assert.match(v.description, /un-allowlisted/);
});

test('(#485) unset outcomes are reported as <unset>, never guessed at', () => {
  // `<unset>` is a real answer: it says the runner returned no value for that context, which is a
  // different fault from returning the wrong one. Same convention as the item #418 recorder.
  const v = sweepStatusFor({});
  assert.equal(v.state, 'success', 'nothing measured as failed means nothing to report as failed');
  assert.match(v.description, /<unset>/);
});

test('(#485) the published context cannot match the required branch-protection glob', () => {
  // Branch protection requires `infra-image-scan / infra-image-scan*`. This context has no ` / `
  // separator, so it cannot become a merge gate — the same reason infra-image-scan/expiry never has.
  assert.equal(CONTEXT, 'infra-image-scan/weekly');
  assert.ok(!CONTEXT.startsWith('infra-image-scan / '), 'this context would be matched by the required glob');
});
