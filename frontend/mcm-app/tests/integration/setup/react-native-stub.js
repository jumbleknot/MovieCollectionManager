/**
 * Minimal `react-native` stub for the Node integration environment (T004a).
 *
 * Module-level integration tests import BFF server source directly. Some of that
 * source transitively imports `@/config/keycloak`, which reads `Platform.OS` from
 * react-native to pick web-vs-native endpoints. react-native has no meaning on the
 * server (the BFF runs in the Expo "web"/server output), so we resolve it to a tiny
 * stub reporting `OS: 'web'`. This is environment shimming, NOT mocking a
 * system-under-test dependency — the integrated dependencies (Keycloak, Redis,
 * mc-service) are always real. See constitution v1.3.0 (Test Type Integrity).
 */
const Platform = {
  OS: 'web',
  select: (specifics) =>
    specifics && (specifics.web ?? specifics.default ?? undefined),
};

module.exports = { Platform };
