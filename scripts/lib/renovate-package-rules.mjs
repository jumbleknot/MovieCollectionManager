/**
 * The repository's Renovate packageRule model, shared by the guards that assert RESOLVED grouping.
 *
 * Extracted from renovate-workflow.guard.test.mjs (feature 081 US10) so that
 * tamagui-version-lockstep.guard.test.mjs resolves groups through the SAME model rather than a second
 * copy that could drift from it. The semantics and the fail-closed checks are unchanged; see the
 * comment block above `NX_FAMILY` in renovate-workflow.guard.test.mjs for why "later rules win" is the
 * one semantic modelled and why presets are deliberately excluded.
 */

/**
 * Does one packageRule match a dependency? Models only the `match*` forms this config actually uses,
 * and THROWS on any it does not know — a guard that silently treats an unrecognised matcher as
 * "no match" would quietly stop asserting the moment someone adds a rule form, which is the failure
 * mode this whole file exists to prevent.
 */
export function ruleMatches(rule, dep) {
  const known = new Set([
    'description',
    'matchManagers',
    'matchPackageNames',
    'matchUpdateTypes',
    'matchDatasources',
    'matchFileNames',
    'groupName',
    'automerge',
    'enabled',
    'minimumReleaseAge',
    'prPriority',
    'matchCurrentVersion',
    'dependencyDashboardApproval',
    'allowedVersions',
    // Item #349. Per-registry timestamp behaviour; see the `timestamp-optional` rule in renovate.json.
    'minimumReleaseAgeBehaviour',
    // Feature 063 / item #297. Added here FIRST and on its own, because this set is deliberately
    // fail-closed: the moment `versioning` appears in renovate.json, every one of the 43 assertions
    // in this file throws on the unknown key rather than on its own subject. Teaching the model the
    // key changes no behaviour and asserts nothing new — it is what lets the assertions below say
    // anything at all.
    'versioning',
    // Feature 081 US10. `rangeStrategy: "pin"` on the `tamagui` group rule keeps the exact pins a lock
    // refresh cannot split. It changes how Renovate WRITES a specifier, never which rule matches, so
    // modelling it adds no matching semantics — it only stops the fail-closed check above throwing.
    'rangeStrategy',
  ]);
  for (const key of Object.keys(rule)) {
    if (!known.has(key)) {
      throw new Error(
        `packageRule uses '${key}', which this guard does not model — extend ruleMatches() before ` +
          'adding it, or the nx grouping assertion below silently stops meaning anything.',
      );
    }
  }

  const matchesName = (pattern, value) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('!')) {
      throw new Error(
        `matchPackageNames negation '${pattern}' is not modelled — extend ruleMatches() before using it.`,
      );
    }
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      return new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))).test(value);
    }
    return pattern === value;
  };

  if (rule.matchManagers && !rule.matchManagers.includes(dep.manager)) return false;
  if (rule.matchDatasources && !rule.matchDatasources.includes(dep.datasource)) return false;
  if (rule.matchUpdateTypes && !rule.matchUpdateTypes.includes(dep.updateType)) return false;
  if (rule.matchCurrentVersion) {
    // Only the one form this config uses. Anything else must be modelled before it is used, or the
    // rule silently matches everything — the same fail-open shape as an unknown label name.
    if (rule.matchCurrentVersion !== '<1.0.0') {
      throw new Error(`matchCurrentVersion '${rule.matchCurrentVersion}' is not modelled — extend ruleMatches().`);
    }
    if (dep.currentVersion === undefined) return false;
    if (!/^0\./.test(dep.currentVersion)) return false;
  }
  if (rule.matchFileNames && !rule.matchFileNames.includes(dep.packageFile)) return false;
  if (rule.matchPackageNames && !rule.matchPackageNames.some((p) => matchesName(p, dep.depName))) return false;
  return true;
}

/** The group a dep ends up in: the LAST matching rule that names one wins, as Renovate resolves it. */
export function resolvedGroupName(packageRules, dep) {
  let groupName = null;
  for (const rule of packageRules) {
    if (!ruleMatches(rule, dep)) continue;
    if (rule.groupName !== undefined) groupName = rule.groupName;
  }
  return groupName;
}
