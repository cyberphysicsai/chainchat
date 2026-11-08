import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {FONT_MODES, FONT_MODE_STORAGE_KEY, normalizeFontMode, storedFontMode, initFontModes} from '../public/font-modes.js';
import {THEMES, THEME_STORAGE_KEY, initThemes} from '../public/themes.js';

function fixture({font = null, theme = null, denied = false, embedded = false} = {}) {
  const values = new Map([[FONT_MODE_STORAGE_KEY, font], [THEME_STORAGE_KEY, theme]]), writes = [], reads = [], messages = [];
  class Button extends EventTarget {
    constructor(key, value) {super(); this.dataset = {[key]: value}; this.attributes = new Map();}
    setAttribute(key, value) {this.attributes.set(key, value);}
  }
  const fontButtons = FONT_MODES.map(mode => new Button('fontChoice', mode));
  const themeButtons = THEMES.map(mode => new Button('themeChoice', mode));
  const root = {dataset: {}, style: {setProperty() {}}}, meta = {setAttribute() {}};
  const frame = new EventTarget(); frame.contentWindow = {postMessage(data, origin) {messages.push({data, origin});}};
  const doc = {documentElement: root,
    querySelectorAll: selector => selector === '[data-font-choice]' ? fontButtons : selector === '[data-theme-choice]' ? themeButtons : [],
    querySelector: selector => selector === 'meta[name="theme-color"]' ? meta : null,
    getElementById: id => id === 'auditFrame' && !embedded ? frame : null};
  const view = new EventTarget(); view.location = {origin: 'https://fixture.example'};
  view.parent = embedded ? {} : view; view.CustomEvent = CustomEvent;
  const storage = {getItem(key) {reads.push(key); if (denied) throw Error('denied'); return values.get(key) ?? null;},
    setItem(key, value) {if (denied) throw Error('denied'); values.set(key, value); writes.push({key, value});}};
  const fonts = initFontModes({document: doc, window: view, storage});
  const themes = initThemes({document: doc, window: view, storage});
  const event = (type, fields) => {const event = new Event(type); Object.assign(event, fields); view.dispatchEvent(event);};
  return {root, view, doc, frame, fonts, themes, fontButtons, themeButtons, writes, reads, messages, values, event};
}

test('font preferences whitelist three modes, restore the choice and store no other user data', () => {
  for (const value of [undefined, null, {}, 'private-api-key', '<style>', 'Clarity']) assert.equal(normalizeFontMode(value), 'cyber');
  assert.equal(storedFontMode({getItem() {throw Error('denied');}}), 'cyber');
  const f = fixture({font: 'typewriter'});
  assert.equal(f.root.dataset.fontMode, 'typewriter'); assert.equal(f.writes.length, 0);
  f.fontButtons[2].dispatchEvent(new Event('click'));
  assert.equal(f.fonts.current(), 'clarity');
  assert.deepEqual(f.fontButtons.map(button => button.attributes.get('aria-pressed')), ['false', 'false', 'true']);
  assert.deepEqual(f.writes, [{key: FONT_MODE_STORAGE_KEY, value: 'clarity'}]);
  assert.deepEqual(f.reads, [FONT_MODE_STORAGE_KEY, THEME_STORAGE_KEY]);
  const reload = fixture({font: f.values.get(FONT_MODE_STORAGE_KEY)});
  assert.equal(reload.fonts.current(), 'clarity');
});

test('all nine font and color combinations remain independently selectable', () => {
  for (const theme of THEMES) for (const font of FONT_MODES) {
    const f = fixture(); f.themes.apply(theme); f.fonts.apply(font);
    assert.equal(f.root.dataset.theme, theme); assert.equal(f.root.dataset.fontMode, font);
    assert.equal(f.themes.current(), theme); assert.equal(f.fonts.current(), font);
    f.themes.apply('light'); assert.equal(f.fonts.current(), font);
    f.fonts.apply('cyber'); assert.equal(f.themes.current(), 'light');
  }
});

test('blocked local storage never prevents font controls or modifies the selected theme', () => {
  const f = fixture({denied: true}); f.themes.apply('matrix');
  f.fontButtons[1].dispatchEvent(new Event('click'));
  assert.equal(f.root.dataset.fontMode, 'typewriter'); assert.equal(f.root.dataset.theme, 'matrix');
  assert.deepEqual(f.writes, []);
  const view = new EventTarget(); view.CustomEvent = CustomEvent; view.parent = view; view.location = f.view.location;
  Object.defineProperty(view, 'localStorage', {get() {throw Error('getter denied');}});
  const mode = initFontModes({document: f.doc, window: view});
  assert.equal(mode.apply('clarity'), 'clarity');
});

test('cross-tab font updates and cleared preferences do not write back or replace a theme', () => {
  const f = fixture({font: 'typewriter', theme: 'matrix'});
  f.event('storage', {key: 'agent-session', newValue: 'private-key'});
  assert.equal(f.fonts.current(), 'typewriter');
  f.event('storage', {key: FONT_MODE_STORAGE_KEY, newValue: 'clarity'});
  assert.equal(f.fonts.current(), 'clarity'); assert.equal(f.themes.current(), 'matrix');
  f.event('storage', {key: null, newValue: null});
  assert.equal(f.fonts.current(), 'cyber'); assert.equal(f.themes.current(), 'matrix');
  assert.equal(f.writes.length, 0);
});

