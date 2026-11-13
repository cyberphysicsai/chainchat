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
export function nativeSchemaNodes(envelope, parts = []) {
  const root = envelope?.schema || envelope || {}; let nodes = variants(root, root);
  for (const part of parts) nodes = nodes.flatMap(node => {
    const children = []; if (node.properties?.[part]) children.push(node.properties[part]);
    for (const [pattern, child] of Object.entries(node.patternProperties || {})) {
      try { if (pattern.length <= 1024 && new RegExp(pattern, 'u').test(part)) children.push(child); } catch { /* A malformed optional pattern is rejected by native validation. */ }
    }
    if (/^\d+$/u.test(part) && node.items) children.push(Array.isArray(node.items) ? node.items[Number(part)] : node.items);
    if (!children.length && plain(node.additionalProperties)) children.push(node.additionalProperties);
    return children.flatMap(child => variants(child, root));
  });
  return nodes;
}
function hintFor(envelope, parts) {
  const hints = envelope?.uiHints || {}; let result = {};
  for (const [pattern, hint] of Object.entries(hints)) {
    const wanted = pattern.startsWith('/') ? parseConfigPath(pattern) : pattern.split('.');
    if (wanted.length <= parts.length && wanted.every((part, index) => part === '*' || part === parts[index])) result = { ...result, ...hint };
  }
  return result;
}
export function isNativeSensitive(envelope, parts) {
  return nativeCredentialKey(parts.at(-1) || '') || hintFor(envelope, parts).sensitive === true || nativeSchemaNodes(envelope, parts).some(node => node.sensitive === true || node.writeOnly === true || node.format === 'password');
}
export function assertNoNativeSecrets(value, { schema, basePath = [] } = {}) {
  const walk = (item, parts, depth) => {
    if (depth > 40) throw failure('Native configuration is too deeply nested.');
    if (nativeRedactionValue(item)) throw failure('Redacted credentials cannot be saved as native configuration. Use the dedicated credential controls.');
    if (parts.length && isNativeSensitive(schema, parts) && item !== undefined && item !== null && item !== '') throw failure('Credentials belong in the dedicated native credential controls.');
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { if (unsafe(key)) throw failure('Unsafe native configuration key.'); walk(child, [...parts, key], depth + 1); }
  };
  walk(value, basePath, 0); return value;
}
const privateTarget = parts => ['gateway', 'env', 'auth', 'secrets', 'models', 'update', 'discovery', 'meta'].includes(parts[0]) || parts[0] === 'plugins' && ['cypher-tempre-poi', 'browser'].includes(parts[2]);
export function nativeSensitiveFields(config, envelope) {
  if (!envelope) return [];
  const found = new Map(); let visited = 0;
  function walk(value, parts) {
    if (++visited > 50000 || parts.length > 32) throw failure('Native credential schema exceeds its safety bound.');
    if (parts.length && privateTarget(parts)) return;
    if (parts.length && isNativeSensitive(envelope, parts)) {
      const nodes = nativeSchemaNodes(envelope, parts), reference = nodes.some(node => node.properties?.source && node.properties?.provider && node.properties?.id);
      const hint = hintFor(envelope, parts), target = configPointer(parts);
      const scalar = nodes.some(node => node.type === 'string' || Array.isArray(node.type) && node.type.includes('string'));
      if (reference || scalar || typeof value === 'string' || value === undefined && !nodes.some(node => node.type === 'object' || node.type === 'array')) {
        found.set(target, { target, path: [...parts], label: hint.label || parts.join(' / '), projection: reference ? 'secret-ref' : 'env-string' }); return;
      }
    }
    if (Array.isArray(value)) { value.forEach((child, index) => walk(child, [...parts, String(index)])); return; }
    if (!plain(value)) return;
    const keys = new Set(Object.keys(value));
    for (const node of nativeSchemaNodes(envelope, parts)) for (const key of Object.keys(node.properties || {})) if (isNativeSensitive(envelope, [...parts, key])) keys.add(key);
    for (const key of keys) if (!unsafe(key)) walk(value[key], [...parts, key]);
  }
  walk(config, []); return [...found.values()].sort((a, b) => a.target.localeCompare(b.target));
}
/** Strip credentials by schema, including non-obvious plugin-specific field names. */
export function redactNativeConfiguration(value, envelope) {
  const walk = (item, parts) => {
    if (parts.length && isNativeSensitive(envelope, parts) && item != null) return '[managed private value]';
    if (Array.isArray(item)) return item.map((child, index) => walk(child, [...parts, String(index)]));
    if (plain(item)) return Object.fromEntries(Object.entries(item).filter(([key]) => !unsafe(key)).map(([key, child]) => [key, walk(child, [...parts, key])]));
    return item;
  };
  return walk(value, []);
}
