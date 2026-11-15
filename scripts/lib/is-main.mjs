// Is this module the script node was asked to run? Pass `import.meta.url`.
//
// Compare URLs built the same way: pathToFileURL applies the same drive-letter form and
// percent-encoding as import.meta.url. The old `file://${process.argv[1]}` never matched a Windows
// path, so a script exited 0 having run nothing (scripts/__tests__/cli-entry-guard.guard.test.mjs).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isMain(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return moduleUrl === pathToFileURL(resolve(argv1)).href;
}
