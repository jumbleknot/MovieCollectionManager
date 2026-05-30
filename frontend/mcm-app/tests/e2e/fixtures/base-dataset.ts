/**
 * T007 (test infrastructure): Typed fixture dataset for E2E tests.
 *
 * The single source of truth for the base data set seeded by global setup
 * (web: tests/e2e/web/setup/global-setup.ts; mobile: tests/e2e/mobile/_setup-fixtures.yaml).
 * Search/filter tests derive their exact expected counts from FIXTURE_MOVIES (FR-010),
 * so this file — not the database — defines what "correct" means.
 *
 * Collections:
 *   BROWSE   — read-only; search/filter/column tests assert against it. Repaired on each setup run.
 *   MUTATION — write tests create/delete here; reset to empty at the start of every setup run.
 *   DEFAULT  — used by the FR-009 auto-redirect (default collection) test.
 */

export const FIXTURE_COLLECTIONS = {
  BROWSE: 'E2E Browse',
  MUTATION: 'E2E Mutation',
  DEFAULT: 'E2E Default',
} as const;

export type FixtureCollection =
  (typeof FIXTURE_COLLECTIONS)[keyof typeof FIXTURE_COLLECTIONS];

export interface FixtureMovie {
  id: string;
  title: string;
  contentType: 'Movie' | 'Series' | 'Concert';
  rated: string;
  owned: boolean;
  ripped: boolean;
  ownedMedia: string[];
  genres: string[];
  decade: string;
}

export const FIXTURE_MOVIES: FixtureMovie[] = [
  { id: 'M1',  title: 'Alpha',   contentType: 'Movie',   rated: 'R',       owned: true,  ripped: true,  ownedMedia: ['Blu-Ray'],     genres: ['Action'],           decade: '2010s' },
  { id: 'M2',  title: 'Beta',    contentType: 'Series',  rated: 'PG',      owned: false, ripped: false, ownedMedia: [],              genres: ['Drama'],            decade: '2000s' },
  { id: 'M3',  title: 'Gamma',   contentType: 'Concert', rated: 'NR',      owned: true,  ripped: false, ownedMedia: ['DVD'],         genres: ['Music'],            decade: '1990s' },
  { id: 'M4',  title: 'Delta',   contentType: 'Movie',   rated: 'G',       owned: true,  ripped: true,  ownedMedia: ['UHD Blu-Ray'], genres: ['Family', 'Comedy'], decade: '2020s' },
  { id: 'M5',  title: 'Epsilon', contentType: 'Series',  rated: 'PG-13',   owned: false, ripped: false, ownedMedia: [],              genres: ['Thriller'],         decade: '2010s' },
  { id: 'M6',  title: 'Zeta',    contentType: 'Movie',   rated: 'NC-17',   owned: true,  ripped: true,  ownedMedia: ['Blu-Ray 3D'],  genres: ['Horror'],           decade: '1980s' },
  { id: 'M7',  title: 'Eta',     contentType: 'Movie',   rated: 'Unrated', owned: false, ripped: false, ownedMedia: [],              genres: ['Documentary'],      decade: '1970s' },
  { id: 'M8',  title: 'Theta',   contentType: 'Series',  rated: 'R',       owned: true,  ripped: false, ownedMedia: ['DVD'],         genres: ['Action', 'Drama'],  decade: '2000s' },
  { id: 'M9',  title: 'Iota',    contentType: 'Concert', rated: 'G',       owned: true,  ripped: true,  ownedMedia: ['Blu-Ray'],     genres: ['Classical'],        decade: '2020s' },
  { id: 'M10', title: 'Kappa',   contentType: 'Movie',   rated: 'PG',      owned: false, ripped: false, ownedMedia: [],              genres: ['Animation'],        decade: '1990s' },
];
