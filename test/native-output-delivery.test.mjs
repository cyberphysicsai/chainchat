import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {authorizeNativeOutputDelivery,validateNativeOutputPermit} from '../openclaw/plugin/output-delivery.mjs';
const original='/private/native/media/tool-speech-synthesis/new.wav',ownedFile='/private/owned/hash/content.wav';
const row={original,ownedFile,assetId:'a'.repeat(64),sha256:'b'.repeat(64)};
const projected={text:'A careful greeting.',mediaUrls:[original],mediaUrl:original,audioAsVoice:true};
const run=(payload=projected,options={})=>authorizeNativeOutputDelivery({candidate:'A careful greeting.\nMEDIA:'+original,deliveries:[row],normalize:async()=>[projected],payload,...options});
test('only exact native-normalized reviewed media references are rewritten to their captured owned copies',async()=>{
  const accepted=await run();assert.deepEqual(accepted,{text:projected.text,mediaUrls:[ownedFile],mediaUrl:ownedFile,audioAsVoice:true});
  assert.deepEqual(await run(accepted),accepted,'A later delivery hook may revalidate the same immutable copy.');
  for(const payload of [{...projected,text:'Changed'}, {...projected,mediaUrl:'https://example.test/x',mediaUrls:['https://example.test/x']},
    {...projected,mediaUrls:[],mediaUrl:undefined},{...projected,audioAsVoice:false},{...projected,channelData:{}},
    {...projected,attachments:[{path:original}]},{...projected,replyToId:'unreviewed-target'}]) await assert.rejects(run(payload));
  await assert.rejects(run(projected,{deliveries:[]}));
  await assert.rejects(run(projected,{normalize:async()=>[]}));
});
test('private output permits must match both the raw candidate and reviewed asset digests',()=>{
  const binding={candidateSha256:'c'.repeat(64),outputAssetsSha256:'d'.repeat(64)};
  const response={allowed:true,purpose:'candidate',...binding,delivery:{text:'A careful greeting.',mediaUrls:[ownedFile],mediaUrl:ownedFile}};
  assert.deepEqual(validateNativeOutputPermit(response,binding),response.delivery);
  for(const changed of [{candidateSha256:'e'.repeat(64)},{outputAssetsSha256:'e'.repeat(64)},{purpose:'utility'},
    {delivery:{text:'A careful greeting.',channelData:{unreviewed:true}}}])assert.throws(()=>validateNativeOutputPermit({...response,...changed},binding));
});
test('pinned public SDK supplies exact MEDIA, voice, reply and citation normalization',{
  skip:!process.env.CT_OPENCLAW_PACKAGE?'Set the actual pinned package for SDK projection.':false,
},async()=>{
  const sdk=await import(pathToFileURL(path.join(process.env.CT_OPENCLAW_PACKAGE,'dist/plugin-sdk/channel-outbound.js')).href);
  const normalize=async candidate=>sdk.projectOutboundPayloadPlanForDelivery(sdk.createOutboundPayloadPlan([{text:candidate}]));
  const candidate='[[reply_to_current]] [[audio_as_voice]]\nA careful greeting.\nMEDIA:'+original;
  const plan=await normalize(candidate);assert.equal(plan.length,1);assert.equal(plan[0].audioAsVoice,true);
  const delivery=await run(plan[0],{candidate,normalize});assert.deepEqual(delivery.mediaUrls,[ownedFile]);assert.equal(delivery.text,plan[0].text);
  assert.equal(delivery.replyToCurrent,true);
});
