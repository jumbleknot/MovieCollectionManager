// Feature 007: the E2E base URL. Defaults to the Metro dev server (:8081); when
// E2E_BFF_TARGET selects a BFF container, point at it instead (dev :8082 HTTP, prod :8443
// HTTPS). Mirrors playwright.config.ts + global-setup.ts so specs that build absolute URLs
// (`${BASE}/...`) follow the same target.
const T = process.env['E2E_BFF_TARGET'];
export const E2E_BASE_URL =
  T === 'dev-container' ? 'http://localhost:8082'
  : T === 'prod-container' ? 'https://localhost:8443'
  : 'http://localhost:8081';
