import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {StateStore} from '../lib/state.mjs';
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ct-selected-agent-')));t.after(async()=>{assert.ok(path.basename(root).startsWith('ct-selected-agent-'));await fs.rm(root,{recursive:true,force:true});});return{root,file:path.join(root,'agents.json')};}

test('an earlier array index remains readable by older releases while a sidecar remembers the selected ID',async t=>{
  const f=await fixture(t),records=[{id:'first',root:path.join(f.root,'first'),name:'First',owned:false},{id:'second',root:path.join(f.root,'second'),name:'Second',owned:false}];
  await fs.writeFile(f.file,JSON.stringify(records));const store=await new StateStore(f.root).load();
  assert.equal(store.selectedAgentId,'first');assert.deepEqual(store.agents,records);
  await store.select('second');const data=JSON.parse(await fs.readFile(f.file,'utf8'));
  assert.deepEqual(data,records);assert.ok(Array.isArray(data));
  assert.deepEqual(JSON.parse(await fs.readFile(store.selectionFile,'utf8')),{version:1,selectedId:'second'});
  assert.equal((await new StateStore(f.root).load()).selectedAgentId,'second');
});

test('automatic additions and concurrent child saves preserve the last explicit selection',async t=>{
  const f=await fixture(t),store=await new StateStore(f.root).load();
  const first=await store.add(path.join(f.root,'first'),'First',true,[]),second=await store.add(path.join(f.root,'second'),'Second',true,[]);
  assert.equal(store.selectedId,null);assert.equal(store.selectedAgentId,first.id);
  const [,child]=await Promise.all([store.select(second.id),store.add(path.join(f.root,'native-child'),'Native background child',true,[])]);
  child.nativeBinding={kind:'subagent',ownerAgentId:second.id};await store.save();
  const reopened=await new StateStore(f.root).load();assert.equal(reopened.agents.length,3);assert.equal(reopened.selectedAgentId,second.id);assert.notEqual(reopened.selectedAgentId,child.id);
});

test('invalid or absent saved selection falls back safely while unknown explicit selection leaves bytes unchanged',async t=>{
  const f=await fixture(t),agents=[{id:'first',root:path.join(f.root,'first')},{id:'second',root:path.join(f.root,'second')}];
  for(const selectedId of [undefined,'missing',null,{apiKey:'synthetic-never-persist'}]){
    await fs.rm(path.join(f.root,'selected-agent.json'),{force:true});
    await fs.writeFile(f.file,JSON.stringify({version:1,agents,...(selectedId!==undefined?{selectedId}:{})}));
    const store=await new StateStore(f.root).load();assert.equal(store.selectedAgentId,'first');await store.save();
    assert.equal((await fs.readFile(f.file,'utf8')).includes('synthetic-never-persist'),false);
    assert.equal((await fs.readFile(store.selectionFile,'utf8')).includes('synthetic-never-persist'),false);
  }
  const store=await new StateStore(f.root).load(),before=await fs.readFile(f.file);
  await assert.rejects(store.select('missing'),/Unknown agent/);assert.deepEqual(await fs.readFile(f.file),before);
  await fs.writeFile(f.file,JSON.stringify({version:2,agents}));await assert.rejects(new StateStore(f.root).load(),/unreadable/);
});

test('an unpublished wrapper migrates back to an array and invalid sidecar metadata cannot inject a preference',async t=>{
  const f=await fixture(t),agents=[{id:'first',root:path.join(f.root,'first')},{id:'second',root:path.join(f.root,'second')}];
  await fs.writeFile(f.file,JSON.stringify({version:1,agents,selectedId:'second'}));
  const migrated=await new StateStore(f.root).load();assert.equal(migrated.selectedAgentId,'second');await migrated.save();
  assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),agents);
  assert.equal((await new StateStore(f.root).load()).selectedAgentId,'second');
  for(const text of ['broken',JSON.stringify({version:1,selectedId:'missing'}),JSON.stringify({version:1,selectedId:'second',apiKey:'synthetic-secret'}),JSON.stringify({version:2,selectedId:'second'})]){
    await fs.writeFile(migrated.selectionFile,text);assert.equal((await new StateStore(f.root).load()).selectedAgentId,'first');
  }
});
