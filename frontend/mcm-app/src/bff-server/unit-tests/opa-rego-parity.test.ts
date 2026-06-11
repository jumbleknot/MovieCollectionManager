/**
 * Rego/TS parity test — asserts the OPA policy allowlists exactly match the TS maps.
 *
 * If a new agent-navigable target is added to ui-action-authorizer.ts without updating
 * agent_ui_action.rego (or vice-versa), this test fails — preventing silent drift.
 */

import * as fs from 'fs';
import * as path from 'path';
import { NAVIGABLE_TARGETS, PREFILL_TARGETS } from '@/bff-server/ui-action-authorizer';
import { ClientRole } from '@/types/auth';

const REGO_PATH = path.resolve(
  __dirname,
  '../../../../../infrastructure-as-code/opa/policies/agent_ui_action.rego',
);

function parseRegoSet(source: string, setName: string): Set<string> {
  // Match e.g.: navigable := {"home", "collection", "movie-detail", "profile"}
  const re = new RegExp(`${setName}\\s*:=\\s*\\{([^}]+)\\}`);
  const match = re.exec(source);
  if (!match) throw new Error(`Could not find '${setName}' set in Rego source`);
  const entries = match[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  return new Set(entries);
}

describe('Rego/TS allowlist parity', () => {
  let regoSource: string;

  beforeAll(() => {
    regoSource = fs.readFileSync(REGO_PATH, 'utf-8');
  });

  it('Rego file exists and is non-empty', () => {
    expect(regoSource.length).toBeGreaterThan(0);
  });

  it('navigable set in Rego exactly matches NAVIGABLE_TARGETS keys', () => {
    const regoNavigable = parseRegoSet(regoSource, 'navigable');
    const tsNavigable = new Set(Object.keys(NAVIGABLE_TARGETS));

    expect(regoNavigable).toEqual(tsNavigable);
  });

  it('prefillable set in Rego exactly matches PREFILL_TARGETS keys', () => {
    const regoPrefillable = parseRegoSet(regoSource, 'prefillable');
    const tsPrefillable = new Set(Object.keys(PREFILL_TARGETS));

    expect(regoPrefillable).toEqual(tsPrefillable);
  });

  // Role-assumption guard: the Rego policy applies a FLAT `has_mc_user` check to ALL
  // navigable/prefillable targets. As long as every target requires only ClientRole.MCUser
  // this matches. If an admin-only target is ever added to the TS maps, the Rego MUST be
  // extended to carry per-target role logic — and this assertion updated at the same time.
  // Failing here loudly prevents the Rego from silently under-enforcing an admin-only target.
  it('every NAVIGABLE_TARGETS value is ClientRole.MCUser (Rego flat mc-user assumption)', () => {
    for (const [target, role] of Object.entries(NAVIGABLE_TARGETS)) {
      expect(role).toBe(ClientRole.MCUser);
      // If this assertion fires, update agent_ui_action.rego to carry per-target role checks
      // before adding the new target, then update this assertion accordingly.
      if (role !== ClientRole.MCUser) {
        throw new Error(
          `NAVIGABLE_TARGETS["${target}"] = "${role}" but Rego uses a flat mc-user check. ` +
          'Extend agent_ui_action.rego to enforce per-target roles, then update this assertion.',
        );
      }
    }
  });

  it('every PREFILL_TARGETS value is ClientRole.MCUser (Rego flat mc-user assumption)', () => {
    for (const [target, role] of Object.entries(PREFILL_TARGETS)) {
      expect(role).toBe(ClientRole.MCUser);
      // Same constraint as NAVIGABLE_TARGETS — see comment above.
      if (role !== ClientRole.MCUser) {
        throw new Error(
          `PREFILL_TARGETS["${target}"] = "${role}" but Rego uses a flat mc-user check. ` +
          'Extend agent_ui_action.rego to enforce per-target roles, then update this assertion.',
        );
      }
    }
  });
});
