/** Verify the installed SDK metadata and API-key policy overlays. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const expected = [
  {id: 'early-hook-input-provenance-v2', files: {
    'dist/embedded-agent-F7NpHcMm.mjs':['b5ceac9f43ddedf372fc994a4ded3a0b10ce79aeea8520316c7a08eb9cb07d78','ca25bb54487aef08352019ccae8abba67cd6b1b0ecddf39a4626881d2eceef3b'],
    'dist/cli-runner-DR6cu3XG.mjs':['93908e0144dd44781aa0bf66b0d984dd397232eb35d18bca3120d7ef899b13bc','a7794c68daf999cdbf686a931f7707632fb9058f4721c1088bd4f7e361ea8a47'],
  }},
  {id: 'api-key-channel-auth-v1', files: {
    'dist/provider-auth-login-flow-runtime-B18ky3JD.mjs':['9fe0edd695bbcc8bcee55f3e62d532251ca51ccdc9737b3f39a979aa31826085','de9f6aac48d84f1754fdd6fda69802d0d6ef0908b2c053db61bcf21a6a92acab'],
    'dist/commands-registry.data-B0OqwBdv.mjs':['425b577731f45a7c7cf5bf213af873e21f34b1992196735e44b8fa64a34b0c98','10fd5e8c4b8b6d90670a98e6c4d8a7d4c6d737fafac933fa91b9366e133e357c'],
    'dist/models-auth-status-DnznMCDh.mjs':['05bbabd1db046df80dcc16d3918d829b9410f1fe24fcba69b28c41ce2122ce8f','87bcad538cf9378e739c92a2c48107c9a6813b1c89e1c5aafd39549fd55b4662'],
  }},
];
function matchesCommitment(overlay, index) {
  const {id, files} = expected[index], count = Object.keys(files).length;
  return overlay?.id === id && overlay.upstreamVersion === '2026.11.3' &&
    Object.keys(overlay).sort().join(',') === 'files,id,upstreamVersion' &&
    Array.isArray(overlay.files) && overlay.files.length === count &&
    overlay.files.every(row => row && Object.keys(row).sort().join(',') === 'originalSha256,path,sha256' &&
      Object.hasOwn(files, row.path) && files[row.path][0] === row.originalSha256 && files[row.path][1] === row.sha256) &&
    new Set(overlay.files.map(row => row.path)).size === count;
}
export async function assertRuntimeCompatibility(packageRoot){
  const lock=JSON.parse(await fs.readFile(new URL('./upstream-lock.json',import.meta.url),'utf8'));
  const overlays=lock.runtimeCompatibilityOverlays;
  if(!Array.isArray(overlays)||overlays.length!==expected.length||!overlays.every(matchesCommitment))
    throw new Error('The runtime compatibility commitment is invalid.');
  for(const row of overlays.flatMap(overlay=>overlay.files)){const file=path.resolve(packageRoot,row.path),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>2*1024*1024||await fs.realpath(file)!==file||
      createHash('sha256').update(await fs.readFile(file)).digest('hex')!==row.sha256)
      throw new Error('The installed runtime compatibility overlay is missing or changed; run the reviewed installer.');
  }
  return structuredClone(overlays);
}
