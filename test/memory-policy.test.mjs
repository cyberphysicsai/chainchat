import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveMemoryCapacity, createGatewayMemoryPolicy} from '../openclaw/memory-policy.mjs';

const GiB = 1024 ** 3;
const missing = () => {throw Object.assign(new Error('missing fixture'), {code: 'ENOENT'});};
test('a limited ancestor cgroup is honored when the leaf is unlimited and Node reports host capacity', async () => {
  const files = new Map([
    ['/proc/self/cgroup', '0::/owned/app\n'],
    ['/sys/fs/cgroup/owned/app/memory.max', 'max\n'],
    ['/sys/fs/cgroup/owned/memory.max', String(3 * GiB)],
    ['/sys/fs/cgroup/memory.max', 'max\n'],
  ]);
  assert.equal(await effectiveMemoryCapacity({platform: 'linux', totalBytes: 6 * GiB, constrainedBytes: 6 * GiB,
    read: async file => files.has(file) ? files.get(file) : missing()}), 3 * GiB);
});
test('legacy cgroups, namespace mount root and unavailable metadata keep the smallest valid limit', async () => {
  for (const [membership, extra, expected] of [
    ['7:cpu,memory:/owned/app', {'/sys/fs/cgroup/memory/owned/memory.limit_in_bytes': String(2 * GiB)}, 2 * GiB],
    ['0::/not-visible-in-namespace', {'/sys/fs/cgroup/memory.max': String(3 * GiB)}, 3 * GiB],
    ['', {}, 4 * GiB],
    ['0::/owned/app', {'/sys/fs/cgroup/owned/memory.max': '9223372036854771712'}, 4 * GiB],
  ]) {
    const files = {'/proc/self/cgroup': membership, ...extra};
    assert.equal(await effectiveMemoryCapacity({platform: 'linux', totalBytes: 8 * GiB, constrainedBytes: 4 * GiB,
      read: async file => Object.hasOwn(files, file) ? files[file] : missing()}), expected);
  }
  assert.equal(await effectiveMemoryCapacity({platform: 'win32', totalBytes: 8 * GiB, constrainedBytes: 0,
    read: async () => assert.fail('No Linux metadata on Windows')}), 8 * GiB);
});
test('malformed membership and nonnumeric limits cannot cause reads outside the fixed metadata mounts', async () => {
  for (const member of ['/../../private', '/owned/../private', '/owned\\private', '/a'.repeat(65)]) {
    const reads = [];
    const value = await effectiveMemoryCapacity({platform: 'linux', totalBytes: 3 * GiB, constrainedBytes: 0,
      read: async file => {reads.push(file); return file === '/proc/self/cgroup' ? '0::' + member : 'not-a-limit';}});
    assert.equal(value, 3 * GiB);
    assert.deepEqual(reads, ['/proc/self/cgroup', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']);
  }
});
test('only limited Linux starts a nonblocking sampler; retirement needs observed pressure and SDK subscribers', () => {
  for (const [platform, capacityBytes] of [['linux', 8 * GiB], ['win32', 3 * GiB], ['darwin', 3 * GiB], ['linux', null]])
    assert.equal(createGatewayMemoryPolicy({platform, capacityBytes, startTimer() {assert.fail('Unexpected timer');}}).enabled, false);
  let tick, unrefs = 0, stops = 0, published = 0, rss = GiB;
  const pressureChannel = {hasSubscribers: true, publish(value) {assert.equal(value, undefined); published++;}};
  const timer = {unref() {unrefs++;}};
  const policy = createGatewayMemoryPolicy({platform: 'linux', capacityBytes: 3 * GiB, readRss: () => rss, pressureChannel,
    startTimer(fn, ms) {tick = fn; assert.equal(ms, 5000); return timer;},
    stopTimer(value) {assert.equal(value, timer); stops++;}});
  assert.equal(policy.enabled, true); assert.equal(unrefs, 1);
  tick(); assert.equal(published, 0);
  rss = 2 * GiB; tick(); assert.equal(published, 1);
  pressureChannel.hasSubscribers = false; tick(); assert.equal(published, 1);
  pressureChannel.hasSubscribers = true; rss = NaN; tick(); assert.equal(published, 1);
  policy.stop(); policy.stop(); assert.equal(stops, 1);
  rss = 2 * GiB; tick(); assert.equal(published, 1, 'A queued tick after shutdown cannot request more retirement.');
});
