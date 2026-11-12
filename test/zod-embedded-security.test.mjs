import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {assertZodSecurity, zodSecurityDescriptor} from '../openclaw/zod-security.mjs';

const packageRoot = process.env.CT_OPENCLAW_PACKAGE;
const native = {skip: !packageRoot && 'The actual pinned package is enabled in native CI.'};
const descriptor = zodSecurityDescriptor();

function declaration(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const end = /^\}/m.exec(source.slice(start));
  assert.ok(end, `Missing ${name} boundary`);
  return source.slice(start, start + end.index + 1);
}

function constructor(source, kind) {
  const start = new RegExp(`^(\\t*)(?:(?:const|var) )?\\$Zod${kind} = .*$`, 'm').exec(source);
  assert.ok(start, `Missing ${kind} constructor`);
  const bodyStart = start.index + start[0].length;
  const end = new RegExp(`^${start[1]}\\}\\);$`, 'm').exec(source.slice(bodyStart));
  assert.ok(end, `Missing ${kind} constructor boundary`);
  const statement = source.slice(start.index, bodyStart + end.index + end[0].length);
  return statement.slice(statement.indexOf('=') + 1);
}

function interpreter(source) {
  const code = ['__chainchatZodSizeCaps', '__chainchatZodCapSize', 'attachSchema', 'handleArrayResult']
    .map(name => declaration(source, name)).join('\n');
  return vm.runInNewContext(`(() => { ${code}\nreturn ${constructor(source, 'Array')}; })()`, {
    $constructor: (_name, initialize) => initialize,
    $ZodType: {init: (instance, definition) => { instance._zod.def = definition; }},
    globalConfig: {}, Array, Map, Set, Promise,
    prefixIssues: (index, issues) => issues.map(issue => ({...issue, path: [index, ...(issue.path || [])]})),
  }, {timeout: 2000});
}

function check(maximum, kind = 'length') {
  return {_zod: {
    def: {check: `max_${kind}`, maximum, when: payload => kind === 'length' ? Array.isArray(payload.value) : true},
    check: payload => payload.issues.push({code: 'too_big'}),
  }};
}

async function actualZod() {
  // These are pure bundled Zod leaves. Importing the broad api chunk would
  // also initialize unrelated plugin-entry code, which this regression avoids.
  const schemas = await import(pathToFileURL(path.join(packageRoot, 'dist/schemas-BOYIvvln.mjs')));
  const {i: compile} = await import(pathToFileURL(path.join(packageRoot, 'dist/compile-wI2qQAAF.mjs')));
  return {array: schemas.Nt, string: schemas.Jn, number: schemas.Pn, map: schemas.Tn,
    set: schemas.Kn, object: schemas.Fn, compile};
}

test('embedded Zod attestation refuses changed, incomplete and path-replaced commitments before filesystem access', async () => {
  for (const changed of [
    {...descriptor, fixCommit: '0'.repeat(40)},
    {...descriptor, files: descriptor.files.slice(1)},
    {...descriptor, files: descriptor.files.map((row, index) => index ? row : {...row, path: '../user-chain'})},
    {...descriptor, unexpected: true},
  ]) await assert.rejects(assertZodSecurity('/does-not-exist', changed), /commitment is invalid/);
});

test('all exact embedded Zod outputs are present in the installed package', native, async () => {
  assert.equal(descriptor.files.length, 18);
  assert.deepEqual(await assertZodSecurity(packageRoot, descriptor), descriptor);
});

test('every embedded interpreter gates oversized arrays before evaluating children', native, async () => {
  let copies = 0;
  for (const row of descriptor.files) {
    const source = await fs.readFile(path.join(packageRoot, row.path), 'utf8');
    if (!source.includes('$ZodArray = ')) continue;
    copies++;
    const initialize = interpreter(source);
    let children = 0;
    const instance = {_zod: {}};
    initialize(instance, {checks: [check(2)], element: {_zod: {run: payload => {
      children++;
      return {value: payload.value.toUpperCase(), issues: []};
    }}}});
    const rejected = instance._zod.parse({value: Array(10000).fill('a'), issues: []}, {});
    assert.equal(children, 0, row.path);
    assert.equal(rejected.issues.length, 1, row.path);
    assert.equal(rejected.issues[0].code, 'too_big');
    assert.equal(rejected.issues[0].continue, false);
    assert.equal(rejected.issues[0].schema, instance);
    const accepted = instance._zod.parse({value: ['a'], issues: []}, {});
    assert.equal(children, 1);
    assert.deepEqual(Array.from(accepted.value), ['A']);
    assert.equal(accepted.issues.length, 0);
    for (const context of [{skipChecks: true}, {direction: 'backward'}]) {
      children = 0;
      const payload = instance._zod.parse({value: ['a', 'b', 'c'], issues: []}, context);
      assert.equal(children, 3, `${row.path}: preserve upstream internal context semantics`);
      assert.equal(payload.issues.length, 0);
    }
  }
  assert.equal(copies, 17);
});

