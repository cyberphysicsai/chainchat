/** Private, single-flight transport ownership. It never retries an RPC. */
export function createNativeControlConnection({ getOwner, isOwnerCurrent, createClient, onEvent,
  onCloseDiagnostic, closeError, authenticationError, timeoutError, timeoutMs = 20000,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let current = null, epoch = 0;
  const isRecordCurrent = record => current === record && !record.retired && record.epoch === epoch;
  const isCurrent = record => isRecordCurrent(record) && isOwnerCurrent(record.owner);
  const stop = record => {
    if (!record.client || record.stopIssued) return;
    record.stopIssued = true;
    try { record.client.stop(); } catch {}
  };
  function retire(record, error) {
    if (record.retired) return;
    record.retired = true;
    clearTimer(record.timer);
    if (current === record) { current = null; epoch++; }
    record.reject(error);
    const listeners = [...record.closeListeners]; record.closeListeners.clear();
    // Stop synchronously: the SDK otherwise schedules reconnect after onClose.
    stop(record);
    for (const listener of listeners) { try { listener(error); } catch {} }
  }
  function ready() {
    if (current && (!isCurrent(current) || current.ready && current.client.connected === false))
      retire(current, closeError());
    if (current) return current.promise;
    const owner = getOwner();
    if (!isOwnerCurrent(owner)) return Promise.reject(closeError());
    const record = { owner, epoch: ++epoch, retired: false, ready: false, client: null,
      stopIssued: false, closeListeners: new Set(), timer: null };
    record.promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
    // Retirement may precede a caller awaiting a shared setup promise.
    record.promise.catch(() => {});
    current = record;
    record.timer = setTimer(() => { if (isRecordCurrent(record)) retire(record, timeoutError()); }, timeoutMs);
    const callbacks = {
      onHelloOk() {
        if (!isCurrent(record) || !record.client || record.ready) return;
        if (record.client.connected === false) { retire(record, closeError()); return; }
        clearTimer(record.timer); record.ready = true; record.resolve(record.client);
      },
      // Terminal failure removes this record even when its owned child has
      // already exited. Only positive hello/events need live-owner authority.
      onConnectError() { if (isRecordCurrent(record)) retire(record, authenticationError()); },
      onEvent(event) { if (isCurrent(record) && record.ready) onEvent?.(event); },
      onClose(code, reason) {
        // Historical closes remain useful diagnostics, never current authority.
        try { onCloseDiagnostic?.(record.owner, code); } catch {}
        if (isRecordCurrent(record)) retire(record, closeError(code, reason));
      },
    };
    Promise.resolve().then(() => createClient(callbacks, owner)).then(client => {
      record.client = client;
      if (!isCurrent(record)) {
        if (current === record) retire(record, closeError()); else stop(record);
        return;
      }
      client.start();
    }).catch(() => { if (isRecordCurrent(record)) retire(record, authenticationError()); });
    return record.promise;
  }
  function subscribeClose(client, listener) {
    const record = current;
    if (!record || record.client !== client || !record.ready || !isCurrent(record)) throw closeError();
    if (client.connected === false) { const error = closeError(); retire(record, error); throw error; }
    record.closeListeners.add(listener);
    // This closure can only remove its own record's listener, not a later run.
    return () => record.closeListeners.delete(listener);
  }
  function invalidate() {
    const record = current;
    if (!record) { epoch++; return null; }
    const client = record.client;
    retire(record, closeError());
    return client;
  }
  // Read-only health projection: polling must never create a client or RPC.
  const isReady = () => !!(current && isCurrent(current) && current.ready && current.client?.connected !== false);
  return { ready, subscribeClose, invalidate, isReady };
}

/** SDK stopAndWait's final storage drain is outside its own timeout. */
export async function stopNativeControlClient(client, timeoutMs = 2000) {
  if (!client) return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => client.stopAndWait({ timeoutMs })).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