test('embedded auditor accepts font presentation only from its exact same-origin parent', () => {
  const f = fixture({embedded: true});
  const incoming = (overrides = {}) => f.event('message', {source: f.view.parent, origin: f.view.location.origin,
    data: {type: 'chainchat-font-mode', mode: 'clarity'}, ...overrides});
  incoming({source: {}}); incoming({origin: 'https://different.example'});
  incoming({data: {type: 'chainchat-font-mode', mode: 'private-key'}});
  incoming({data: {type: 'agent-session', mode: 'clarity'}});
  assert.equal(f.fonts.current(), 'cyber'); incoming();
  assert.equal(f.fonts.current(), 'clarity'); assert.equal(f.themes.current(), 'dark');
  assert.equal(f.writes.length, 0);
  const parent = fixture(); parent.fonts.apply('typewriter'); parent.frame.dispatchEvent(new Event('load'));
  assert.deepEqual(parent.messages.filter(message => message.data.type === 'chainchat-font-mode').at(-1),
    {data: {type: 'chainchat-font-mode', mode: 'typewriter'}, origin: 'https://fixture.example'});
  parent.event('message', {source: parent.frame.contentWindow, origin: parent.view.location.origin,
    data: {type: 'chainchat-font-mode', mode: 'clarity'}});
  assert.equal(parent.fonts.current(), 'typewriter');
});

const read = name => fs.readFile(new URL('../public/' + name, import.meta.url));
test('both interfaces load the shared local-only font controls and preserve existing theme controls', async () => {
  const [html, audit, app, auditor, css] = await Promise.all(['index.html', 'audit/index.html', 'app.js', 'audit/app.js', 'font-modes.css'].map(async name => (await read(name)).toString()));
  assert.match(html, /role="group" aria-label="Font mode"/);
  for (const font of FONT_MODES) assert.match(html, new RegExp(`type="button" data-font-choice="${font}" aria-pressed="(?:true|false)"`));
  for (const theme of THEMES) assert.ok(html.includes(`data-theme-choice="${theme}"`));
  assert.ok(html.indexOf('class="font-selector"') > html.indexOf('class="theme-selector"'));
  assert.match(audit, /href="\.\.\/font-modes\.css"/);
  for (const source of [app, auditor]) assert.match(source, /initFontModes\(\)/);
  assert.doesNotMatch(css, /https?:|@import|data:/i);
  assert.match(css, /font-variant-ligatures: none/);
  assert.match(css, /:is\(pre, code, kbd, samp, \.mono\)/);
});

test('bundled fonts retain exact upstream bytes and their redistribution licenses', async () => {
  const files = {
    'courier-prime/CourierPrime-Regular.ttf': '72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af',
    'courier-prime/CourierPrime-Bold.ttf': 'ff1f38786c849d1c41fa8e447960abdb2bd75fdfb0cfcdeb524fad65a5af3638',
    'courier-prime/CourierPrime-Italic.ttf': 'f1b9a5829789f7e56432a9f3bc7665ef4531dbba1c112639e48bef39621a006b',
    'courier-prime/CourierPrime-BoldItalic.ttf': '3355273f3ea6d6362658f9564f4e83d59e156cf1a182e3c1592b5c5943627dcc',
    'manrope/Manrope-cyrillic-ext.woff2': '3c09135e88bbfcd848e99be137710afbb615a8d9a73c5c48e6cb0245a162af1d',
    'manrope/Manrope-cyrillic.woff2': '447c49583b1b735cc6f566151db1d24354cec41076c55dd98455cfbde9e806c1',
    'manrope/Manrope-greek.woff2': 'e507c109c31789b33994646b457ee288639324516357250607c9b1398186e069',
    'manrope/Manrope-vietnamese.woff2': 'dbf64d973b3987844df30992c93f47d24ac8935ee8c9b1e320942aeb1b367703',
    'manrope/Manrope-latin-ext.woff2': '2f7335119075b2079f1d882530bbc18728461612bf90743203d73a74a48f4d9b',
    'manrope/Manrope-latin.woff2': '8c2def024c1bf31aacf3624ae3c4d701269b4ec3dc765c04830839f0d36b2d9e',
  };
  const notes = (await read('fonts/README.txt')).toString();
  for (const [name, sha] of Object.entries(files)) {
    const font = await read('fonts/' + name);
    assert.equal(font.readUInt32BE(0), name.endsWith('.woff2') ? 0x774f4632 : 0x00010000, name + ' must be a real font');
    assert.equal(createHash('sha256').update(font).digest('hex'), sha, name);
    assert.ok(notes.includes(name) && notes.includes(sha));
  }
  for (const family of ['courier-prime', 'manrope']) {
    const license = (await read(`fonts/${family}/OFL.txt`)).toString();
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(license, /Copyright/);
  }
});