test('both embedded compilers emit upper bounds before array/map/set child work', native, async () => {
  let copies = 0;
  for (const row of descriptor.files) {
    const source = await fs.readFile(path.join(packageRoot, row.path), 'utf8');
    if (!source.includes('function generateArrayCheck(')) continue;
    copies++;
    for (const kind of ['Array', 'Map', 'Set']) {
      let next = 0, touched = 0;
      const context = {Array, Map, Set, INVALID: Symbol('invalid'), ZodCompileUnsupportedError: Error,
        newVar: () => `v${next++}`,
        compileChild: doc => { doc.write('touch();'); return 'true'; },
        generateCheck: doc => { doc.write('touch();'); return 'true'; },
        touch: () => { touched++; },
      };
      vm.createContext(context);
      const code = ['__chainchatZodSizeCaps', '__chainchatZodGenerateSizeGate', 'numericOperand', `generate${kind}Check`]
        .map(name => declaration(source, name)).join('\n');
      vm.runInContext(code, context, {timeout: 2000});
      const lines = [], doc = {write: line => lines.push(line), indented: action => action(doc)};
      const schema = {_zod: {def: {checks: [check(2, kind === 'Array' ? 'length' : 'size')]}}};
      context[`generate${kind}Check`](doc, {}, schema, 'input');
      const validate = vm.runInContext(`(input) => { ${lines.join('\n')} return true; }`, context, {timeout: 2000});
      const oversized = kind === 'Array' ? ['a', 'b', 'c'] : kind === 'Map' ? new Map([[1, 1], [2, 2], [3, 3]]) : new Set([1, 2, 3]);
      assert.equal(validate(oversized), context.INVALID, `${row.path}: ${kind}`);
      assert.equal(touched, 0, `${row.path}: ${kind} children must not run`);
      const normal = kind === 'Array' ? ['a'] : kind === 'Map' ? new Map([[1, 1]]) : new Set([1]);
      assert.equal(validate(normal), true);
      assert.ok(touched > 0, `${row.path}: ${kind} normal children still run`);
    }
  }
  assert.equal(copies, 2);
});

test('actual Zod interpreter and compiled APIs reject oversized collections without visiting elements', native, async () => {
  const z = await actualZod();
  let visited = 0;
  const child = z.string().refine(() => { visited++; return true; });
  const cases = [
    [z.array(child).max(2), Array(10000).fill('a')],
    [z.array(child).length(2), ['a', 'b', 'c']],
    [z.map(child, child).max(2), new Map([['a', 'a'], ['b', 'b'], ['c', 'c']])],
    [z.set(child).size(2), new Set(['a', 'b', 'c'])],
  ];
  for (const [schema, input] of cases) {
    for (const parser of [schema, z.compile(schema)]) {
      const result = parser.safeParse(input);
      assert.equal(result.success, false);
      assert.equal(result.error.issues.length, 1);
      assert.equal(result.error.issues[0].code, 'too_big');
      assert.equal(visited, 0);
    }
  }
  const sparse = Array(10000);
  Object.defineProperty(sparse, 0, {get() { throw new Error('Oversized array element was accessed'); }});
  assert.equal(z.compile(z.array(z.string()).max(2)).safeParse(sparse).success, false);
  const nested = z.object({items: z.array(z.string()).max(1)}).safeParse({items: [1, 2]});
  assert.deepEqual(nested.error.issues.map(issue => ({code: issue.code, path: issue.path})), [{code: 'too_big', path: ['items']}]);
});

test('actual Zod preserves normal transforms, type errors and leading overwrite ordering', native, async () => {
  const z = await actualZod();
  for (const schema of [z.array(z.string().transform(value => value.toUpperCase())).max(2),
    z.array(z.string()).overwrite(values => values.slice(0, 2)).max(2)]) {
    const input = schema._zod.def.checks[0]._zod.def.check === 'overwrite' ? ['a', 'b', 'c'] : ['a', 'b'];
    const expected = input.length === 3 ? ['a', 'b'] : ['A', 'B'];
    for (const parser of [schema, z.compile(schema)]) assert.deepEqual(parser.parse(input), expected);
  }
  for (const [schema, input] of [[z.array(z.string()).max(2), {}],
    [z.map(z.string(), z.string()).max(2), new Set(['a'])],
    [z.set(z.string()).max(2), new Map([['a', 'b']])]]) {
    for (const parser of [schema, z.compile(schema)]) {
      const result = parser.safeParse(input);
      assert.equal(result.success, false);
      assert.equal(result.error.issues[0].code, 'invalid_type');
    }
  }
});

test('actual asynchronous Zod size rejection starts no child refinements', native, async () => {
  const z = await actualZod();
  let started = 0;
  const schema = z.array(z.string().refine(async () => { started++; return true; })).max(1);
  const result = await schema.safeParseAsync(['a', 'b']);
  assert.equal(result.success, false);
  assert.equal(result.error.issues.length, 1);
  assert.equal(result.error.issues[0].code, 'too_big');
  assert.equal(started, 0);
});
