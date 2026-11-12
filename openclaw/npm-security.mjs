import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Same reviewed bytes as installer/npm_security.py. The original npm SRI and
// package versions are retained; these installed file hashes attest backports.
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const NPM_SECURITY_DESCRIPTOR = freeze({
  "id": "npm-12.2.2-bundled-security-v1",
  "package": {
    "name": "npm",
    "version": "12.2.2"
  },
  "globEntryMode": "official-raw-forwarders",
  "advisories": [
    "GHSA-3g3m-2fjr-6pw4",
    "GHSA-g3hv-75wg-m249",
    "GHSA-c859-jr93-m5j4"
  ],
  "upstreamPatches": [
    "https://github.com/isaacs/node-glob/commit/4682e8c9babee1b385202ede36389634e12076d7",
    "https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8",
    "https://github.com/isaacs/minimatch/commit/73f0e1b1abcb97edf97b7c7a4b9132a141496338",
    "https://github.com/isaacs/minimatch/commit/9c6ebb18f45ff2f06003aea084c39a92a6ff7dbd",
    "https://github.com/isaacs/minimatch/commit/2d5578ba60f06bd6f362bd6c332b122c796bdd4d",
    "https://github.com/isaacs/minimatch/commit/784603e09641970d2ba2caf8c73a95d1015cc67d"
  ],
  "files": [
    {
      "path": "node_modules/glob/dist/commonjs/walker.js",
      "originalSha256": "1138ced9d5429681a1740af32d13391a38184a3376d1d9d56eea64b7a43274a1",
      "sha256": "8dc8d70dda5219f6351d8267acf30bc17b0a97b353862db7edb8e234c4a38479"
    },
    {
      "path": "node_modules/glob/dist/commonjs/index.min.js",
      "originalSha256": "3178e109aa75b45d6970a51a718f01e5b5b8f87150563ee6cb4c0e75ec215617",
      "sha256": "8821342a5777229e58e6fd57ebfad9f8a18a476e02a6933049bb5412be393204"
    },
    {
      "path": "node_modules/glob/dist/esm/walker.js",
      "originalSha256": "3e15af549ecc74d8691982d571168fd4b0e38b494c2cbb3edcfb8f97d4036ac6",
      "sha256": "9e07bcdb1fe1ad47fd593cd9c89a1dc4e91d49e21392f19f9b62797e010852dd"
    },
    {
      "path": "node_modules/glob/dist/esm/index.min.js",
      "originalSha256": "9eff492e16fdf9ea47a5f3c3d64784f9238b607f95a278101eb5a4e882f6ea85",
      "sha256": "735600bb655a47acaf98ea0ea867c69a4984c37be9d1e74293bc750da05bbed2"
    },
    {
      "path": "node_modules/minimatch/dist/commonjs/index.js",
      "originalSha256": "d224f71f20d7c206fcc5b7e9f747324c7698345a0b2c28d717dd9cf698306783",
      "sha256": "b06dfc01bb62b61d2f97bdce59eee20f7c5708557a7e25e91fccb0f033886f76"
    },
    {
      "path": "node_modules/minimatch/dist/commonjs/escape.js",
      "originalSha256": "54b57f8f50c8e834f35a30c1848ac3f79acf8dd85894505f046afaf3965e63a0",
      "sha256": "d147f5713a26530ce089cf99eaa0537c5dc99bc4b085c7466ec982246d653d58"
    },
    {
      "path": "node_modules/minimatch/dist/esm/index.js",
      "originalSha256": "59821ec2ce0d3df968292036e5c831ad322b33e9c33a949ecbc9dfe125d165be",
      "sha256": "f80ffd4f76bac21aaf89210c8a1a0d5c5d142fc5cefbdf579075438980ae45f4"
    },
    {
      "path": "node_modules/minimatch/dist/esm/escape.js",
      "originalSha256": "8418e37c202bcd247e76b1c205d4eff9474f15fb76c1db1ef0688cb6a8ec3c94",
      "sha256": "d61cd0b8c7f8e06368320830bb80f12470a91e27e46c2dc2cbaa77c66390b79c"
    },
    {
      "path": "node_modules/minimatch/dist/commonjs/unescape.js",
      "originalSha256": "bec1bb4483a2c325599949dd6668b5b7daa2dcbe046c5a09899bc8c5b51c08c1",
      "sha256": "e154e594eac01e4dd5cd2a60785b8c07974345634743f52df2b91b9687b8ed99"
    },
    {
      "path": "node_modules/minimatch/dist/esm/unescape.js",
      "originalSha256": "2cd61ba96e616969f152445c61ec2ca129a0afd2028ea71309b862a4222304d6",
      "sha256": "685168109ac6f05b56ebda8fc6cc3744f3e791eb8ed2e5d9f7e0dbc9141803c6"
    }
  ]
});
const canonical = value => JSON.stringify(value, function (key, item) {
  if (item && typeof item === 'object' && !Array.isArray(item))
    return Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]));
  return item;
});
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function file(root, relative, limit = 2 * 1024 * 1024) {
  const filename = path.join(root, ...relative.split('/'));
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit ||
      !samePath(await fs.realpath(filename), filename))
    throw new Error('The npm security file ownership changed.');
  return fs.readFile(filename);
}
export async function assertNpmSecurity(npmRoot, descriptor) {
  if (NPM_SECURITY_DESCRIPTOR.files.length !== 10 || canonical(descriptor) !== canonical(NPM_SECURITY_DESCRIPTOR))
    throw new Error('The npm security commitment differs from the reviewed backport.');
  const root = path.resolve(npmRoot);
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(root), root))
    throw new Error('The exact owned npm package root is invalid.');
  const identity = JSON.parse((await file(root, 'package.json', 65536)).toString('utf8'));
  if (identity.name !== 'npm' || identity.version !== '12.2.2')
    throw new Error('The npm package differs from the reviewed security target.');
  for (const row of NPM_SECURITY_DESCRIPTOR.files) {
    const digest = createHash('sha256').update(await file(root, row.path)).digest('hex');
    if (digest !== row.sha256) throw new Error('The installed npm security backport failed verification.');
  }
  return structuredClone(NPM_SECURITY_DESCRIPTOR);
}
