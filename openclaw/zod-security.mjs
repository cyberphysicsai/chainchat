/** Verify the exact upstream Zod collection-size backport in embedded copies. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const expected = {
  "id": "embedded-zod-size-caps-v1",
  "upstreamVersion": "2026.11.3",
  "fixCommit": "a0ebf970f2d752e5f58527cd2942ff48be4f46bd",
  "files": [
    {
      "path": "dist/agents/harness/native-hook-relay-client.worker.js",
      "originalSha256": "4e22689c48f92af58ef929506cbcfe869c19805fd8cff5cee7897e088559425a",
      "sha256": "5c0c9a671150817f61c13362f3a200e2f3edc1d4437f6fb1529354b86081a511"
    },
    {
      "path": "dist/compile-wI2qQAAF.mjs",
      "originalSha256": "be8c3a8f65e20bcdf5c1bfc84597aef6a0ea308c7214bda413b4932d7ec2ddf5",
      "sha256": "5a0a69310f79e3ad0bec34a098878da9bc60eb8061a40c4bd01d37d2e906efcc"
    },
    {
      "path": "dist/config-doctor/schemas-C5K39dqU.js",
      "originalSha256": "08b8259d210c3f0af9651891186de143804d09dc7e3cfd3eade553166bddfbdc",
      "sha256": "408936ae1c700227667224b050c3fde90f745d16cfd166d1f7d623b2a31ad1d4"
    },
    {
      "path": "dist/extensions/a2a/.setup/channel-base-BbG6akl6.mjs",
      "originalSha256": "219dc4d2bdecc56f40f854db56c71c11374cafbedadfa5ed9ab4619cb59b0961",
      "sha256": "4ee422c8a7f6d37721af371c473cc41344b5940f0371889a174e4c0e84734bbc"
    },
    {
      "path": "dist/extensions/openai/capability-catalog.js",
      "originalSha256": "4e63dec6972c5221603b3c06f995ef3bce0dd72e130a42fcebef201f26f08cc4",
      "sha256": "17c17b450c22311bde0145a67e5b2a4b440d63f8013af55161754d685d82b802"
    },
    {
      "path": "dist/extensions/reef/.setup/channel-plugin-api-BUIz9qeQ.mjs",
      "originalSha256": "98d058f7f7ca3d909fbaf477c835411e8c49fb02b222ce992e15e5f75d3760bf",
      "sha256": "ddebf82fb27b960c636668f964a95d3b63f759ac66fa86be17b334dd92636780"
    },
    {
      "path": "dist/extensions/telegram/.setup/setup-plugin-api-DpPS-T6k.mjs",
      "originalSha256": "d2466d085de8c777fb35e38a7584e17f8fab152b93fd54b13fb4594553b29424",
      "sha256": "cf60869ad6954df5c0365cca075dd0f881b9d96608a8fd8d14cfa33f42bbbbf2"
    },
    {
      "path": "dist/infra/gateway-state-owner-heartbeat.worker.js",
      "originalSha256": "714d248a71822f8daab718aeeba3410d9a8fd9b092155bea1ffcf8c79cf4ef8c",
      "sha256": "3e79a227d4dd540ddda7a9e226bc6a9fbc979830782c30976410fb48e95fbd24"
    },
    {
      "path": "dist/infra/sqlite-readonly-schemas-CYdKD5YK.mjs",
      "originalSha256": "3c680f49fd5e4df9e0191243949fd892690994ca5df6258fbc2c8f92eca21c84",
      "sha256": "d67359de9fa51c3f3faee70616ee65806c8f49af0d346b871eb3d5c9a8025bb4"
    },
    {
      "path": "dist/json-schema-processors-C6KO_BFy.mjs",
      "originalSha256": "378fbcb16414bea6b37618814fcc9d549f4d75cb39ede64d2e87152b90916e54",
      "sha256": "84934ad5cb447fff4972de40b159082ab984f5994381cc8417c7dda6b862e1df"
    },
    {
      "path": "dist/managed-handoff-runtime.mjs",
      "originalSha256": "b16501053708e8b5c5379db163fb1598b4bd7c8e61261c9895c366129f315eb9",
      "sha256": "04938f29d9b39c6b32f355f59728d628649525b4464a902919141a8cb2572f57"
    },
    {
      "path": "dist/native-hook-relay/worker-task-pool-Cn7mBBG4.mjs",
      "originalSha256": "51541bc53b38728007b78aedebda4ac4c474503793fab91cdada700e6c15894d",
      "sha256": "2e2bb1550ef5b39f7cb8f57b3cab7690be872318d4a647219172932b2bbfe524"
    },
    {
      "path": "dist/package-update-activation-recovery.mjs",
      "originalSha256": "fb6828ca5b78a0255b923143786bb03179194e2e040c3b2d09fb32aa8d086999",
      "sha256": "087c29b61e71ca3f4cb7160705ede8807ac684697884fe2f5c778dcbe5ff6d67"
    },
    {
      "path": "dist/process/supervisor/service-child-group-anchor.js",
      "originalSha256": "dd9c7da91b967ade6b2b5928cfe9369228ec531728c3fa6e821b79b8a9561637",
      "sha256": "b3c7408cc3770d7ffaea7b9128762026c5ea476bdd65dba650b82beb4e6cd8f9"
    },
    {
      "path": "dist/state-retention/openclaw-state-db-cache-CaDjHBot.js",
      "originalSha256": "3fefdbfe7828164c9ed5fd704a0c7eb9a7cda50bd5a4bf315be0182584fca937",
      "sha256": "48fb105b43614df641c2f20cdb30a99202e5be0d92d5b07c955ab0f0338250d0"
    },
    {
      "path": "dist/state/openclaw-state-lease-heartbeat.worker.js",
      "originalSha256": "51b504cc0f5d757dbfa4109b5101000686ab9f5a89ab6cd40e9bbd4713d6000d",
      "sha256": "94ce51aa2b0a9089b38a5196596f814f67a7d91ebe7bc91d1bafd2bbe2928d6f"
    },
    {
      "path": "dist/state/openclaw-state-read-schemas-D2seJkFD.mjs",
      "originalSha256": "0f2f394e7266b62cd5819407cd971e7d79e98af215cb81ea0754b6e84eb6dc19",
      "sha256": "bac0b0fe0c012a93f494c0ae71bc9c6e1a9ab2b031f3218882a99cb91e1b84a8"
    },
    {
      "path": "node_modules/chrome-devtools-mcp/build/src/third_party/index.js",
      "originalSha256": "c988e0684584b75e87ae04b768c4f8ae7064401afe5187ec0d4878b2c6833f12",
      "sha256": "88ab4806cb6dafffc1f8f29d754472a90d8748a47189ca723c685c3c91f6c444"
    }
  ]
};
const maximumFileBytes = 12 * 1024 * 1024;
const maximumTotalBytes = 40 * 1024 * 1024;

export function zodSecurityDescriptor() { return structuredClone(expected); }

export async function assertZodSecurity(packageRoot, descriptor) {
  if (!isDeepStrictEqual(descriptor, expected) || expected.files.length !== 18)
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
