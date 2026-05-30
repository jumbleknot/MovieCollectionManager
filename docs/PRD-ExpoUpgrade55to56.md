Feature: Expo SDK 55 to 56 Upgrade

Keep the application framework up to date to take advantage of the latest features.

Target Users: All

Core Capabilities: We need to upgrade from Expo SDK 55 to Expo SDK 56, including upgrading dependencies (e.g., React 19.2 and React Native 0.85), then build, run all tests, and fix any issues until all tests pass.  once this is done we will need to update any project documentation (including constitution) that reference the old versions.

Security: The security posture should not be reduced by the upgrade.  The application must be at least as secure as before the upgrade.

Success Criteria:  

- constitution.md and CLAUDE.md updated prior to making any code changes
- Any references to Expo SDK now on version 56. No references to Expo SDK 55.
- Any references to React now on version 19.2.
- Any references to React Native now on version 0.85.
- Code reviewed and updated where necessary to comply to new standards and best practices for Expo SDK 56.
- All existing tests pass.
- All existing performance requirements are still met.
- Run /security-review and resolve any issues, then re-validate all tests pass.

Constraints: No reduction in functionality or performance is allowed.

Out of Scope: Any new functionality is out of scope.
