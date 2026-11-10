/** Verify the installed SDK metadata and API-key policy overlays. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const expected = [
  {id: 'early-hook-input-provenance-v2', files: {
    'dist/embedded-agent-BJe8xfTT.mjs':['706bfad11e48c09d2d35ddace2c61296e1689ca8e260eae561cbdcd43389276e','0c85be2382d98a6038d0e01a04acc29bd655650414ff7152d74af99cba5853d8'],
    'dist/cli-runner-Cz6SuvHJ.mjs':['7cc8f440202c6804672a46f28383c821cbb6c97151c70088e75529dda779c97a','723fa26dd7717bb5ecdffa93745da5bc590153bdf9f672232459a6d728ccc109'],
  }},
  {id: 'api-key-channel-auth-v1', files: {
    'dist/provider-auth-login-flow-runtime-C2EOo219.mjs':['a38e4068297e840281f203a747ced7d8955f4b8e1c1a855377252ad4b3e0b58e','ca23bce2f5b4e88bf7de2f6c01ce0b3c947ade30453e1df925fea5d2895e87c4'],
    'dist/commands-registry.data-DP7hJyYX.mjs':['09b10d0b8b4068ab957da2a4820be85e086ae3a23c50b81b85518a2b324104cd','f780135f2b79706b59931c7f6e81019e626ab61c35bf6bcd0537138a29c01c1e'],
    'dist/models-auth-status-BJezSSIf.mjs':['12aa60af31a29c8a59c69e7f4638c52a1097a8133e1669cf638a8e7e290ea3e0','41ed7c57bec3a729d7a447642de2f5a998511d0e0fa78f8c34c1913b9caefeca'],
  }},
];
function matchesCommitment(overlay, index) {
  const {id, files} = expected[index], count = Object.keys(files).length;
  return overlay?.id === id && overlay.upstreamVersion === '2026.11.2' &&
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
