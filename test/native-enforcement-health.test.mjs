import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeEnforcementHealthDiagnostic} from '../openclaw/gateway.mjs';

test('mandatory health diagnostics distinguish fixed fault and transport categories without reflecting credentials',()=>{
  const secret='synthetic-private-health-fixture';
  assert.match(nativeEnforcementHealthDiagnostic({code:'OPENCLAW_CONTROL_CLOSED',message:secret}),/reason=OPENCLAW_CONTROL_CLOSED/);
  assert.match(nativeEnforcementHealthDiagnostic({message:'request timeout: '+secret}),/reason=PROBE_TIMEOUT/);
  assert.match(nativeEnforcementHealthDiagnostic({name:'GatewayClientRequestTimeoutError',message:secret},undefined,true,30001),/phase=startup reason=PROBE_TIMEOUT elapsedMs=30001/);
  assert.match(nativeEnforcementHealthDiagnostic(null,{healthy:false,reasonCode:'FACTORY_FAILED'},true),/phase=startup reason=FACTORY_FAILED/);
  assert.match(nativeEnforcementHealthDiagnostic(null,{healthy:false,nativeCompletionPolicy:false}),/reason=POLICY_MISMATCH/);
  for(const [error,result] of [[{code:secret,message:secret},undefined],[{message:'timed out '+secret},{reasonCode:secret}],[null,{healthy:false,reasonCode:secret}]]){
    const line=nativeEnforcementHealthDiagnostic(error,result);
    assert.equal(line.includes(secret),false);assert.match(line,/^\[chainchat\] mandatory health phase=runtime reason=[A-Z_]+\n$/u);
  }
});
