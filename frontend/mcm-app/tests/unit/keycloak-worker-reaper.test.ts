/**
 * Item #183 — the setup-time reaper for leaked per-worker Keycloak identities.
 *
 * Feature 054 US4 mints one throwaway realm user per Playwright worker and deletes them in global
 * teardown from `.auth/worker-identities.json`. A run that is KILLED never reaches teardown, and the
 * next run's setup overwrites that manifest — destroying the only record of the previous run's
 * users, so nothing would ever delete them. Measured 2026-08-13: five orphans (`e2e_w1…e2e_w5`) in
 * the `grumpyrobot` realm after two runs were stopped mid-flight, with no manifest naming any.
 *
 * The reaper deletes REAL realm users, so the two rules it must never get wrong are pinned here
 * rather than left to a live-Keycloak path nothing exercises offline:
 *
 *   1. it deletes only what the mint produced — `e2e-test-user` and `intreg_*` are untouchable;
 *   2. it cannot delete a user belonging to a CONCURRENTLY running suite.
 *
 * `selectReapableWorkerUsers` is pure for exactly that reason: the decision is testable without a
 * Keycloak, and a mistake in it is caught here rather than in a realm.
 */
import { selectReapableWorkerUsers } from '../e2e/web/setup/keycloak-admin';

const NOW = Date.parse('2026-08-29T12:00:00Z');
const HOURS = 60 * 60 * 1000;
const old = (h: number) => NOW - h * HOURS;

describe('selectReapableWorkerUsers', () => {
  it('reaps a minted worker user that is older than the threshold', () => {
    const reapable = selectReapableWorkerUsers(
      [{ id: '1', username: 'e2e_w1_8f62eb384e', createdTimestamp: old(9) }],
      { now: NOW },
    );
    expect(reapable.map((u) => u.username)).toEqual(['e2e_w1_8f62eb384e']);
  });

  it('reaps every orphan from the measured leak, and nothing else in that realm', () => {
    // The exact five found on 2026-08-13, alongside the users that share the realm with them.
    const reapable = selectReapableWorkerUsers(
      [
        { id: '1', username: 'e2e_w1_8f62eb384e', createdTimestamp: old(9) },
        { id: '2', username: 'e2e_w2_69cae7d9c6', createdTimestamp: old(9) },
        { id: '3', username: 'e2e_w3_0be1b9bcec', createdTimestamp: old(9) },
        { id: '4', username: 'e2e_w4_430d683b01', createdTimestamp: old(9) },
        { id: '5', username: 'e2e_w5_cdfef75a1d', createdTimestamp: old(9) },
        { id: '6', username: 'e2e-test-user', createdTimestamp: old(900) },
        { id: '7', username: 'intreg_a1b2c3', createdTimestamp: old(900) },
      ],
      { now: NOW },
    );
    expect(reapable).toHaveLength(5);
    expect(reapable.every((u) => u.username.startsWith('e2e_w'))).toBe(true);
  });

  // --- rule 1: never a user that is not ours ----------------------------------------------------
  //
  // A `startsWith('e2e')` would take the canonical E2E user with it and every suite would then fail
  // to log in. The match is the whole minted SHAPE, so these cannot be reached by accident.
  it.each([
    ['e2e-test-user', 'the canonical E2E user — deleting it breaks every suite'],
    ['intreg_a1b2c3', 'a BFF integration-suite user'],
    ['e2e-admin_9f2a1c0b4d', 'the admin specs\' own throwaway (hyphen prefix, not the worker mint)'],
    ['e2e_worker_manual', 'a hand-made name that merely starts with the prefix'],
    ['e2e_w1', 'the prefix with no minted suffix'],
    ['e2e_w1_ZZZZZZZZZZ', 'a suffix that is not the mint\'s 10 hex characters'],
    ['prod_e2e_w1_8f62eb384e', 'the minted shape embedded in a longer name'],
  ])('never reaps %s (%s)', (username) => {
    const reapable = selectReapableWorkerUsers(
      [{ id: 'x', username, createdTimestamp: old(900) }],
      { now: NOW },
    );
    expect(reapable).toEqual([]);
  });

  // --- rule 2: never a user a running suite is using --------------------------------------------
  it('never reaps a user younger than the threshold — a concurrent suite may be using it', () => {
    const reapable = selectReapableWorkerUsers(
      [
        { id: '1', username: 'e2e_w1_8f62eb384e', createdTimestamp: NOW - 60_000 },
        { id: '2', username: 'e2e_w2_69cae7d9c6', createdTimestamp: old(1) },
      ],
      { now: NOW },
    );
    expect(reapable).toEqual([]);
  });

  it('treats an UNKNOWN age as too young, not as old enough', () => {
    // Keycloak always sends createdTimestamp. If a version stopped, an age that cannot be
    // established must not read as "old enough" — that would silently turn the reaper into an
    // unconditional delete of every worker user in the realm, including a live run's.
    const reapable = selectReapableWorkerUsers(
      [{ id: '1', username: 'e2e_w1_8f62eb384e' }],
      { now: NOW },
    );
    expect(reapable).toEqual([]);
  });

  it('honours an explicit threshold, so the guard is a value and not a constant nobody can see', () => {
    const users = [{ id: '1', username: 'e2e_w1_8f62eb384e', createdTimestamp: old(2) }];
    expect(selectReapableWorkerUsers(users, { now: NOW, minAgeMs: 3 * HOURS })).toEqual([]);
    expect(selectReapableWorkerUsers(users, { now: NOW, minAgeMs: 1 * HOURS })).toHaveLength(1);
  });
});
