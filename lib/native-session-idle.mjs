import {setTimeout as delay} from 'node:timers/promises';
const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f]/u.test(value);
const fail = (message, code = 'SESSION_CHANGED') => Object.assign(new Error(message), {code, status: 409, stage: 'context'});

/** Wait for the official active-run projection, including terminal persistence.
 * A chat ACK or an empty activeRunIds list does not establish quiescence.
 * This runs before a new claim or transcript compaction can be registered.
 */
export async function waitForNativeSessionIdle({read, sessionKey, expectedSessionId, requireExisting = false,
  assertCurrent = async () => {}, signal, timeoutMs = 120000, now = () => performance.now(),
  wait = ms => delay(ms, undefined, {signal})}) {
  if (typeof read !== 'function' || !valid(sessionKey) || expectedSessionId !== undefined && !valid(expectedSessionId) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw fail('The native idle check is invalid.');
  const deadline = now() + timeoutMs;
  let identity;
  const current = async () => {
    if (signal?.aborted) throw fail('The native wait was cancelled.', 'REQUEST_CANCELLED');
    await assertCurrent();
    if (signal?.aborted) throw fail('The native wait was cancelled.', 'REQUEST_CANCELLED');
  };
  const busy = () => fail('The previous native run has not finished. Wait before starting another turn.', 'OPENCLAW_SESSION_BUSY');
  const readWithinBudget = async () => {
    const remaining = Math.ceil(deadline - now());
    if (remaining <= 0) throw busy();
    let timer, aborted;
    const held = new Promise((_, reject) => {
      timer = setTimeout(() => reject(busy()), remaining);
      aborted = () => reject(fail('The native wait was cancelled.', 'REQUEST_CANCELLED'));
      signal?.addEventListener('abort', aborted, {once: true});
      if (signal?.aborted) aborted();
    });
    try {return await Promise.race([held, Promise.resolve().then(() => read(sessionKey, {timeoutMs: remaining, signal}))]);}
    finally {clearTimeout(timer); signal?.removeEventListener('abort', aborted);}
  };
  for (;;) {
    await current();
    const response = await readWithinBudget();
    await current();
    const row = response?.session;
    if (row === null) {
      if (requireExisting || expectedSessionId || identity) throw fail('The previous native session is no longer available.');
      return null;
    }
    if (!row || row.key !== undefined && row.key !== sessionKey || !valid(row.sessionId) || !valid(row.lifecycleRevision) ||
        typeof row.hasActiveRun !== 'boolean' || row.activeRunIds !== undefined && (!Array.isArray(row.activeRunIds) ||
          row.activeRunIds.length > 1024 || row.activeRunIds.some(id => !valid(id))))
      throw fail('The native session idle projection could not be verified.');
    if (expectedSessionId && row.sessionId !== expectedSessionId || identity &&
        (identity.sessionId !== row.sessionId || identity.lifecycleRevision !== row.lifecycleRevision))
      throw fail('The native session changed while waiting.');
    identity ||= {sessionId: row.sessionId, lifecycleRevision: row.lifecycleRevision};
    if (row.hasActiveRun === false) {
      if (row.activeRunIds?.length) throw fail('The native session idle projection is inconsistent.');
      return identity;
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw busy();
    try {await wait(Math.min(200, remaining));}
    catch (error) {if (signal?.aborted) throw fail('The native wait was cancelled.', 'REQUEST_CANCELLED'); throw error;}
  }
}
