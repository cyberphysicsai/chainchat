import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { emergencySignalProfile, normalizeEmergencySignalConfig } from './emergency-halt-signals.mjs';

const bytes32 = /^0x[0-9a-f]{64}$/;
const secret = () => '0x' + randomBytes(32).toString('hex');
const failure = (message, code = 'EMERGENCY_HALTED') => Object.assign(new Error(message), { code, status: 423 });
const held = () => failure('Emergency Halt is active. Re-arm from the local ChainChat app.');

function validate(value) {
  if (!value || value.version !== 1 || !bytes32.test(value.installationId) || !bytes32.test(value.nonce) ||
      typeof value.halted !== 'boolean' || (value.halted
        ? !['local', 'wallet', 'cphy'].includes(value.source) || !Number.isSafeInteger(value.haltedAt) || value.haltedAt < 0
        : value.source !== null || value.haltedAt !== null)) throw new Error('Invalid emergency state.');
  return { version: 1, installationId: value.installationId, nonce: value.nonce,
    halted: value.halted, source: value.source, haltedAt: value.haltedAt,
    config: normalizeEmergencySignalConfig(value.config) };
}

export async function createEmergencyHalt({ directory, onTrip, onRearm, now = Date.now }) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(directory);
  const file = path.join(root, 'emergency-halt.json');
  let snapshot = { version: 1, installationId: secret(), nonce: secret(),
    halted: false, source: null, haltedAt: null, config: null };
  let storageError = false, stopError = false;

  function checkFile(stat) {
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 ||
        process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))
      throw new Error('Emergency state is not private.');
    return stat;
  }

  async function persist(next) {
    const before = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (before) checkFile(before);
    const temporary = file + '.' + randomBytes(12).toString('hex') + '.tmp';
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(next) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
      if (process.platform !== 'win32') {
        const parent = await fs.open(path.dirname(file), 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  try {
    const rootStat = await fs.stat(root);
    if (process.platform !== 'win32' && (rootStat.uid !== process.getuid() || (rootStat.mode & 0o022)))
      throw new Error('Emergency state directory is not owner-controlled.');
    const before = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (before) {
      checkFile(before);
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      try {
        const after = checkFile(await handle.stat());
        if (before.ino !== after.ino || before.dev !== after.dev) throw new Error('Emergency state changed.');
        const data = Buffer.alloc(16385);
        const { bytesRead } = await handle.read(data, 0, data.length, 0);
        snapshot = validate(JSON.parse(data.subarray(0, bytesRead).toString('utf8')));
      } finally { await handle.close(); }
    } else await persist(snapshot);
  } catch { storageError = true; }

  let phase = null, revision = 0, epoch = 0, busy = Promise.resolve(), configuring = false, stop;
  const blocked = () => storageError || snapshot.halted || phase !== null;
  const publicStatus = () => ({ halted: blocked(), transitioning: phase, storageError, stopError, revision });
  const ownerStatus = () => ({
    ...publicStatus(), source: snapshot.source, haltedAt: snapshot.haltedAt,
    config: snapshot.config ? { ...snapshot.config } : null,
    profile: emergencySignalProfile(snapshot.installationId, snapshot.nonce, snapshot.config),
  });
  function serialize(action) {
    const result = busy.then(action);
    busy = result.catch(() => {});
    return result;
  }
  async function save(next) {
    try { await persist(next); snapshot = next; }
    catch {
      storageError = true;
      revision++;
      throw failure('Emergency Halt is held, but its state could not be saved. Inspect the local storage before restarting.', 'EMERGENCY_STORAGE');
    }
  }
  function interrupt() {
    try { return Promise.resolve(onTrip()).then(() => true, () => false); }
    catch { return Promise.resolve(false); }
  }
  function trip(source, proof) {
    if (!['local', 'wallet', 'cphy'].includes(source)) throw failure('Invalid halt source.');
    if (source !== 'local' && (blocked() || configuring || !snapshot.config ||
        proof?.installationId !== snapshot.installationId || proof?.nonce !== snapshot.nonce)) return false;
    if (phase === 'halting') return stop;
    if (snapshot.halted && !phase && !stopError) return ownerStatus();
    phase = 'halting'; epoch++; revision++;
    const stopped = interrupt();
    stop = serialize(async () => {
      try {
        if (!storageError) await save({ ...snapshot, halted: true, source, haltedAt: now(), nonce: secret() });
      } finally {
        stopError = !await stopped;
        phase = null; revision++;
      }
      if (storageError) throw failure('The halt is active but local storage needs inspection.', 'EMERGENCY_STORAGE');
      if (stopError) throw failure('The halt is active, but an owned process did not confirm shutdown.', 'EMERGENCY_STOP_FAILED');
      return ownerStatus();
    });
    return stop;
  }

  async function configure(value) {
    if (storageError || phase || configuring) throw failure('Wait for the local Emergency Halt state to be ready.');
    const config = normalizeEmergencySignalConfig(value);
    configuring = true;
    try {
      await serialize(async () => {
        await save({ ...snapshot, config, nonce: secret() });
        revision++;
      });
    } catch (error) {
      stopError = !await interrupt();
      throw error;
    } finally { configuring = false; }
    return ownerStatus();
  }

  async function rearm() {
    if (phase || configuring || storageError || stopError) throw failure('Resolve the local Emergency Halt state before re-arming.');
    if (!snapshot.halted) return ownerStatus();
    phase = 'rearming'; revision++;
    const attempt = epoch;
    const current = () => {
      if (phase !== 'rearming' || epoch !== attempt || storageError) throw held();
    };
    return serialize(async () => {
      try {
        current();
        await onRearm(current);
        current();
        await save({ ...snapshot, halted: false, source: null, haltedAt: null, nonce: secret() });
        current();
        epoch++; phase = null; revision++;
        return ownerStatus();
      } catch (error) {
        if (phase === 'rearming') {
          stopError = !await interrupt();
          if (phase === 'rearming') { phase = null; revision++; }
        }
        throw error;
      }
    });
  }

  return Object.freeze({
    publicStatus, ownerStatus, blocked, configure, trip, rearm,
    epoch: () => epoch,
    assertAvailable(captured = epoch) { if (blocked() || captured !== epoch) throw held(); },
    signalState: () => ({ halted: blocked() || configuring, installationId: snapshot.installationId,
      nonce: snapshot.nonce, config: snapshot.config }),
  });
}
