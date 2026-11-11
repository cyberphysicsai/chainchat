import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assertNpmSecurity, NPM_SECURITY_DESCRIPTOR} from '../openclaw/npm-security.mjs';

const exec = promisify(execFile);
const npmRoot = process.env.CT_NPM_SECURITY_PACKAGE || (process.env.CT_OPENCLAW_PACKAGE &&
  path.resolve(process.env.CT_OPENCLAW_PACKAGE, '..', 'npm'));
const available = Boolean(npmRoot);
const source = new URL('../openclaw/upstream-lock.json', import.meta.url);
const skip = available ? false : 'Actual npm acceptance runs with the installed runtime in CI.';

async function temporary(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'ct-npm-security-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.ok(path.basename(directory).startsWith('ct-npm-security-'));
    await fs.rm(directory, {recursive: true, force: true});
  });
  return directory;
}

const portionMatches = (part, name) => typeof part === 'string' ? part === name : part.test(name);

test('npm security commitment refuses an unknown descriptor before file access', async () => {
  await assert.rejects(assertNpmSecurity('/not-a-package', {}), /commitment differs/);
  const changed = structuredClone(NPM_SECURITY_DESCRIPTOR);
  changed.files[0].path = '../outside';
  await assert.rejects(assertNpmSecurity('/not-a-package', changed), /commitment differs/);
});

test('npm security file group is independently committed in the runtime lock', async () => {
  const lock = JSON.parse(await fs.readFile(source, 'utf8'));
  assert.deepEqual(lock.npmSecurityOverlays, [NPM_SECURITY_DESCRIPTOR]);
});

test('actual npm validates all eight installed backport files', {skip}, async () => {
  assert.deepEqual(await assertNpmSecurity(npmRoot, NPM_SECURITY_DESCRIPTOR), NPM_SECURITY_DESCRIPTOR);
});

test('standalone CJS and ESM matchers bound growth before allocation and preserve literal escaping', {skip, timeout: 15_000}, async () => {
  const require = createRequire(path.join(npmRoot, 'package.json'));
  const modules = [require('minimatch'),
    await import(pathToFileURL(path.join(npmRoot, 'node_modules/minimatch/dist/esm/index.js')))];
  for (const mm of modules) {
    const pattern = Array(4).fill('**/../a/b').join('/');
    assert.throws(() => new mm.Minimatch(pattern, {optimizationLevel: 2, braceExpandMax: 4}),
      /too many patterns/);
    const bounded = new mm.Minimatch('*', {optimizationLevel: 2});
    const oversized = new Proxy(['**', '..', 'a', 'b'], {
      get(target, key, receiver) {
        if (key === 'length') return 1_000_002;
        if (key === 'splice' || key === 'slice') return () => { throw new Error('allocation preceded budget'); };
        return Reflect.get(target, key, receiver);
      },
    });
    assert.throws(() => bounded.firstPhasePreProcess([oversized]), /too many patterns/);
    let comparisons = 0;
    bounded.partsMatch = () => { comparisons++; throw new Error('quadratic comparison'); };
    const rows = Array.from({length: 1001}, (_, i) => ['x', String(i)]);
    assert.equal(bounded.secondPhasePreProcess(rows), rows);
    assert.equal(comparisons, 0);
    const small = new mm.Minimatch('**/../a/b/**/../c/d', {optimizationLevel: 2});
    assert.equal(small.match('../a/b/../c/d'), true);
    assert.equal(small.match('x/a/b/y/c/d'), true);
    for (const windowsPathsNoEscape of [false, true]) {
      const options = {windowsPathsNoEscape, magicalBraces: true};
      for (const literal of ['!secret.txt', '#notes.md', 'x{a,b}']) {
        const escaped = mm.escape(literal, options);
        assert.equal(mm.minimatch(literal, escaped, options), true);
        assert.equal(mm.minimatch('unrelated', escaped, options), false);
        if (literal === 'x{a,b}') assert.equal(mm.minimatch('xa', escaped, options), false);
      }
    }
    const patternWithBraces = mm.escape('x\\*') + '.{js,ts}';
    assert.equal(mm.minimatch('x\\*.js', patternWithBraces, {platform: 'linux'}), true);
    assert.equal(mm.minimatch('x\\anything.js', patternWithBraces, {platform: 'linux'}), false);
    assert.equal(mm.minimatch('src/a.js', 'src/*.js'), true);
    assert.equal(mm.minimatch('src/a.ts', 'src/*.js'), false);
  }
});

