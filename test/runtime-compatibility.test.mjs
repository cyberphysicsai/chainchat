import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertRuntimeCompatibility} from '../openclaw/runtime-compatibility.mjs';

test('runtime refuses unreviewed or missing extracted metadata bytes',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ct-compat-doctor-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await assert.rejects(assertRuntimeCompatibility(root));
  const pins=JSON.parse(await fs.readFile(new URL('../openclaw/upstream-lock.json',import.meta.url),'utf8'));
  for(const row of pins.runtimeCompatibilityOverlays[0].files){await fs.mkdir(path.dirname(path.join(root,row.path)),{recursive:true});await fs.writeFile(path.join(root,row.path),'unknown source');}
  await assert.rejects(assertRuntimeCompatibility(root),/missing or changed/);
});

test('runtime rejects a modified source commitment before reading SDK files',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ct-compat-pin-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pins=JSON.parse(await fs.readFile(new URL('../openclaw/upstream-lock.json',import.meta.url),'utf8'));
  await fs.copyFile(new URL('../openclaw/runtime-compatibility.mjs',import.meta.url),path.join(root,'runtime-compatibility.mjs'));
  const isolated=await import(pathToFileURL(path.join(root,'runtime-compatibility.mjs')).href);
  for(const change of [{sha256:'0'.repeat(64)},{originalSha256:'0'.repeat(64)},{unreviewed:true}]){
    const changed=structuredClone(pins);Object.assign(changed.runtimeCompatibilityOverlays[0].files[0],change);
    await fs.writeFile(path.join(root,'upstream-lock.json'),JSON.stringify(changed));
    await assert.rejects(isolated.assertRuntimeCompatibility(root),/commitment/);
  }
  const legacy=structuredClone(pins);legacy.runtimeCompatibilityOverlays[0].id='early-hook-input-provenance-v1';
  await fs.writeFile(path.join(root,'upstream-lock.json'),JSON.stringify(legacy));
  await assert.rejects(isolated.assertRuntimeCompatibility(root),/commitment/);
});

test('real pinned metadata overlay passes doctor and changed bytes or link ownership fail',{
  skip:!process.env.CT_OPENCLAW_PACKAGE&&'requires exact reviewed SDK',
},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ct-compat-real-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pins=JSON.parse(await fs.readFile(new URL('../openclaw/upstream-lock.json',import.meta.url),'utf8'));
  for(const row of pins.runtimeCompatibilityOverlays[0].files){await fs.mkdir(path.dirname(path.join(root,row.path)),{recursive:true});await fs.copyFile(path.join(process.env.CT_OPENCLAW_PACKAGE,row.path),path.join(root,row.path));}
  assert.deepEqual(await assertRuntimeCompatibility(root),pins.runtimeCompatibilityOverlays);
  const first=path.join(root,pins.runtimeCompatibilityOverlays[0].files[0].path),bytes=await fs.readFile(first);
  const legacy=bytes.toString('utf8').replace(/^\t+currentSourceTurnId: params\.currentSourceTurnId,\n/mu,'');
  assert.notEqual(legacy,bytes.toString('utf8'));
  await fs.writeFile(first,legacy);
  await assert.rejects(assertRuntimeCompatibility(root),/missing or changed/,'Old v1 metadata bytes are not a supported installed v2 runtime.');
  await fs.writeFile(first,bytes);
  await fs.appendFile(first,'\n');
  await assert.rejects(assertRuntimeCompatibility(root),/missing or changed/);
  await fs.writeFile(first,bytes);
  const alias=path.join(root,'alias.mjs');await fs.link(first,alias);
  await assert.rejects(assertRuntimeCompatibility(root),/missing or changed/);
});
