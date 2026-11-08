import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeToolCatalogue,registerNativeToolCatalogue,NATIVE_TOOL_CATALOGUE_METHOD} from '../openclaw/plugin/native-tool-catalogue.mjs';
test('private tool discovery constructs the actual SDK surface and returns names without execution or caller configuration',async()=>{
 let args,executed=false;
 const config={agents:{defaults:{workspace:'/private/managed'}},tools:{toolSearch:true}};
 const catalogue=createNativeToolCatalogue({configuration:()=>config,loadSdk:async()=>({createOpenClawCodingToolsAsync:async input=>{args=input;
  return[{name:'dispatch_action',label:'Dispatch',execute(){executed=true;}},{name:'tool_search'},{name:'read'}];}})});
 const sessionKey='agent:main:chainchat-control:'+'a'.repeat(64),result=await catalogue({sessionKey});
 assert.equal(args.config,config);assert.equal(args.includeToolSearchControls,true);assert.equal(args.agentId,'main');assert.equal(args.runSessionKey,sessionKey);
 assert.equal(executed,false);assert.deepEqual(result.tools.map(row=>row.name),['dispatch_action','tool_search','read']);assert.equal(JSON.stringify(result).includes('execute'),false);
 for(const input of [{agentId:'foreign'},{sessionKey:'agent:foreign:main'},{config:{}},{sessionKey:sessionKey+'\n'}])await assert.rejects(catalogue(input));
 await assert.rejects(catalogue({},{assertCurrent(){throw new Error('revoked');}}));
});
test('native catalogue RPC is private administrative metadata with fixed errors',async()=>{
 let method,handler,policy;
 registerNativeToolCatalogue({registerGatewayMethod(...args){[method,handler,policy]=args;},config:{}});
 assert.equal(method,NATIVE_TOOL_CATALOGUE_METHOD);assert.deepEqual(policy,{scope:'operator.admin',profileAccess:'independent'});
 let returned;await handler({params:{config:{private:'must not echo'}},hasCurrentClientAuthority:()=>false,respond:(...args)=>{returned=args;}});
 assert.equal(returned[0],false);assert.equal(JSON.stringify(returned).includes('must not echo'),false);
});