test('default and raw CJS/ESM glob copies stop filesystem work after cancellation and bound embedded matchers',
  {skip, timeout: 20_000}, async t => {
    const directory = await temporary(t);
    for (const name of ['a/aa', 'a/ab', 'b/ba', 'b/bb']) {
      await fs.mkdir(path.join(directory, name), {recursive: true});
      await fs.writeFile(path.join(directory, name, 'fixture.txt'), 'fixture');
    }
    const require = createRequire(path.join(npmRoot, 'package.json'));
    const mm = require('minimatch');
    const modules = [require('glob'), require('glob/raw'),
      await import(pathToFileURL(path.join(npmRoot, 'node_modules/glob/dist/esm/index.min.js'))),
      await import(pathToFileURL(path.join(npmRoot, 'node_modules/glob/dist/esm/index.js')))];
    const expectedExports = ['Glob', 'Ignore', 'escape', 'glob', 'globIterate', 'globIterateSync',
      'globStream', 'globStreamSync', 'globSync', 'hasMagic', 'iterate', 'iterateSync',
      'stream', 'streamSync', 'sync', 'unescape'].sort();
    for (const module of modules) assert.deepEqual(Object.keys(module).sort(), expectedExports);
    for (const glob of modules) {
      const ac = new AbortController();
      const reason = new Error('fixture abort');
      let calls = 0;
      const countedFs = {...nativeFs, readdir(...args) {
        if (++calls === 1) ac.abort(reason);
        return nativeFs.readdir(...args);
      }};
      await assert.rejects(glob.glob('**', {cwd: directory, signal: ac.signal, fs: countedFs}), /fixture abort/);
      const atRejection = calls;
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(calls, atRejection, 'canceled walk started additional reads');
      assert.throws(() => new glob.Glob(Array(4).fill('**/../a/b').join('/'),
        {braceExpandMax: 4, platform: 'linux'}), /too many patterns/);
      for (const options of [{}, {windowsPathsNoEscape: true, magicalBraces: true}]) {
        for (const literal of ['!secret.txt', '#notes.md', 'x{a,b}']) {
          const escaped = glob.escape(literal, {...options, magicalBraces: true});
          assert.equal(mm.minimatch(literal, escaped, options), true);
          assert.equal(mm.minimatch('unrelated', escaped, options), false);
        }
      }
      const escaped = glob.escape('x\\*') + '.{js,ts}';
      const matcher = new glob.Glob(escaped, {platform: 'linux'});
      assert.equal(matcher.patterns.some(p => portionMatches(p.pattern(), 'x\\*.js')), true);
      assert.equal(matcher.patterns.some(p => portionMatches(p.pattern(), 'x\\anything.js')), false);
      assert.equal((await glob.glob('**/*.txt', {cwd: directory})).length, 4);
      assert.equal(glob.globSync('**/*.txt', {cwd: directory}).length, 4);
    }
    assert.equal(modules[0], modules[1]);
    for (const key of expectedExports) assert.equal(modules[2][key], modules[3][key]);
  });

