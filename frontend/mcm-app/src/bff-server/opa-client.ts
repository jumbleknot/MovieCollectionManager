/**
 * OPA client for BFF UI-action authorization (T074e).
 *
 * Config-gated: when OPA_URL is unset the caller falls back to the TS authorizer.
 * When OPA_URL is set, any error or non-true result is treated as a deny (fail CLOSED).
 */

import { logger } from '@/bff-server/logger';

const UI_ACTION_DECISION = '/v1/data/mcm/agent_ui_action/allow';

export function isOpaConfigured(): boolean {
  return Boolean((process.env.OPA_URL ?? '').trim());
}

/** Ask OPA whether a UI action is allowed. Allow when OPA is unconfigured (caller falls back to the
 *  TS authorizer); fail CLOSED (false) when OPA is configured but errors/denies. */
export async function opaAllowsUiAction(input: {
  action_type: string;
  target: string;
  roles: string[];
}): Promise<{ configured: boolean; allowed: boolean }> {
  const base = (process.env.OPA_URL ?? '').trim();
  if (!base) return { configured: false, allowed: true };
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}${UI_ACTION_DECISION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (!resp.ok) {
      logger.error('OPA ui-action decision non-2xx — denying', { action: 'opa_ui_action', status: resp.status });
      return { configured: true, allowed: false };
    }
    const body = (await resp.json()) as { result?: unknown };
    return { configured: true, allowed: body.result === true };
  } catch (err) {
    logger.error('OPA ui-action request failed — denying', { action: 'opa_ui_action', error: err });
    return { configured: true, allowed: false };
  }
}
