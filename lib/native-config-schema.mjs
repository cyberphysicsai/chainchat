/** Small, side-effect-free adapters for the installed OpenClaw configuration schema. */
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const unsafe = part => ['__proto__', 'prototype', 'constructor'].includes(part);
const failure = message => Object.assign(new Error(message), { code: 'OPENCLAW_NATIVE_SECRET_INVALID', status: 400 });
export const nativeCredentialKey = key => /^(?:(?:api|xApi|client|signing|webhook|app|bot|access|refresh|auth|broker|proxy|secret)[_-]?(?:key|token|secret)|token|password|passphrase|secret|credentials?|authorization|cookie|set[_-]?cookie|private[_-]?key|service[_-]?account[_-]?json)$/iu.test(key);
export const nativeRedactionValue = value => typeof value === 'string' && /(?:__OPENCLAW_REDACTED__|\[(?:managed private value|private|redacted)(?:[^\]]*)\])/iu.test(value);
export function parseConfigPath(value) {
  const parts = Array.isArray(value) ? value : typeof value === 'string' && value.startsWith('/') ? value.slice(1).split('/').map(part => {
    if (/~(?![01])/u.test(part)) throw failure('Invalid configuration pointer.');
    return part.replace(/~1/gu, '/').replace(/~0/gu, '~');
  }) : typeof value === 'string' ? value.split('.') : [];
  if (!parts.length || parts.length > 40 || parts.some(part => typeof part !== 'string' || !part || part.length > 512 || unsafe(part) || /[\0\r\n]/u.test(part))) throw failure('Invalid configuration path.');
  return [...parts];
}
export const configPointer = parts => '/' + parseConfigPath(parts).map(part => part.replace(/~/gu, '~0').replace(/\//gu, '~1')).join('/');
export const getConfigPath = (value, parts) => parseConfigPath(parts).reduce((item, part) => item && typeof item === 'object' && Object.hasOwn(item, part) ? item[part] : undefined, value);
export function setConfigPath(value, parts, child) {
  const path = parseConfigPath(parts); let current = value;
  for (const part of path.slice(0, -1)) { if (!plain(current[part]) && !Array.isArray(current[part])) current[part] = {}; current = current[part]; }
  current[path.at(-1)] = structuredClone(child); return value;
}
export function deleteConfigPath(value, parts) {
  const path = parseConfigPath(parts); let current = value;
  for (const part of path.slice(0, -1)) { if (!plain(current?.[part]) && !Array.isArray(current?.[part])) return value; current = current[part]; }
  if (Array.isArray(current)) throw failure('Reset the array setting as a whole rather than deleting an indexed item.');
  if (plain(current)) delete current[path.at(-1)];
  // Remove empty overlay scaffolding so a reset really falls back to native defaults.
  for (let size = path.length - 1; size > 0; size--) { const parent = getConfigPath(value, path.slice(0, size)), container = size === 1 ? value : getConfigPath(value, path.slice(0,size-1)); if (plain(parent) && !Object.keys(parent).length && !Array.isArray(container)) deleteConfigPath(value, path.slice(0, size)); else break; }
  return value;
}
function variants(node, root, seen = new Set()) {
  if (!plain(node)) return [];
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/') && !seen.has(node.$ref)) {
    const next = new Set(seen); next.add(node.$ref);
    const resolved = node.$ref.slice(2).split('/').map(part => part.replace(/~1/gu, '/').replace(/~0/gu, '~')).reduce((value, key) => value?.[key], root);
    return [...variants(resolved, root, next), ...variants(Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref')), root, next)];
  }
  return [node, ...['anyOf', 'oneOf', 'allOf'].flatMap(key => Array.isArray(node[key]) ? node[key].flatMap(child => variants(child, root, new Set(seen))) : [])];
}
/** A fresh inspector owns one operation's caches. Never retain it across schema
 * refreshes: a newly added sensitive hint must apply to the very next call. */
export function createNativeSchemaInspector(envelope) {
  const root = envelope?.schema || envelope || {}, nodeCache = new Map(), hintCache = new Map(), sensitiveCache = new Map();
  const expanded = new WeakMap(), patterns = new WeakMap();
  const expand = node => {
    if (!plain(node)) return [];
    if (!expanded.has(node)) expanded.set(node, variants(node, root));
    return expanded.get(node);
  };
  let hintRoot;
  // Index each hint once, rather than scanning every unrelated plugin hint for
  // every field. Preserve native insertion-order merging of all matching
  // ancestor, exact and wildcard hints, including explicit false overrides.
  function indexHints() {
    hintRoot = {children:new Map(), entries:[]}; let order = 0;
    for (const [pattern,hint] of Object.entries(envelope?.uiHints || {})) {
      const wanted = pattern.startsWith('/') ? parseConfigPath(pattern) : pattern.split('.'); let node = hintRoot;
      for (const part of wanted) { if (!node.children.has(part)) node.children.set(part,{children:new Map(),entries:[]}); node = node.children.get(part); }
      node.entries.push({order:order++,hint});
    }
  }
  function nodes(parts = []) {
    const key = JSON.stringify(parts); if (nodeCache.has(key)) return nodeCache.get(key);
    const result = !parts.length ? expand(root) : nodes(parts.slice(0,-1)).flatMap(node => {
      const part = parts.at(-1), children = []; if (node.properties?.[part]) children.push(node.properties[part]);
      if (!patterns.has(node)) patterns.set(node,Object.entries(node.patternProperties || {}).flatMap(([pattern,child]) => {
        try { return pattern.length <= 1024 ? [{pattern:new RegExp(pattern,'u'),child}] : []; } catch { return []; }
      }));
      for (const candidate of patterns.get(node)) if (candidate.pattern.test(part)) children.push(candidate.child);
      if (/^\d+$/u.test(part) && node.items) children.push(Array.isArray(node.items) ? node.items[Number(part)] : node.items);
      if (!children.length && plain(node.additionalProperties)) children.push(node.additionalProperties);
      return children.flatMap(expand);
    });
    nodeCache.set(key,result); return result;
  }
  function hint(parts) {
    const key = JSON.stringify(parts); if (hintCache.has(key)) return hintCache.get(key);
    if (!hintRoot) indexHints();
    let frontier = [hintRoot]; const matches = [...hintRoot.entries];
    for (const part of parts) {
      frontier = [...new Set(frontier.flatMap(node => [node.children.get(part),node.children.get('*')].filter(Boolean)))];
      if (!frontier.length) break;
      for (const node of frontier) matches.push(...node.entries);
    }
    matches.sort((a,b)=>a.order-b.order); let result = {};
    // Object spread retains an own JSON __proto__ key as data. Object.assign
    // would invoke the inherited setter and could forge inherited sensitivity.
    for (const entry of matches) result = {...result,...entry.hint};
    hintCache.set(key,result); return result;
  }
  function sensitive(parts) {
    const key = JSON.stringify(parts); if (sensitiveCache.has(key)) return sensitiveCache.get(key);
    const value = nativeCredentialKey(parts.at(-1)||'') || hint(parts).sensitive === true || nodes(parts).some(node=>node.sensitive===true||node.writeOnly===true||node.format==='password');
    sensitiveCache.set(key,value); return value;
  }
  return {nodes,hint,sensitive};
}
export function nativeSchemaNodes(envelope, parts = []) { return createNativeSchemaInspector(envelope).nodes(parts); }
export function isNativeSensitive(envelope, parts) {
  return createNativeSchemaInspector(envelope).sensitive(parts);
}
export function assertNoNativeSecrets(value, { schema, basePath = [] } = {}) {
  const inspector = createNativeSchemaInspector(schema);
  const walk = (item, parts, depth) => {
    if (depth > 40) throw failure('Native configuration is too deeply nested.');
    if (nativeRedactionValue(item)) throw failure('Redacted credentials cannot be saved as native configuration. Use the dedicated credential controls.');
    if (parts.length && inspector.sensitive(parts) && item !== undefined && item !== null && item !== '') throw failure('Credentials belong in the dedicated native credential controls.');
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { if (unsafe(key)) throw failure('Unsafe native configuration key.'); walk(child, [...parts, key], depth + 1); }
  };
  walk(value, basePath, 0); return value;
}
const privateTarget = parts => ['gateway', 'env', 'auth', 'secrets', 'models', 'update', 'discovery', 'meta'].includes(parts[0]) || parts[0] === 'plugins' && ['cypher-tempre-poi', 'browser'].includes(parts[2]);
export function nativeSensitiveFields(config, envelope) {
  if (!envelope) return [];
  const found = new Map(), inspector = createNativeSchemaInspector(envelope); let visited = 0;
  function walk(value, parts) {
    if (++visited > 50000 || parts.length > 32) throw failure('Native credential schema exceeds its safety bound.');
    if (parts.length && privateTarget(parts)) return;
    if (parts.length && inspector.sensitive(parts)) {
      const nodes = inspector.nodes(parts), reference = nodes.some(node => node.properties?.source && node.properties?.provider && node.properties?.id);
      const hint = inspector.hint(parts), target = configPointer(parts);
      const scalar = nodes.some(node => node.type === 'string' || Array.isArray(node.type) && node.type.includes('string'));
      if (reference || scalar || typeof value === 'string' || value === undefined && !nodes.some(node => node.type === 'object' || node.type === 'array')) {
        found.set(target, { target, path: [...parts], label: hint.label || parts.join(' / '), projection: reference ? 'secret-ref' : 'env-string' }); return;
      }
    }
    if (Array.isArray(value)) { value.forEach((child, index) => walk(child, [...parts, String(index)])); return; }
    if (!plain(value)) return;
    const keys = new Set(Object.keys(value));
    for (const node of inspector.nodes(parts)) for (const key of Object.keys(node.properties || {})) if (inspector.sensitive([...parts, key])) keys.add(key);
    for (const key of keys) if (!unsafe(key)) walk(value[key], [...parts, key]);
  }
  walk(config, []); return [...found.values()].sort((a, b) => a.target.localeCompare(b.target));
}
/** Strip credentials by schema, including non-obvious plugin-specific field names. */
export function redactNativeConfiguration(value, envelope) {
  const inspector = createNativeSchemaInspector(envelope);
  const walk = (item, parts) => {
    if (parts.length && inspector.sensitive(parts) && item != null) return '[managed private value]';
    if (Array.isArray(item)) return item.map((child, index) => walk(child, [...parts, String(index)]));
    if (plain(item)) return Object.fromEntries(Object.entries(item).filter(([key]) => !unsafe(key)).map(([key, child]) => [key, walk(child, [...parts, key])]));
    return item;
  };
  return walk(value, []);
}
