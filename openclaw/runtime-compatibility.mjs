/** Verify the installed SDK admission and API-key policy overlays. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const expected = [
  {id: 'early-hook-input-provenance-v2', files: {
    'dist/embedded-agent-CSEHHQp1.mjs':['b704e9fb2490d409679480874c75827561a4d37afcbd3703871e747f02000ecd','cdaf10bfda63955c06e5d8502ad2fbd5d11ce849a97f8a47c90196b7bb6f659e'],
    'dist/cli-runner-D2YzRdD1.mjs':['04ad041e1393cc3a7e79ec55169b7975db984440b65dfbede4edb5f6f8e31edc','1cb77261f6975f8c3dcf9ea491aa54d66045938acdf97e712cd8ab970b6619e5'],
  }},
  {id: 'api-key-channel-auth-v1', files: {
    'dist/provider-auth-login-flow-runtime-BQWiIgu2.mjs':['6d70a5a4e381c34b35673f96f314c7cd5cca47c60694a25f27b2bbe02fcf0ac2','0b4357ae27c1f30303e0304c9820cdc507815d4e0bc38fd35952f28997d201a7'],
    'dist/commands-registry.data-BY7QvkMn.mjs':['2c3d0bae58985654be4bd2abc534957689d4ddc20fefadd82bbe7900338c4b49','9168a8311b80b9378334c32e5bc7cf302e05bea7677b9f71984485468f7db252'],
    'dist/models-auth-status-DajZt9YG.mjs':['1806a063b5b857e20acfaf3fb924d8ccde8aaa87533359a5832e6e13db70444c','a31adfb4b4708932c5cd6f8a979efbe01ab2cce33a8f85d03e12d02fde0d4402'],
  }},
  {id: 'admitted-tool-presentation-v1', files: {
    'dist/attempt-transcript-helpers-BEGc_WgE.mjs':['4e4bdc40e686429d73c118c4ff5072fc6fcf34cd822401db9f1c693b688f97f4','318cb78c420356d44fa6bcdc454ba4e77e1d1bcb634d8475de98f22b6395e7ba'],
  }},
  {id: 'managed-system-context-v1', files: {
    'dist/attempt-D0eWH9Mj.mjs':['d3b813a804ce7f4d6da2eb113a5832b79f7bbfcd18fa3c42eb24f6977d7fe52e','4a1aefcd4df65b3d8b8a5ce95080f660e8070a21706a8edc1e62c08f4d1b6f7f'],
  }},
  {id: 'managed-delivery-session-v1', files: {
    'dist/deliver-prepare-dxkuFNBI.mjs':['5eacbf1750f784a4300892d612a093a3a91724f44424964f344e267eaf2a43fe','e896ad070bbc1e4366f96201db51eca1cd1df4b3b5df6cb54fa04103a458cb2b'],
  }},
  {id: 'managed-generated-media-delivery-v1', files: {
    'dist/subagent-announce-delivery-BNgtsNUw.mjs':['fbe693c24c8349c0cf5a425b7fedbac3b3bf79e458a0932d626051e1e84f94e7','3e4a7fb79bbe71cf1fbbdde8e6b0a5bcf96a50548a77d2697eede0679a629a7b'],
  }},
];
function matchesCommitment(overlay, index) {
  const {id, files} = expected[index], count = Object.keys(files).length;
  return overlay?.id === id && overlay.upstreamVersion === '2026.11.10' &&
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
