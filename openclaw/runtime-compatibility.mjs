/** Verify installed, explicit metadata-only SDK compatibility bytes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const expected=Object.freeze({
  'dist/embedded-agent-BgECZgbU.mjs':['cdbef6f9013548d66f1786e842406528cc0196dda9c28faa41ae596abdc2f402','cc5b8cdad70c8b50a3a4a3bd0a309e3fd3dc74c43e1934cc0e9094c705de68c4'],
  'dist/cli-runner-WFa8e-nn.mjs':['c7a6f8d6a0d4f430dc83c36e0508e3b30affc4136828392a1ddd169b6e96c842','60ec71f91555bb10f92039a867a29e9dd6c69678138d7c572157b8d1d03042b4'],
});
export async function assertRuntimeCompatibility(packageRoot){
  const lock=JSON.parse(await fs.readFile(new URL('./upstream-lock.json',import.meta.url),'utf8'));
  const overlays=lock.runtimeCompatibilityOverlays,overlay=overlays?.[0];
  if(!Array.isArray(overlays)||overlays.length!==1||overlay.id!=='early-hook-input-provenance-v2'||overlay.upstreamVersion!=='2026.10.10'||
    Object.keys(overlay).sort().join(',')!=='files,id,upstreamVersion'||
    !Array.isArray(overlay.files)||overlay.files.length!==2||overlay.files.some(row=>!row||Object.keys(row).sort().join(',')!=='originalSha256,path,sha256'||expected[row.path]?.[0]!==row.originalSha256||expected[row.path]?.[1]!==row.sha256)||new Set(overlay.files.map(row=>row.path)).size!==2)
    throw new Error('The runtime compatibility commitment is invalid.');
  for(const row of overlay.files){const file=path.resolve(packageRoot,row.path),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>2*1024*1024||await fs.realpath(file)!==file||
      createHash('sha256').update(await fs.readFile(file)).digest('hex')!==row.sha256)
      throw new Error('The installed runtime metadata compatibility overlay is missing or changed; run the reviewed installer.');
  }
  return structuredClone(overlays);
}