test('reviewed npm performs offline workspace lock, ci, listing and packing without lifecycle execution',
  {skip, timeout: 60_000}, async t => {
    const directory = await temporary(t);
    const fixture = path.join(directory, 'fixture');
    await fs.mkdir(path.join(fixture, 'packages/app/src'), {recursive: true});
    await fs.mkdir(path.join(fixture, 'packages/lib/src'), {recursive: true});
    await fs.mkdir(path.join(directory, 'artifacts'));
    const json = async (filename, value) => fs.writeFile(filename, JSON.stringify(value));
    await json(path.join(fixture, 'package.json'), {name: 'ct-private-npm-fixture', version: '1.0.0', private: true,
      workspaces: ['packages/*'], scripts: {postinstall: 'node -e "require(\'fs\').writeFileSync(\'lifecycle-ran\',\'bad\')"'}});
    await json(path.join(fixture, 'packages/app/package.json'), {name: '@ct-fixture/app', version: '1.0.0',
      files: ['src/**/*.js'], dependencies: {'@ct-fixture/lib': 'file:../lib'}});
    await json(path.join(fixture, 'packages/lib/package.json'), {name: '@ct-fixture/lib', version: '1.0.0', files: ['src']});
    await fs.writeFile(path.join(fixture, 'packages/app/src/main.js'), 'export const value = 1;');
    await fs.writeFile(path.join(fixture, 'packages/app/secret.txt'), 'not for packing');
    await fs.writeFile(path.join(fixture, 'packages/lib/src/lib.js'), 'export const lib = 1;');
    const userconfig = path.join(directory, 'npm-user-config');
    const globalconfig = path.join(directory, 'npm-global-config');
    await fs.writeFile(userconfig, ''); await fs.writeFile(globalconfig, '');
    const env = {...process.env, NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig,
      NPM_CONFIG_CACHE: path.join(directory, 'cache'), NPM_CONFIG_PREFIX: path.join(directory, 'prefix'),
      NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false', NPM_CONFIG_PROGRESS: 'false'};
    const npm = async args => (await exec(process.execPath,
      ['--max-old-space-size=256', path.join(npmRoot, 'bin/npm-cli.js'), ...args, '--ignore-scripts', '--offline', '--audit=false', '--fund=false', '--loglevel=error'],
      {cwd: fixture, env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024})).stdout;
    await npm(['install', '--package-lock-only']);
    await npm(['ci']);
    const listed = JSON.parse(await npm(['ls', '--all', '--json']));
    assert.equal(listed.dependencies['@ct-fixture/app'].version, '1.0.0');
    assert.equal(listed.dependencies['@ct-fixture/lib'].version, '1.0.0');
    const packed = JSON.parse(await npm(['pack', '--json', '--workspace=@ct-fixture/app',
      '--pack-destination=' + path.join(directory, 'artifacts')]));
    assert.deepEqual(Object.keys(packed), ['@ct-fixture/app']);
    const names = packed['@ct-fixture/app'].files.map(row => row.path);
    assert.ok(names.includes('src/main.js'));
    assert.ok(names.includes('package.json'));
    assert.ok(!names.includes('secret.txt'));
    await assert.rejects(fs.access(path.join(fixture, 'lifecycle-ran')));
  });

test('external Minimatch uses the latest escaping fix', {
  skip: process.env.CT_OPENCLAW_PACKAGE ? false : 'Actual external dependency runs with the installed runtime in CI.',
}, async () => {
  const require = createRequire(path.join(process.env.CT_OPENCLAW_PACKAGE, 'package.json'));
  assert.equal(require('minimatch/package.json').version, '11.0.8');
  const mm = require('minimatch');
  for (const windowsPathsNoEscape of [false, true]) {
    const options = {windowsPathsNoEscape, magicalBraces: true};
    for (const literal of ['!secret.txt', '#notes.md', 'x{a,b}']) {
      const pattern = mm.escape(literal, options);
      assert.equal(mm.minimatch(literal, pattern, options), true);
      assert.equal(mm.minimatch('unrelated', pattern, options), false);
      if (literal === 'x{a,b}') assert.equal(mm.minimatch('xa', pattern, options), false);
    }
  }
  const pattern = mm.escape('x\\*') + '.{js,ts}';
  assert.equal(mm.minimatch('x\\*.js', pattern, {platform: 'linux'}), true);
  assert.equal(mm.minimatch('x\\anything.js', pattern, {platform: 'linux'}), false);
});

test('external Minimatch cache stays bounded under the official PoC and non-range expansion controls', {
  skip: process.env.CT_OPENCLAW_PACKAGE && process.env.CI === 'true' ? false :
    'Memory-capped adversarial child runs only in CI, away from active benchmark machines.',
  timeout: 60_000,
}, async () => {
  const script = `
    const {createRequire} = require('node:module');
    const r = createRequire(process.argv[1]);
    const {minimatch} = r('minimatch');
    if (r('minimatch/package.json').version !== '11.0.8') throw new Error('Wrong external matcher');
    // Maintainer-disclosed GHSA-hqmv-qgp3-jx75 reproduction, inside a hard
    // 128MiB V8 heap. It must complete without retaining large compiled rows.
    for (let i = 0; i < 4; i++) {
      minimatch('no-match', '{1..100000}/official-' + i, {optimizationLevel: 2});
      global.gc();
    }
    global.gc();
    const before = process.memoryUsage().heapUsed;
    // Appending x prevents the numeric-range shortcut. Ten small, distinct
    // 5000-row objects exercise retained cache weight, rather than merely
    // testing a later numeric-range optimization.
    for (let i = 0; i < 10; i++) {
      minimatch('no-match', '{0..4999}x/cache-control-' + i, {optimizationLevel: 2});
      global.gc();
    }
    global.gc();
    const growth = process.memoryUsage().heapUsed - before;
    if (growth > 8 * 1024 * 1024) throw new Error('Compiled cache retained excessive expansion weight: ' + growth);
    console.log(JSON.stringify({officialInputs: 4, boundedControls: 10, retainedHeapGrowth: growth}));
  `;
  const result = await exec(process.execPath, ['--max-old-space-size=128', '--expose-gc', '-e', script,
    path.join(process.env.CT_OPENCLAW_PACKAGE, 'package.json')],
  {windowsHide: true, timeout: 45_000, maxBuffer: 1024 * 1024});
  const report = JSON.parse(result.stdout);
  assert.equal(report.officialInputs, 4);
  assert.equal(report.boundedControls, 10);
  assert.ok(report.retainedHeapGrowth <= 8 * 1024 * 1024);
});
