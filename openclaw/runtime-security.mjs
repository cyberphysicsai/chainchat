/** Attest the complete managed compatibility and dependency security patches. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertRuntimeCompatibility} from './runtime-compatibility.mjs';
import {assertNpmSecurity} from './npm-security.mjs';
import {assertZodSecurity} from './zod-security.mjs';

const bootstrapNpm = {
  name: 'npm', version: '12.2.2',
  source: 'https://registry.npmjs.org/npm/-/npm-12.2.2.tgz',
  integrity: 'sha512-KglgbZyacf7jH+FHuNRqVuCzQi8VhI2a7J87Ix43FsPTuZoGWmIXXGdZtBUOA79vwL+IJREqURVzupA7PsQTcA==',
  sha256: '07fecbf753e2c3bc10ebeb3e9ed8738f6a0cc1292998b79e2e9f1dd2a5525e0c',
};
const ipAddress = {
  target: 'node_modules/npm/node_modules/ip-address', name: 'ip-address', version: '10.7.6',
  source: 'https://registry.npmjs.org/ip-address/-/ip-address-10.7.6.tgz',
  integrity: 'sha512-00LYkM6byILa9eQIx6qoaXCM40xTLd56AZ4vyaPW3YTyb49VZYPo5xsiAq4tuQ54GH4R7gVdYScJ1B7B77PuTg==',
  sha256: 'd593a65a5ffa85e704ffd4b2c7220d2c5c3ff879264416f694b2a15d124be7ca',
};
const canonical = value => JSON.stringify(value, (key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);

export function assertNpmSecurityProfile(lock) {
  if (!isDeepStrictEqual(lock.bootstrapNpm, bootstrapNpm) || lock.dependencyOverrides?.npm !== bootstrapNpm.version ||
      !isDeepStrictEqual(lock.bundledDependencyOverlays, [ipAddress]) ||
      !Array.isArray(lock.npmSecurityOverlays) || lock.npmSecurityOverlays.length !== 1 ||
      !Array.isArray(lock.runtimeSecurityOverlays) || lock.runtimeSecurityOverlays.length !== 1)
    throw new Error('The managed dependency security commitment is missing or changed.');
  const profile = createHash('sha256').update(canonical({bootstrapNpm: lock.bootstrapNpm,
    bundledDependencyOverlays: lock.bundledDependencyOverlays, npmSecurityOverlays: lock.npmSecurityOverlays})).digest('hex');
  if (lock.npmSecurityProfile !== profile)
    throw new Error('The npm security profile commitment changed.');
  return profile;
}

async function packageVersion(root, name, version) {
  const filename = path.join(root, 'node_modules', name, 'package.json'), info = await fs.lstat(filename);
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536 ||
      !same(await fs.realpath(filename), filename)) throw new Error('A bundled security package changed ownership.');
  const value = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (value.name !== name || value.version !== version)
    throw new Error('A bundled security package differs from the reviewed version.');
}

export async function assertManagedRuntime(packageRoot) {
  const lock = JSON.parse(await fs.readFile(new URL('./upstream-lock.json', import.meta.url), 'utf8'));
  const npmSecurityProfile = assertNpmSecurityProfile(lock);
  const runtimeCompatibilityOverlays = await assertRuntimeCompatibility(packageRoot);
  const npmRoot = path.resolve(packageRoot, '..', 'npm');
  const npmSecurityOverlay = await assertNpmSecurity(npmRoot, lock.npmSecurityOverlays[0]);
  await packageVersion(npmRoot, 'ip-address', '10.7.6');
  await packageVersion(npmRoot, 'undici', '6.29.1');
  const runtimeSecurityOverlay = await assertZodSecurity(packageRoot, lock.runtimeSecurityOverlays[0]);
  return {runtimeCompatibilityOverlays, npmSecurityProfile,
    npmSecurityOverlays: [npmSecurityOverlay], runtimeSecurityOverlays: [runtimeSecurityOverlay]};
}
