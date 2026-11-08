import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createNativeControlConnection,stopNativeControlClient} from '../openclaw/native-control-connection.mjs';

const error = code => Object.assign(new Error('Fixed private transport failure.'), {code});
const deferred = () => { let resolve,reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
function fixture({factory} = {}) {
  let owner = {generation:1};
  const clients=[],timers=[],events=[],diagnostics=[];
  function client(callbacks) {
    const value={callbacks,connected:false,starts:0,stops:0,requests:[],
      start(){this.starts++;},stop(){this.stops++;this.connected=false;},
      stopAndWait(){this.stop();return Promise.resolve();},
      async request(method){this.requests.push(method);return {ok:true};},
      hello(){this.connected=true;callbacks.onHelloOk();},
      close(){this.connected=false;callbacks.onClose(1006,'private-frame-text');},
    };
    clients.push(value);return value;
  }
  const manager=createNativeControlConnection({getOwner:()=>owner,isOwnerCurrent:value=>value===owner,
    createClient:(callbacks,snapshot)=>factory ? factory(callbacks,snapshot,client) : client(callbacks),
    onEvent:event=>events.push(event),onCloseDiagnostic:(snapshot,code)=>diagnostics.push({generation:snapshot.generation,code}),
    closeError:()=>error('CLOSED'),authenticationError:()=>error('AUTH'),timeoutError:()=>error('TIMEOUT'),
    setTimer:callback=>{const timer={callback,cleared:false};timers.push(timer);return timer;},
    clearTimer:timer=>{if(timer)timer.cleared=true;},
  });
  async function connect(){const pending=manager.ready();await nextTurn();const value=clients.at(-1);value.hello();assert.equal(await pending,value);return value;}
  return {manager,clients,timers,events,diagnostics,connect,changeOwner(){owner={generation:owner.generation+1};}};
}

test('one authenticated hello is required and concurrent setup remains single-flight',async()=>{
  const f=fixture(),a=f.manager.ready(),b=f.manager.ready();assert.equal(a,b);await nextTurn();
  assert.equal(f.clients.length,1);const client=f.clients[0];assert.equal(client.starts,1);
  client.callbacks.onEvent({event:'untrusted-before-hello'});assert.deepEqual(f.events,[]);
  let resolved=false;a.then(()=>{resolved=true;});await nextTurn();assert.equal(resolved,false);
  client.hello();assert.equal(await a,client);assert.equal(await f.manager.ready(),client);
  client.callbacks.onEvent({event:'current'});assert.deepEqual(f.events,[{event:'current'}]);
  f.manager.invalidate();
});

test('health projection is read-only and loses readiness for a closed or obsolete owner', async () => {
  const f = fixture();
  assert.equal(f.manager.isReady(), false); assert.equal(f.clients.length, 0);
  const client = await f.connect(); assert.equal(f.manager.isReady(), true);
  assert.equal(f.clients.length, 1); assert.equal(client.requests.length, 0);
  f.changeOwner(); assert.equal(f.manager.isReady(), false); assert.equal(f.clients.length, 1);
  f.manager.invalidate(); assert.equal(f.manager.isReady(), false);
});

test('late stopped-client callbacks and an old run cleanup cannot abort or clear a newer run',async()=>{
  const f=fixture(),a=await f.connect();let oldClosed=0,newClosed=0;
  const oldCleanup=f.manager.subscribeClose(a,()=>oldClosed++),oldTimer=f.timers[0];
  assert.equal(f.manager.invalidate(),a);assert.equal(oldClosed,1);assert.equal(a.stops,1);
  // SDK stopAndWait may have resolved while its physical close is still queued.
  const b=await f.connect();f.manager.subscribeClose(b,()=>newClosed++);oldCleanup();
  a.close();a.callbacks.onConnectError(new Error('private auth details'));a.callbacks.onHelloOk();
  a.callbacks.onEvent({event:'late-private-event'});oldTimer.callback();
  assert.equal(newClosed,0);assert.equal(await f.manager.ready(),b);assert.equal(b.stops,0);
  assert.deepEqual(f.events,[]);assert.equal(f.clients.length,2);
  b.close();assert.equal(newClosed,1);assert.equal(oldClosed,1);
});

test('a retired asynchronous factory cannot start its client or replace the new connection',async()=>{
  const gate=deferred();let number=0;
  const f=fixture({factory:async(callbacks,_owner,make)=>{if(++number===1)await gate.promise;return make(callbacks);}});
  const old=f.manager.ready();await nextTurn();f.manager.invalidate();await assert.rejects(old,{code:'CLOSED'});
  const b=await f.connect();gate.resolve();await nextTurn();
  const a=f.clients.find(value=>value!==b);assert.equal(a.starts,0);assert.equal(a.stops,1);
  assert.equal(await f.manager.ready(),b);assert.equal(b.stops,0);f.manager.invalidate();
});

test('an old rejected setup cannot clear the current ready promise',async()=>{
  const gate=deferred();let number=0;
  const f=fixture({factory:(callbacks,_owner,make)=>++number===1?gate.promise:make(callbacks)});
  const old=f.manager.ready();await nextTurn();f.manager.invalidate();await assert.rejects(old,{code:'CLOSED'});
  const b=await f.connect();gate.reject(new Error('old private failure'));await nextTurn();
  assert.equal(await f.manager.ready(),b);assert.equal(f.clients.length,1);assert.equal(b.stops,0);f.manager.invalidate();
});

test('current pre-hello close rejects promptly and a future connection needs its own hello',async()=>{
  const f=fixture(),pending=f.manager.ready();await nextTurn();const a=f.clients[0];a.close();
  await assert.rejects(pending,error=>error.code==='CLOSED'&&!error.message.includes('private-frame-text'));
  assert.equal(a.stops,1);assert.equal(f.timers[0].cleared,true);
  const future=f.manager.ready();await nextTurn();const b=f.clients[1];let resolved=false;future.then(()=>{resolved=true;});
  a.callbacks.onHelloOk();await nextTurn();assert.equal(resolved,false);
  b.hello();assert.equal(await future,b);f.manager.invalidate();
});

test('negative transport liveness invalidates only the ready client, not a pending handshake',async()=>{
  const f=fixture(),a=await f.connect();let closed=0;f.manager.subscribeClose(a,()=>closed++);
  a.connected=false;const pending=f.manager.ready();assert.equal(f.manager.ready(),pending);await nextTurn();
  assert.equal(a.stops,1);assert.equal(closed,1);assert.equal(f.clients.length,2);
  assert.equal(f.manager.ready(),pending);const b=f.clients[1];b.hello();assert.equal(await pending,b);f.manager.invalidate();
});

test('current authentication failure retires its client without reflecting SDK details or affecting its replacement',async()=>{
  const f=fixture(),a=await f.connect();let failure;
  f.manager.subscribeClose(a,error=>{failure=error;});a.callbacks.onConnectError(new Error('private-provider-secret'));
  assert.equal(failure.code,'AUTH');assert.equal(failure.message.includes('private-provider-secret'),false);assert.equal(a.stops,1);
  const b=await f.connect();let replacementClosed=false;f.manager.subscribeClose(b,()=>{replacementClosed=true;});
  a.callbacks.onConnectError(new Error('late private failure'));a.close();
  assert.equal(replacementClosed,false);assert.equal(await f.manager.ready(),b);f.manager.invalidate();
});

for(const terminal of ['close','authentication-error']) {
  test(`owner exit before current ${terminal} immediately retires that client and notifies its run`,async()=>{
    const f=fixture(),a=await f.connect();let closed=0;
    f.manager.subscribeClose(a,()=>closed++);f.changeOwner();
    if(terminal==='close')a.close();else a.callbacks.onConnectError(new Error('private auth details'));
    assert.equal(closed,1,'The exact current run must fail without waiting for another RPC or its watchdog.');
    assert.equal(a.stops,1,'The expired-owner client must not keep SDK auto-reconnect alive.');
    const b=await f.connect();let replacementClosed=false;f.manager.subscribeClose(b,()=>{replacementClosed=true;});
    a.close();a.callbacks.onConnectError(new Error('late error'));
    assert.equal(replacementClosed,false);assert.equal(await f.manager.ready(),b);f.manager.invalidate();
  });
  test(`owner exit before pre-hello ${terminal} rejects setup without waiting for the handshake deadline`,async()=>{
    const f=fixture(),pending=f.manager.ready();let rejected;
    pending.catch(error=>{rejected=error;});await nextTurn();const a=f.clients[0];f.changeOwner();
    if(terminal==='close')a.close();else a.callbacks.onConnectError(new Error('private auth details'));
    await nextTurn();assert.equal(rejected?.code,terminal==='close'?'CLOSED':'AUTH');
    assert.equal(a.stops,1);assert.equal(f.timers[0].cleared,true);await assert.rejects(pending);
  });
}

for(const method of ['chat.send','sessions.goal.update','config.set','browser']) {
  test(`a failed ${method} is sent once and never replayed on a future connection`,async()=>{
    const f=fixture(),a=await f.connect();let rejected=0;f.manager.subscribeClose(a,()=>rejected++);
    a.request=async name=>{a.requests.push(name);a.close();throw error('REQUEST_CLOSED');};
    await assert.rejects(a.request(method),{code:'REQUEST_CLOSED'});assert.equal(rejected,1);
    const b=await f.connect();await nextTurn();assert.deepEqual(a.requests,[method]);assert.deepEqual(b.requests,[]);
    a.close();assert.equal(rejected,1);assert.equal(await f.manager.ready(),b);f.manager.invalidate();
  });
}

test('an owner change during setup cannot publish or start the stale client',async()=>{
  const gate=deferred();const f=fixture({factory:async(callbacks,_owner,make)=>{await gate.promise;return make(callbacks);}});
  const pending=f.manager.ready();await nextTurn();f.changeOwner();gate.resolve();
  await assert.rejects(pending,{code:'CLOSED'});assert.equal(f.clients[0].starts,0);assert.equal(f.clients[0].stops,1);
});

test('timeout fences pending factory work and retired timers cannot affect the next connection',async()=>{
  const gate=deferred();let number=0;
  const f=fixture({factory:async(callbacks,_owner,make)=>{if(++number===1)await gate.promise;return make(callbacks);}});
  const pending=f.manager.ready();await nextTurn();const oldTimer=f.timers[0];oldTimer.callback();
  await assert.rejects(pending,{code:'TIMEOUT'});const b=await f.connect();oldTimer.callback();
  gate.resolve();await nextTurn();assert.equal(await f.manager.ready(),b);assert.equal(b.stops,0);
  assert.equal(f.clients.find(value=>value!==b).starts,0);f.manager.invalidate();
});

test('cleanup has a total external bound even when SDK final storage drain never settles',async()=>{
  let requested=false;const client={stopAndWait(){requested=true;return new Promise(()=>{});}};
  const before=performance.now();await stopNativeControlClient(client,10);
  assert.equal(requested,true);assert.ok(performance.now()-before<1000);
});
