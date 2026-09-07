'use strict';

/**
 * Keep the project-root dotenv files Expo cannot parse out of Metro's file map (item #242).
 *
 * THE BUG. `pnpm web` (and therefore playwright.config.ts's default Metro `webServer` target)
 * returned HTTP 500 for every request, with an Expo static-error page carrying:
 *
 *     SyntaxError: frontend/mcm-app/.env.e2e.local: Missing semicolon. (3:19)
 *       3 | E2E_MOVIE_TITLE=E2E Test Movie
 *
 * Babel was parsing a dotenv file as JavaScript.
 *
 * THE MECHANISM, measured 2026-09-07 by logging every `require.context` Metro derived. In
 * development, @expo/metro-config's transform-worker rewrites the virtual module
 * `expo/virtual/env.js` into
 *
 *     require.context(<projectRoot>, false, /^\.\/\.env/)
 *
 * so that editing a .env file hot-reloads the client bundle. That context takes EVERY file in
 * the project root whose name starts with `.env` and whose extension Metro crawls — Expo sets
 * `watcher.additionalExts = ['env', 'local', 'development']`. The very same worker then
 * dotenv-parses only the six names it knows:
 *
 *     .env  .env.local  .env.development  .env.development.local
 *     .env.production   .env.production.local
 *
 * Everything else falls through to the ordinary Babel JS transform. `.env.e2e.local` ends in
 * `.local`, so it IS crawled and IS a member of that context — and then Babel parses it as
 * JavaScript and the whole client bundle dies. (`.env.docker` escaped only by accident: its
 * `docker` extension is not in `additionalExts`, so Metro never crawled it. That is luck, not
 * design, and it is why this guard covers every unknown variant rather than one file name.)
 *
 * The two regexes simply disagree — the context is broader than the parser.
 *
 * WHY NOT REFORMAT THE FILE. No dotenv-valid formatting can satisfy a JavaScript parser:
 * quoting the space-containing values just moved the error onto the `#` comment line. The file's
 * format is also shared with scripts/maestro-run.sh (bash `source`), `docker run --env-file`,
 * and the Python `_load_env_file` helpers — three consumers with three different quoting
 * semantics, so it is not ours to rewrite.
 *
 * WHY A blockList AND NOT `watcher.additionalExts`. Dropping `'local'` from additionalExts would
 * also stop Metro crawling `.env.local`, which Expo legitimately reads. Blocking is the narrower
 * cut: these files are read at runtime with readFileSync by the Playwright / Maestro / Jest
 * integration harnesses, and nothing in the app bundle imports them, so Metro has no business
 * seeing them at all.
 */

/**
 * The optional suffix of a dotenv file name that @expo/metro-config's transform-worker parses.
 * Mirrors its own `/(^|\/)\.env(\.(local|(development|production)(\.local)?))?$/` — keep the two
 * in step if a future Expo SDK widens the set.
 */
const EXPO_PARSEABLE_SUFFIX = '(?:\\.(?:local|(?:development|production)(?:\\.local)?))?';

/** Escape a filesystem path for literal use inside a RegExp. */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A Metro `resolver.blockList` entry matching every dotenv file directly in `projectRoot` that
 * Expo will NOT dotenv-parse. Scoped to the root because that is the only directory the
 * `expo/virtual/env.js` context reads (it is non-recursive).
 *
 * @param {string} projectRoot absolute path to the Expo project root
 * @returns {RegExp} matches absolute paths, with either path separator (the repo is also
 *   developed from a Windows host, where Metro reports backslash-separated paths)
 */
function unparseableDotenvBlockList(projectRoot) {
  const root = escapeRegExp(projectRoot).replace(/\\\\|\//g, '[\\\\/]');
  return new RegExp(`^${root}[\\\\/]\\.env(?!${EXPO_PARSEABLE_SUFFIX}$)`);
}

module.exports = { unparseableDotenvBlockList };
