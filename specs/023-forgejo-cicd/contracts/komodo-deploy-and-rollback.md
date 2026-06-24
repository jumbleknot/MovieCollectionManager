# Contract: Komodo Deploy, Health Probe & Rollback

Defines the CD handoff from the pipeline to Komodo, the single-step deploy, and the rollback safety net. Reflects the clarify decision (single-step, no staging).

## Stacks

Each prod compose file is a Komodo **Stack** on the prod rootless daemon:

| Stack | Compose | Image source |
|---|---|---|
| prod-auth | `infrastructure-as-code/docker/keycloak/compose.prod.yaml` (022) | upstream digests |
| prod-app | `infrastructure-as-code/docker/bff/compose.prod.yaml` (022) | CI-built `mcm-bff` digest + upstream Redis/Mongo |
| prod-mc-service / prod-agents | (consumed as 022/follow-up adds them) | CI-built digests |

## Deploy sequence (single-step)

```
cd-deploy (after publish):
  1. assemble deploy manifest: {svc → digest} for CI-built images this run
  2. for each affected Stack: hand Komodo the new digest(s) and POST the Stack
     redeploy webhook  (KOMODO_WEBHOOK_URL + KOMODO_WEBHOOK_AUTH)
  3. Komodo (prod daemon): pull by digest, recreate the Stack  (no staging hop)
  4. wait for convergence (Stack healthy)
  5. POST-DEPLOY HEALTH PROBE:
       - https://auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration
         → issuer == https://auth.${BASE_DOMAIN}
       - https://mcm.${BASE_DOMAIN}  health endpoint → 200
       - container health == healthy
  6. probe pass  ⇒ deploy SUCCESS
     probe fail  ⇒ Komodo ROLLBACK to the previously deployed digest (FR-016)
```

## Rules

1. **Single-step, no staging** (clarify): deploy goes straight to prod; the probe + digest rollback is the safety net. (Supersedes the "two-step recommended" wording in PRD-CI §2.6 / Server-Setup-Runbook §Phase 9 — reconciled by FR-028.)
2. **Promote by digest** — Komodo pulls the exact digests from the run manifest; prod is never rebuilt (FR-015).
3. **Rollback retains the prior digest** — Komodo keeps the last-good digest per Stack; a failed probe restores it, leaving prod on a known-good version (FR-016, SC-007). The failed image stays in the registry for diagnosis (spec Edge Cases).
4. **ci/prod isolation** — the pipeline never runs compose on the prod daemon directly; all prod mutation goes through Komodo (FR-017). CI holds only the webhook URL+auth, not the prod docker socket.
5. **Missing prod secret ⇒ abort** — a Stack whose `${VAR:?}` is unset fails `compose config` at deploy and Komodo reports the failure naming the variable; no fallback deploy (FR-019, SC-010).
6. **Upstream stacks too** — prod-auth and the data stores redeploy through the same path at their pinned upstream digests (clarify: all prod stacks orchestrated).
