import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {channel} from 'node:diagnostics_channel';

const GiB = 1024 ** 3;
const positive = value => Number.isSafeInteger(value) && value > 0;
function byteLimit(text) {
  if (typeof text !== 'string' || text.length > 64 || !/^\d+\s*$/.test(text)) return null;
  const value = Number(text.trim());
  return positive(value) ? value : null;
}
function ancestors(root, member, filename) {
  // Only kernel-owned cgroup metadata under fixed mounts is read. No paths
  // from a model, web request, provider or configuration file are accepted.
  if (!member.startsWith('/') || /[\0\r\n\\]/.test(member)) return [];
  const parts = member.split('/').filter(Boolean);
  if (parts.length > 64 || parts.some(part => part === '.' || part === '..')) return [];
  const files = [];
  for (let length = parts.length; length >= 0; length--)
    files.push(path.posix.join(root, ...parts.slice(0, length), filename));
  return files;
}

export async function effectiveMemoryCapacity({platform = process.platform, totalBytes = os.totalmem(),
  constrainedBytes = process.constrainedMemory?.() || 0, read = file => fs.readFile(file, 'utf8')} = {}) {
  const limits = [totalBytes, constrainedBytes].filter(positive);
  if (platform === 'linux') {
    const files = new Set(['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']);
    try {
      const membership = await read('/proc/self/cgroup');
      if (typeof membership === 'string' && membership.length <= 8192) {
        for (const row of membership.split('\n').slice(0, 64)) {
          const match = /^(\d+):([^:]*):(.*)$/.exec(row);
          if (!match) continue;
          const v2 = match[1] === '0' && match[2] === '';
          if (v2 || match[2].split(',').includes('memory')) {
            for (const file of ancestors(v2 ? '/sys/fs/cgroup' : '/sys/fs/cgroup/memory', match[3],
              v2 ? 'memory.max' : 'memory.limit_in_bytes')) {
              if (files.size < 192) files.add(file);
            }
          }
        }
      }
    } catch { /* Ordinary hosts may not expose cgroup membership. */ }
    for (const file of files) {
      try { const limit = byteLimit(await read(file)); if (limit) limits.push(limit); }
      catch { /* Missing/unsupported mount: retain Node and physical limits. */ }
    }
  }
  return limits.length ? Math.min(...limits) : null;
}

export function limitedLinuxMemory(capacityBytes, platform = process.platform) {
  return platform === 'linux' && positive(capacityBytes) && capacityBytes <= 4 * GiB;
}

export function createGatewayMemoryPolicy({capacityBytes, platform = process.platform,
  readRss = () => process.memoryUsage.rss(), pressureChannel = channel('openclaw.memory.critical'),
  startTimer = setInterval, stopTimer = clearInterval} = {}) {
  if (!limitedLinuxMemory(capacityBytes, platform)) return {enabled: false, stop() {}};
  const budgetBytes = Math.max(256 * 1024 ** 2, Math.floor(capacityBytes * 0.375));
  // This is an application cache budget, not a claim of an operating-system
  // OOM. The pinned SDK retires only idle resources and recreates them on use.
  // Never terminate Workers, close databases or bypass admission ourselves.
  let stopped = false;
  const timer = startTimer(() => {
    if (stopped) return;
    try {
      const rss = readRss();
      if (positive(rss) && rss > budgetBytes && pressureChannel.hasSubscribers)
        pressureChannel.publish(undefined);
    } catch { /* Best-effort cache reclamation never authorizes an action. */ }
  }, 5000);
  timer.unref?.();
  return {enabled: true, budgetBytes, stop() {if (!stopped) {stopped = true; stopTimer(timer);}}};
}
