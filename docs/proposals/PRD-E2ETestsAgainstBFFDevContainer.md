# E2E tests against the BFF Dev container

During local development the Expo BFF is served by the metro bundler.  However, in higher environments we must ensure that the BFF is hosted in a Docker container.

- Build and deploy the Dev BFF Docker container, validate the client is using BFF in Docker (not Metro), then run all E2E tests (web and mobile) and validate all green
- Update testing instructions to do Dev BFF Docker container build and deploy before the final E2E tests are run (all other tests fall back to metro)
- Ensure that the Prod BFF Docker container build and deploy functions as expected, validate the client is using Prod BFF in Docker (not Dev or Metro), then run all E2E tests (web and mobile) and validate all green
  - Based on learnings from past feature, this may require additional changes
  - Expo prod-server login streaming + token-refresh/SSO-logout reconciliation + HTTPS/Secure-cookie security review - captured in project_web_e2e_container_blockers memory.
- Switch back to local dev and clean up unused BFF containers.
