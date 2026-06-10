/**
 * Rego/TS parity test — asserts the OPA policy allowlists exactly match the TS maps.
 *
 * If a new agent-navigable target is added to ui-action-authorizer.ts without updating
 * agent_ui_action.rego (or vice-versa), this test fails — preventing silent drift.
 */

import * as fs from 'fs';
import * as path from 'path';
import { NAVIGABLE_TARGETS, PREFILL_TARGETS } from '@/bff-server/ui-action-authorizer';

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
});
