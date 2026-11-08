// The child may print arbitrary prompts/logs. Only a complete, anchored V8 fatal
// signature followed by an abort is evidence of its JavaScript heap failure.
// Retain at most one bounded partial line; expose only a fixed enum.
const MAX_LINE = 512;
const HEAP_FATAL = /^FATAL ERROR: (?:Reached heap limit|Ineffective mark-compacts near heap limit|MarkCompactCollector: young object promotion failed|Scavenger: semi-space copy) Allocation failed - JavaScript heap out of memory\r?$/;

export function createRuntimeStderrEvidence() {
  let partial = '', discarded = false, heapFatal = false;
  function consume(part, complete) {
    if (!discarded && partial.length + part.length <= MAX_LINE) partial += part;
    else { partial = ''; discarded = true; }
    if (!complete) return;
    if (!discarded && HEAP_FATAL.test(partial)) heapFatal = true;
    partial = ''; discarded = false;
  }
  return {
    write(chunk) {
      if (heapFatal) return;
      // Child stream buffers are bounded by Node. Scan without retaining the
      // complete chunk or a stack trace across events.
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : typeof chunk === 'string' ? chunk : '';
      let start = 0, newline;
      while ((newline = text.indexOf('\n', start)) !== -1) {
        consume(text.slice(start, newline), true); start = newline + 1;
      }
      consume(text.slice(start), false);
    },
    forExit(code, signal) {
      const signature = heapFatal || !discarded && HEAP_FATAL.test(partial);
      return signature && (signal === 'SIGABRT' || signal === null && code === 134) ? 'JAVASCRIPT_HEAP_OOM' : null;
    },
  };
}
