# Clean Up Project Flakiness

- Pre-existing test-isolation flake — movie-detail-screen.test.tsx fails only in the full unit run, passes isolated (jsdom/timer leak). Hardening task with the goal of full suite green in one pass.
- E2E flakiness under the loaded local emulator/Metro is environmental. Hardening task with the goal of full suite green in one pass (at most 1 explicit, visible retry per test as an environmental safety net — a real regression still fails).
- CI on short paths should be cleaner. Goal is easier APK rebuilds.
- Since I don't want anyone to run `npm install` in my repo, is it a good idea to update root "package.json" with the below and then add `engine-strict=true` to .npmrc file?  Or will this cause problems?

    ```json
    {
    "engines": {
        "npm": "Please use pnpm instead of npm."
    }
    }
    ```
