import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createOpenClawGateway, OPENCLAW_VERSION} from '../openclaw/gateway.mjs';

const execute = promisify(execFile);
const bootstrap = fileURLToPath(new URL('../openclaw/gateway-bootstrap.mjs', import.meta.url));
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-gateway-bootstrap-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('ct-gateway-bootstrap-'));
    await fs.rm(directory, {recursive: true, force: true});
  });
  const worker = path.join(directory, 'healthy-worker.mjs');
  await fs.writeFile(worker, `process.send?.({healthy: true, execArgv: process.execArgv}); process.disconnect?.();\n`);
  const target = path.join(directory, 'target.mjs');
  await fs.writeFile(target, `import {fork} from 'node:child_process';
const worker = fork(process.argv[2], [], {execArgv: undefined, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
let stderr = '', result = null; worker.stderr.on('data', chunk => stderr += chunk);
worker.on('message', value => result = value);
worker.on('close', (code, signal) => console.log(JSON.stringify({argv: process.argv.slice(1), execArgv: process.execArgv, code, signal, result, stderr})));
`);
  return {directory, target, worker};
}

test('eval bootstrap reproduces file-worker exit 1 before healthy worker code executes', async t => {
  const f = await fixture(t);
  const old = 'import {pathToFileURL} from "node:url"; await import(pathToFileURL(process.argv[1]).href);';
  const {stdout} = await execute(process.execPath, ['--input-type=module', '--eval', old, f.target, f.worker], {timeout: 15000});
  const result = JSON.parse(stdout);
  assert.equal(result.code, 1);
  assert.equal(result.result, null);
  assert.match(result.stderr, /ERR_INPUT_TYPE_NOT_ALLOWED/);
});

test('file bootstrap preserves OpenClaw CLI argv and permits inherited file workers', async t => {
  const f = await fixture(t);
  const {stdout} = await execute(process.execPath, [bootstrap, f.target, f.worker, 'gateway', 'run'], {timeout: 15000});
  const result = JSON.parse(stdout);
  assert.deepEqual(result.argv, [f.target, f.worker, 'gateway', 'run']);
  assert.deepEqual(result.execArgv, []);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.result, {healthy: true, execArgv: []});
});

test('file bootstrap retains authenticated-supervisor IPC shutdown delivery', {timeout: 15000}, async t => {
  const f = await fixture(t);
  const target = path.join(f.directory, 'shutdown-target.mjs');
  await fs.writeFile(target, `process.on('SIGTERM', () => {process.send?.({stopped: true}); process.exitCode=0;}); process.send?.({ready:true});\n`);
  const child = spawn(process.execPath, [bootstrap, target], {stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true});
  const messages = [], stderr = [];
  child.on('message', value => messages.push(value)); child.stderr.on('data', value => stderr.push(value));
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  while (!messages.some(value => value.ready)) await once(child, 'message');
  child.send({type: 'chainchat:shutdown'});
  const [code, signal] = await closed;
  assert.equal(code, 0); assert.equal(signal, null);
  assert.deepEqual(messages, [{ready: true}, {stopped: true}]);
  assert.equal(Buffer.concat(stderr).toString(), '');
});

test('managed Gateway actually selects the file bootstrap without eval-only worker flags', async t => {
  const f = await fixture(t), packageRoot = path.join(f.directory, 'package');
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({name: 'openclaw', version: OPENCLAW_VERSION}));
  let argv;
  const manager = createOpenClawGateway({stateDir: path.join(f.directory, 'managed'), packageRoot, pluginPath: packageRoot,
    runtimeCompatibilityCheck: async () => {},
    broker: {url: 'http://127.0.0.1:3210/v1/enforce', token: 'synthetic-bootstrap-broker', registerInvocation() {}, assertCandidate() {}},
    spawnImpl(_node, args) { argv = args; throw Object.assign(new Error('Synthetic hold before process startup'), {code: 'FIXTURE_HELD'}); },
  });
  try {
    await assert.rejects(manager.start(), {code: 'FIXTURE_HELD'});
    const index = argv.indexOf(bootstrap);
    assert.ok(index >= 0);
    assert.equal(argv[index + 1], path.join(packageRoot, 'openclaw.mjs'));
    assert.deepEqual(argv.slice(index + 2, index + 4), ['gateway', 'run']);
    assert.equal(argv.includes('--input-type=module'), false);
    assert.equal(argv.includes('--eval'), false);
  } finally { await manager.close(); }
});

test('the actual pinned SQLite verifier succeeds on a healthy database only after removing inherited eval flags', {
  skip: !process.env.CT_OPENCLAW_PACKAGE ? 'Set CT_OPENCLAW_PACKAGE for the actual pinned verifier regression.' : false,
  timeout: 45000,
}, async t => {
  const f = await fixture(t), sdk = process.env.CT_OPENCLAW_PACKAGE;
  const node = process.env.CT_OPENCLAW_NODE || process.execPath;
  const candidates = (await fs.readdir(path.join(sdk, 'dist'))).filter(name => /^openclaw-database-verify\.impl-[^.]+\.mjs$/.test(name));
  assert.equal(candidates.length, 1);
  const verifier = path.join(sdk, 'dist', candidates[0]), target = path.join(f.directory, 'verify-target.mjs');
  await fs.writeFile(target, `import fs from 'node:fs/promises'; import {createHash} from 'node:crypto'; import {pathToFileURL} from 'node:url';
const file=process.argv[2], hash=async()=>createHash('sha256').update(await fs.readFile(file)).digest('hex'), before=await hash();
const {runDatabaseVerifyWorker}=await import(pathToFileURL(process.argv[3]).href);
let value=null, failure=null;
try {value=await runDatabaseVerifyWorker([{path:file,kind:'agent',label:'Owned healthy fixture',check:'quick'}]);}
catch(error) {failure=error.message;}
console.log(JSON.stringify({value,failure,unchanged:before===await hash()}));
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP)$/i.test(key)));
  Object.assign(env, {HOME: f.directory, USERPROFILE: f.directory, APPDATA: f.directory, LOCALAPPDATA: f.directory,
    OPENCLAW_STATE_DIR: path.join(f.directory, 'state'), OPENCLAW_CONFIG_PATH: path.join(f.directory, 'unused-config.json'), OPENCLAW_NO_RESPAWN: '1'});
  const db = path.join(f.directory, 'healthy.sqlite');
  await execute(node, ['-e', 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("CREATE TABLE healthy_test(value TEXT)");d.close();', db], {env, timeout: 10000});
  const old = 'import {pathToFileURL} from "node:url"; await import(pathToFileURL(process.argv[1]).href);';
  const broken = JSON.parse((await execute(node, ['--input-type=module', '--eval', old, target, db, verifier], {env, timeout: 15000})).stdout);
  assert.equal(broken.failure, 'database verification worker exited with code 1');
  assert.equal(broken.value, null); assert.equal(broken.unchanged, true);
  const fixed = JSON.parse((await execute(node, [bootstrap, target, db, verifier], {env, timeout: 15000})).stdout);
  assert.equal(fixed.failure, null);
  assert.deepEqual(fixed.value, [{path: db, ok: true}]); assert.equal(fixed.unchanged, true);
});
