/** Private invocation transport, independent of native persisted defaults. */
const fail=()=>Object.assign(new Error('The native model route differs from its admitted owner transport.'),{code:'OPENCLAW_MODEL_ROUTE_HELD',status:422});
const ids=Object.freeze({openai:'chainchat-openai',compatible:'chainchat-compatible',anthropic:'chainchat-anthropic',gemini:'chainchat-gemini'});
const name=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\0\r\n\u2028\u2029]/u.test(value);
export function modelRouteForConfig(config){
  if(config?.provider==='native')return{transport:'native'};
  const provider=ids[config?.provider];if(!provider)throw fail();
  return{transport:'proxy',provider,model:'route'};
}
export function validModelRoute(route){
  return route&&typeof route==='object'&&!Array.isArray(route)&&(route.transport==='native'&&Object.keys(route).length===1||
    route.transport==='proxy'&&Object.keys(route).sort().join(',')==='model,provider,transport'&&Object.values(ids).includes(route.provider)&&route.model==='route');
}
export function runtimeModelIdentity({runtimeSettings,model}={}){
  const actual=runtimeSettings?.model;
  if(runtimeSettings?.schemaVersion!==1||!name(actual?.provider)||!name(actual?.resolved)||model!==undefined&&model!==actual.resolved)throw fail();
  return{provider:actual.provider,model:actual.resolved};
}
export function assertModelRoute(route,actual){
  if(!validModelRoute(route)||!actual||Object.keys(actual).sort().join(',')!=='model,provider'||!name(actual.provider)||!name(actual.model)||
    route.transport==='proxy'&&(actual.provider!==route.provider||actual.model!==route.model)||
    route.transport==='native'&&actual.provider.startsWith('chainchat-'))throw fail();
  return true;
}
// Hook errors are isolated by upstream. Return an explicit closed route as
// well as denying the plugin state; never throw into a native paid fallback.
export const DENIED_MODEL_ROUTE=Object.freeze({providerOverride:'chainchat-denied',modelOverride:'held',fallbacksOverride:Object.freeze([])});
export function modelSelectionOverride(route){
  if(!validModelRoute(route))throw fail();
  return route.transport==='proxy'?{providerOverride:route.provider,modelOverride:route.model,fallbacksOverride:[]}:{};
}
