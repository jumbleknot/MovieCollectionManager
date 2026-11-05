# Contract: Android (PR B and PR C)

## `scripts/android-launch-smoke.sh`

Runs with the APK already installed and a booted emulator. The output is what `tasks.md` quotes.

| Invocation | Effect | Exit |
|---|---|---|
| *(no args)* | Runs the checks below | 0 if all pass, 1 otherwise |
| `--selftest` | Runs the log classifier over sample lines; needs no device | 0 or 1 |
| Anything else | Usage | 2 |

| Check | Pass condition | Evidence line |
|---|---|---|
| Launch | `am start -W` reports `Status: ok` | `launch=ok totalTime=<ms>` |
| Login screen | `login-screen` in a `uiautomator dump`, within a bound | `login-screen=visible after=<s>` |
| Device log | No `FATAL EXCEPTION`, `ClassNotFoundException` or `NoSuchMethodException` for the app's process | `fatal=<count>` |

The selftest must see each pattern detected, and a clean log pass. Afterwards the app is force-stopped, so the flows start
cold. On failure, the matched lines are printed with the existing log redaction. No credential is on the device at this
point, because nothing has signed in.

## `scripts/publish-android-launch.mjs`

Posts `app-ci / android-launch` ([data model](../data-model.md)), run as an `if: always()` step with `continue-on-error`,
so a failed post cannot mask the result. Its mapping from result to state is mutation-tested. Modelled on
`publish-sweep-verdict.mjs`.

## Workflow

- `app-e2e`'s emulator `script:` gains one line after `adb install`.
- Both `app-e2e` and `prod-apk` write the same `org.gradle.jvmargs` line:
  `-Xmx4g -XX:MaxMetaspaceSize=1g -XX:+ExitOnOutOfMemoryError -Dfile.encoding=UTF-8`.
- `prod-apk-gradle-heap.guard.test.mjs` asserts both, with the same heap floor and the fail-fast flag.

## Release shrinking guard

`scripts/__tests__/android-release-shrinking.guard.test.mjs`:

- `frontend/mcm-app/app.json` has `expo-build-properties` with `android.enableMinifyInReleaseBuilds === false`.
- Absent or `true` fails. Absent matters, because the SDK 58 template default is on.
- The message says shrinking is a separate change, naming its requirements: measured size and a retained mapping file.

## Label

PR B uses `mobile-e2e`. PR C uses `mobile-e2e-full`.
