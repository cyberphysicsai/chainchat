/** Actual native tool construction for owner discovery; never executes a tool. */
export const NATIVE_TOOL_CATALOGUE_METHOD='cypher-tempre.native.toolCatalogue';
const denied=()=>Object.assign(new Error('Native tool discovery is unavailable for this owner context.'),{code:'OPENCLAW_NATIVE_CATALOGUE_INVALID'});
export function createNativeToolCatalogue({loadSdk,configuration}={}) {
  return async(input,{assertCurrent=()=>{}}={})=>{
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='sessionKey')||
      input.sessionKey!==undefined&&(typeof input.sessionKey!=='string'||!/^agent:main:chainchat-control:[a-f0-9]{64}$/u.test(input.sessionKey)))throw denied();
    assertCurrent();const config=configuration(),sdk=await loadSdk();assertCurrent();
    if(typeof sdk.createOpenClawCodingToolsAsync!=='function'||!config?.agents?.defaults?.workspace)throw denied();
    const tools=await sdk.createOpenClawCodingToolsAsync({config,agentId:'main',workspaceDir:config.agents.defaults.workspace,
      ...(input.sessionKey?{sessionKey:input.sessionKey,runSessionKey:input.sessionKey}:{}),includeToolSearchControls:true});
    assertCurrent();if(!Array.isArray(tools)||tools.length>2048)throw denied();
    const rows=new Map();for(const tool of tools){
      if(typeof tool?.name!=='string'||tool.name.length>128||!tool.name||/[\0\r\n\u2028\u2029]/u.test(tool.name)||
        !/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/u.test(tool.name)||['__proto__','constructor','prototype'].includes(tool.name))throw denied();
      const label=typeof tool.label==='string'&&tool.label.length<=256&&!/[\0\r\n]/u.test(tool.label)?tool.label:tool.name;
      rows.set(tool.name,{id:tool.name,name:tool.name,label,source:'native-factory'});
    }return{tools:[...rows.values()]};
  };
}
export function registerNativeToolCatalogue(api){
  const catalogue=createNativeToolCatalogue({loadSdk:()=>import('openclaw/plugin-sdk/agent-harness'),
    configuration:()=>api.runtime?.config?.current?api.runtime.config.current({clone:true}):api.config});
  api.registerGatewayMethod(NATIVE_TOOL_CATALOGUE_METHOD,async({params,respond,hasCurrentClientAuthority})=>{
    const assertCurrent=()=>{if(typeof hasCurrentClientAuthority!=='function'||hasCurrentClientAuthority()!==true)throw denied();};
    try{respond(true,await catalogue(params,{assertCurrent}));}catch{const error=denied();respond(false,undefined,{code:error.code,message:error.message});}
  },{scope:'operator.admin',profileAccess:'independent'});
}
