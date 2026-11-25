/** Verify the exact upstream Zod collection-size backport in embedded copies. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const expected = {
  "id": "embedded-zod-size-caps-v1",
  "upstreamVersion": "2026.11.10",
  "fixCommit": "a0ebf970f2d752e5f58527cd2942ff48be4f46bd",
  "files": [
    {
      "path": "node_modules/chrome-devtools-mcp/build/src/third_party/index.js",
      "originalSha256": "e1752f75684b672362dc3ae77a399407c509b76471fca08f967fc44fe2cb267b",
      "sha256": "003dca1baa7c6c22daaa843f3b387574e6f2ede044eeb77658950305927400b6"
    }
  ]
};
const maximumFileBytes = 12 * 1024 * 1024;
const maximumTotalBytes = 40 * 1024 * 1024;

export function zodSecurityDescriptor() { return structuredClone(expected); }

export async function assertZodSecurity(packageRoot, descriptor) {
  if (!isDeepStrictEqual(descriptor, expected))
    throw new Error('The embedded Zod security commitment is invalid.');
  packageRoot = path.resolve(packageRoot);
  const rootStat = await fs.lstat(packageRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(packageRoot) !== packageRoot)
    throw new Error('The owned runtime package is invalid.');
  const manifestFile = path.join(packageRoot, 'package.json'), manifestStat = await fs.lstat(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1 || manifestStat.size > 1024 * 1024)
    throw new Error('The owned runtime manifest is invalid.');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (manifest.name !== 'openclaw' || manifest.version !== expected.upstreamVersion)
    throw new Error('The Zod security overlay requires its exact reviewed OpenClaw release.');
  let total = 0;
  for (const row of expected.files) {
    const file = path.resolve(packageRoot, row.path), stat = await fs.lstat(file);
    total += stat.size;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximumFileBytes ||
        total > maximumTotalBytes || await fs.realpath(file) !== file ||
        createHash('sha256').update(await fs.readFile(file)).digest('hex') !== row.sha256)
      throw new Error('The embedded Zod security overlay is missing or changed; run the reviewed installer.');
  }
  return structuredClone(expected);
}
