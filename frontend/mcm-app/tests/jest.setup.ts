/**
 * Jest setup file — runs after the test framework is installed (T-016).
 * @testing-library/react-native v13+ no longer exports extend-expect.
 * Matchers are available via @testing-library/jest-native if needed.
 */

// Feature 006 (FR-004) isolation hygiene: never let one test leave fake timers installed
// for the next. A leaked fake-timer clock is a classic cross-test contaminator; resetting
// to real timers after every test removes that whole class of order-dependent flake.
afterEach(() => {
  jest.useRealTimers();
});
