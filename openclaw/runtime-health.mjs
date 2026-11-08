// Fixed process metadata only. A signal is not proof of its external cause.
const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL']);
const CODES = new Set(['OPENCLAW_RUNTIME', 'OPENCLAW_START_FAILED', 'OPENCLAW_START_TIMEOUT',
  'OPENCLAW_VERSION_MISMATCH', 'OPENCLAW_ENFORCEMENT_UNHEALTHY', 'OPENCLAW_CONTROL_CLOSED',
  'OPENCLAW_CONTROL_TIMEOUT', 'OPENCLAW_CONTROL_AUTH', 'OPENCLAW_PROCESS_KILLED',
  'OPENCLAW_PROCESS_EXITED', 'OPENCLAW_MEMORY_EXHAUSTED']);
const priority = code => code === 'OPENCLAW_MEMORY_EXHAUSTED' ? 30 : code === 'OPENCLAW_PROCESS_KILLED' ? 20
  : code === 'OPENCLAW_PROCESS_EXITED' ? 10 : 0;
const EVIDENCE = new Set(['JAVASCRIPT_HEAP_OOM', 'OS_ALLOCATION_FAILURE']);
const isHeapAbort = (code, signal, evidence) => evidence === 'JAVASCRIPT_HEAP_OOM'
  && (signal === 'SIGABRT' || signal === null && code === 134);

export function createRuntimeHealth() {
  let generation = 0, revision = 0, phase = 'stopped', failureCode = null, failureEvidence = null, lastExit = null, expectedStop = false;
  const current = value => value === generation;
  return {
    starting(next) {
      if (!Number.isSafeInteger(next) || next < 1 || next < generation || next === generation && ['starting', 'ready'].includes(phase)) return;
      generation = next; revision++; phase = 'starting'; failureCode = null; failureEvidence = null; expectedStop = false;
    },
    ready(value) {
      if (!current(value) || expectedStop) return;
      revision++; phase = 'ready'; failureCode = null; failureEvidence = null;
    },
    failed(code, value = generation, evidence = null) {
      if (!current(value) || expectedStop) return;
      const next = CODES.has(code) ? code : 'OPENCLAW_RUNTIME';
      if (!failureCode || priority(next) >= priority(failureCode)) {
        failureCode = next;
        failureEvidence = next === 'OPENCLAW_MEMORY_EXHAUSTED' && EVIDENCE.has(evidence) ? evidence
          : next === 'OPENCLAW_MEMORY_EXHAUSTED' ? failureEvidence : null;
      }
      revision++; phase = 'unhealthy';
    },
    stopping() { expectedStop = true; revision++; phase = failureCode ? 'unhealthy' : 'stopping'; },
    stopped() { revision++; phase = failureCode ? 'unhealthy' : 'stopped'; },
    exited(value, code, signal, evidence = null) {
      if (!current(value)) return;
      lastExit = { generation: value,
        code: Number.isSafeInteger(code) && code >= 0 && code <= 0xffffffff ? code : null,
        signal: SIGNALS.has(signal) ? signal : null, expected: expectedStop };
      revision++;
      if (expectedStop) { phase = failureCode ? 'unhealthy' : 'stopped'; return; }
      const heapAbort = isHeapAbort(code, signal, evidence);
      const next = heapAbort ? 'OPENCLAW_MEMORY_EXHAUSTED' : signal === 'SIGKILL' ? 'OPENCLAW_PROCESS_KILLED' : 'OPENCLAW_PROCESS_EXITED';
      if (!failureCode || priority(next) >= priority(failureCode)) {
        failureCode = next;
        failureEvidence = heapAbort ? evidence : next === 'OPENCLAW_MEMORY_EXHAUSTED' ? failureEvidence : null;
      }
      phase = 'unhealthy';
    },
    terminalStderr(value, evidence) {
      // Node's exit can precede the final stderr data/close. Refine only this
      // recorded unexpected abort; subsequent supervisor cleanup is not its cause.
      if (!current(value) || lastExit?.generation !== value || lastExit.expected ||
          !isHeapAbort(lastExit.code, lastExit.signal, evidence)) return;
      failureCode = 'OPENCLAW_MEMORY_EXHAUSTED'; failureEvidence = 'JAVASCRIPT_HEAP_OOM';
      revision++; phase = 'unhealthy';
    },
    snapshot(running, controlConnected = false) {
      const healthy = running === true && controlConnected === true && phase === 'ready';
      const unavailableControl = running === true && phase === 'ready' && !controlConnected;
      return { healthy, enforcementHealthy: healthy, healthState: unavailableControl ? 'unhealthy' : phase,
        healthRevision: revision, generation,
        failureCode: failureCode || (unavailableControl ? 'OPENCLAW_CONTROL_CLOSED' : null),
        failureEvidence,
        lastExit: lastExit ? { ...lastExit } : null };
    },
  };
}
