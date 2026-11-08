import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

// Parse just element structure; no browser/runtime or provider connection is required.
function elements(source) {
  const all = [], stack = [], byId = new Map();
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const token of source.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>/gi)) {
    const text = token[0];
    if (/^<!/.test(text)) continue;
    const tag = /^<\/?([\w-]+)/.exec(text)[1].toLowerCase();
    if (/^<\//.test(text)) {
      assert.equal(stack.at(-1)?.tag, tag, `Unbalanced HTML at ${text}`);
      stack.pop();
      continue;
    }
    const attrs = Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    const node = { tag, attrs, parent: stack.at(-1), order: all.length };
    all.push(node);
    if (attrs.id) {
      assert.equal(byId.has(attrs.id), false, `Duplicate DOM target: ${attrs.id}`);
      byId.set(attrs.id, node);
    }
    if (!voids.has(tag) && !/\/\s*>$/.test(text)) stack.push(node);
  }
  assert.equal(stack.length, 0, 'All elements must close');
  return { all, byId };
}
const dom = elements(html);
function within(node, ancestor) {
  for (let current = node; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

test('conversation, faculty inventory, native runtime and identity are persistent sibling sections in reading order', () => {
  const ordered = ['chainchatWorkspace', 'loadoutSidebar', 'openclawPanel', 'agentSidebar'].map(id => dom.byId.get(id));
  assert.ok(ordered.every(Boolean));
  assert.equal(ordered[0].tag, 'main');
  assert.ok(ordered.slice(1).every(node => node.tag === 'section'));
  assert.ok(ordered.every(node => node.parent === ordered[0].parent));
  assert.ok(ordered.every((node, index) => !index || ordered[index - 1].order < node.order));
  for (const node of ordered) assert.equal((node.attrs.class || '').split(' ').includes('hidden'), false);
  const chat = ordered[0];
  for (const id of ['conversationScroll', 'messageInput', 'sendButton', 'recallAbility', 'cognitionAbility']) assert.ok(within(dom.byId.get(id), chat));
  assert.equal(within(ordered[1], chat), false);
  assert.equal(within(ordered[3], chat), false);
});

test('all ten abilities and the existing agent, inventory, model and native control targets survive the layout move', () => {
  const skills = dom.all.filter(node => node.attrs['data-shortcut']);
  assert.deepEqual(skills.map(node => node.attrs['data-shortcut']), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
  const bar = skills[0].parent;
  assert.equal(bar.tag, 'nav');
  assert.ok(skills.every(node => node.parent === bar && node.tag === 'button'));
  assert.ok(dom.byId.get('messageInput').order < bar.order, 'The ability row follows the chat composer');
  const inventory = dom.byId.get('loadoutSidebar'), identity = dom.byId.get('agentSidebar');
  for (const id of ['facultyList', 'modalitiesTab', 'sensesTab', 'facultySearch', 'manageFaculties', 'exchangeButton', 'clearLoadout']) assert.ok(within(dom.byId.get(id), inventory), id);
  for (const id of ['agentSelectButton', 'newAgentButton', 'existingAgentButton', 'verifyMini', 'ringCount', 'headHash', 'historyButton', 'covenantLink']) assert.ok(within(dom.byId.get(id), identity), id);
  const native = dom.byId.get('openclawPanel');
  assert.equal(dom.all.filter(node => node.attrs['data-native-tab'] && within(node, native)).length, 10);
  assert.equal(dom.byId.get('nativeConnectedControls').tag, 'fieldset');
  assert.match(html, /id="nativeConnectedControls"[^>]*disabled/);
  for (const match of app.matchAll(/\$\("([^"\n]+)"\)/g)) assert.ok(dom.byId.has(match[1]), `App target ${match[1]} is missing`);
  assert.equal(dom.byId.get('apiKey').attrs.type, 'password');
});

function navigationFixture(reducedMotion) {
  const calls = [], nodes = new Map();
  for (const [id] of dom.byId) nodes.set(id, {
    handlers: {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    focus(options) { calls.push({ kind: 'focus', id, ...options }); },
    scrollIntoView(options) { calls.push({ kind: 'scroll', id, ...options }); },
  });
  const start = app.indexOf('// Persistent workspace cards replace');
  const end = app.indexOf('for (const id of ["modalitiesTab", "sensesTab"])', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(app.slice(start, end), {
    $: id => nodes.get(id), window: { matchMedia: () => ({ matches: reducedMotion }) },
  });
  return { calls, click: id => nodes.get(id).handlers.click() };
}

test('faculty and agent shortcuts scroll to focusable headings without hiding cards or opening a mobile keyboard', () => {
  const f = navigationFixture(false);
  for (const [button, section, focus] of [
    ['loadoutAbility', 'loadoutSidebar', 'facultyTitle'],
    ['mobileLoadout', 'loadoutSidebar', 'facultyTitle'],
    ['mobileAgents', 'agentSidebar', 'agentDetailsTitle'],
  ]) {
    f.calls.length = 0;
    f.click(button);
    assert.deepEqual(f.calls, [
      { kind: 'focus', id: focus, preventScroll: true },
      { kind: 'scroll', id: section, behavior: 'smooth', block: 'start' },
    ]);
    assert.equal(dom.byId.get(focus).attrs.tabindex, '-1');
    assert.notEqual(focus, 'facultySearch');
  }
});

test('each card can return keyboard focus to chat, respecting reduced-motion preference', () => {
  const f = navigationFixture(true);
  for (const button of ['closeLoadout', 'closeAgents']) {
    f.calls.length = 0;
    f.click(button);
    assert.deepEqual(f.calls, [
      { kind: 'focus', id: 'chainchatWorkspace', preventScroll: true },
      { kind: 'scroll', id: 'chainchatWorkspace', behavior: 'instant', block: 'start' },
    ]);
  }
  assert.equal(dom.byId.get('chainchatWorkspace').attrs.tabindex, '-1');
});
