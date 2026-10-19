// ESLint flat config (feature 081 US5b). ESLint 10 removed `.eslintrc.*` and `--ext`. This file replaces
// `.eslintrc.json` (`"root": true`, `"extends": "expo"`, `"ignorePatterns": ["/dist/*", "jest.config.js",
// "babel.config.js"]`) one-for-one. A flat config is always the root (no cascade), so `root` has no
// equivalent and needs none.
const { fixupConfigRules } = require('@eslint/compat');
const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  globalIgnores(['dist/*', 'jest.config.js', 'babel.config.js']),
  // SCOPE IS UNCHANGED: the lint command used `--ext .ts,.tsx`, which never linted jest/*.js or this
  // file. Flat config lints *.js/*.mjs/*.cjs by default and cannot narrow extensions from the CLI, so
  // they are ignored here. Widening lint to JS is a separate decision.
  globalIgnores(['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs']),
  // fixupConfigRules: eslint-config-expo 57.0.2 (also 58.0.4, the newest) bundles eslint-plugin-react 7.37.5 and
  // eslint-plugin-import 2.32.0, whose newest releases peer eslint <=9 and still call context methods ESLint 10
  // REMOVED. MEASURED: without this, every file fails at load with `react/display-name:
  // contextOrFilename.getFilename is not a function`. @eslint/compat (the ESLint team's bridge) restores those
  // methods on the rule context; it changes no rule and no severity. DROP IT when both plugins (as shipped by
  // eslint-config-expo) declare eslint 10 in their peers — then `expoConfig` goes back in unwrapped.
  ...fixupConfigRules(expoConfig),
  // PARITY WITH THE ESLINT 8 RESULT — four settings, each kept at what `main` resolved, because each one would
  // otherwise report on today's code. eslint-config-expo's FLAT preset is not its legacy preset re-expressed:
  // it takes eslint-plugin-react's `flat.recommended` (a dozen react rules warn -> error, plus jsx-key,
  // no-unescaped-entities, …) and eslint-plugin-import's `flatConfigs.warnings`, and ESLint 9+ reports unused
  // disable directives by default. Every OTHER difference is adopted as-is; it reports nothing today (measured
  // with `--print-config` and `-f json` against `main`, research.md R6). These four are not new exemptions —
  // `main` never ran them. Turning them on means fixing what they report (33 findings in mcm-app, 0 in
  // design-system), which is its own change, not a side effect of the format migration.
  {
    linterOptions: {
      // ESLint 8's default. ESLint 9+ defaults to 'warn': 9 stale directives in mcm-app.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // Absent from the legacy preset. Flat preset: error. 4 findings (a literal ' in JSX text).
      'react/no-unescaped-entities': 'off',
      // Absent from the legacy preset. Flat preset: warn. 10 findings (5 modules imported twice).
      'import/no-duplicates': 'off',
      // Absent from the legacy preset. Flat preset: warn. 14 findings, every one `axios.create` /
      // `axios.isAxiosError` on axios's default export (its documented API; the tests mock that export).
      'import/no-named-as-default-member': 'off',
    },
  },
]);
