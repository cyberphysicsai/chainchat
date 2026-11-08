// Use a file entry point: eval-only flags such as --input-type must not be
// inherited by OpenClaw's forked database-verification and other file workers.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {effectiveMemoryCapacity, createGatewayMemoryPolicy} from './memory-policy.mjs';

const entrypoint = process.argv[2];
if (typeof entrypoint !== 'string' || !path.isAbsolute(entrypoint))
  throw new Error('An absolute OpenClaw entry point is required.');

// Present the same CLI arguments as `node openclaw.mjs gateway run ...`.
process.argv.splice(1, 1);
const memoryPolicy = createGatewayMemoryPolicy({capacityBytes: await effectiveMemoryCapacity()});
process.once('exit', () => memoryPolicy.stop());
process.on('message', message => {
  if (message?.type !== 'chainchat:shutdown') return;
  memoryPolicy.stop();
  process.emit('SIGTERM');
  if (process.connected) process.disconnect();
});
await import(pathToFileURL(entrypoint).href);
