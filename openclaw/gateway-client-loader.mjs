// Keep the official client and its authentication/protocol implementation.
// The public gateway-runtime barrel also imports unrelated server/CLI helpers.
// Resolve its exact client re-export without evaluating that larger graph.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const refused = () => Object.assign(new Error('The pinned OpenClaw client entry is unsupported or changed. Reinstall the matching runtime.'),
  {code: 'OPENCLAW_CLIENT_ENTRY_UNSUPPORTED', status: 503});
const contained = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

export async function resolveGatewayClientEntry(packageRoot) {
  if (typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot)) throw refused();
  try {
    const dist = await fs.realpath(path.join(packageRoot, 'dist'));
    const publicEntry = await fs.realpath(path.join(dist, 'plugin-sdk', 'gateway-runtime.js'));
    if (!contained(dist, publicEntry)) throw refused();
    const info = await fs.stat(publicEntry);
    if (!info.isFile() || info.size > 65536) throw refused();
    const source = await fs.readFile(publicEntry, 'utf8');
    const matches = [...source.matchAll(/\bimport\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+GatewayClient\s*\}\s*from\s*["'](\.\.\/client-[A-Za-z0-9_-]+\.mjs)["']\s*;/g)];
    if (matches.length !== 1 || !/\bexport\s*\{[^}]*\bGatewayClient\b[^}]*\}\s*;/s.test(source)) throw refused();
    const file = await fs.realpath(path.resolve(path.dirname(publicEntry), matches[0][2]));
    const target = await fs.stat(file);
    if (!contained(dist, file) || !target.isFile()) throw refused();
    return {file, exportName: matches[0][1]};
  } catch { throw refused(); }
}

export async function loadGatewayClient(packageRoot) {
  const entry = await resolveGatewayClientEntry(packageRoot);
  const module = await import(pathToFileURL(entry.file).href);
  const Client = module[entry.exportName];
  if (typeof Client !== 'function' || !['start', 'stop', 'stopAndWait', 'request'].every(key => typeof Client.prototype?.[key] === 'function'))
    throw refused();
  return Client;
}
