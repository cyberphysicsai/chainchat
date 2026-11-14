import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createCompactionBroker} from '../openclaw/compaction-broker.mjs';
import {engine} from '../lib/engine.mjs';
import {DIMENSIONS, FRUITS} from '../lib/providers.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
test('compaction requires the inclusive 150 action minimum and preserves exact-source receipt checks', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-compaction-policy-'));
  const root = path.join(directory, 'agent');
  t.after(async () => {assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, {recursive:true, force:true});});
  await engine({op:'init', root, name:'Compaction policy fixture'});
  const ledger = path.join(root, 'chain/rings.jsonl'), before = await fs.readFile(ledger);
  for (const score of [149, 150, 179]) await t.test(String(score), async () => {
    const nativeOps = [], summary = 'The user asked for careful consideration of the question.';
    const broker = createCompactionBroker({engine, getParent:()=>null, authorize:async()=>{}, skill:'Verified fixture skill.',
      native:async (_parent, request) => {nativeOps.push(request.op); return engine(request);},
      generateSummary:async()=>({text:summary}), review:async()=>({approved:true, usedRings:[],
        scores:{...Object.fromEntries(DIMENSIONS.map(key=>[key,240])), covenant:score},
        fruitages:Object.fromEntries(FRUITS.map(key=>[key,score])), rationale:'A faithful and compatible record of the supplied transcript.'})});
    try {
      const sessionKey='agent:main:compaction-policy-'+score, runId='compaction-run-'+score, sessionId='compaction-session-'+score;
      await broker.registerCompactionInvocation({config:{provider:'compatible',model:'fixture',baseUrl:'http://127.0.0.1:9999/v1'},
        context:{root,input:'Summarize this transcript.',loadout:[],settings:{recall:false},authorize:async()=>{}},
        sessionKey,sessionId,operationId:'compaction-operation-'+score});
      const source={sessionId,branchSha256:hash('exact source '+score),firstKeptEntryId:'keep-user-turn',
        messages:[{role:'user',content:'Please consider the question carefully.'}]};
      const prepared=await broker.dispatch({op:'compaction_prepare',sessionKey,runId,source});
      const request={sessionKey,runId,claimId:prepared.claimId,sessionId,firstKeptEntryId:source.firstKeptEntryId,
        branchSha256:source.branchSha256,summarySha256:hash(summary),summary};
      if (score===149) {
        await assert.rejects(broker.dispatch({...request,op:'compaction_review'}),{code:'OPENCLAW_COMPACTION_HELD'});
        assert.equal(nativeOps.includes('evaluate_summary'),false,'A low score cannot reach native summary approval.');
      } else {
        const reviewed=await broker.dispatch({...request,op:'compaction_review'});
        assert.equal(reviewed.allowed,true); assert.equal(reviewed.receipt.reviewed,true);
        assert.equal(nativeOps.includes('evaluate_summary'),true);
        await assert.rejects(broker.dispatch({...request,op:'compaction_commit',receipt:{...reviewed.receipt,summarySha256:hash('changed')}}),{code:'OPENCLAW_COMPACTION_HELD'});
        assert.equal((await broker.dispatch({...request,op:'compaction_commit',receipt:reviewed.receipt})).allowed,true);
      }
      assert.deepEqual(await fs.readFile(ledger),before,'Reviewing a native transcript must not append a conversation ring.');
    } finally {broker.close();}
  });
});
