/** Explicit operator-only setup of the pinned optional browser, without system installation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { resolveBrowserRuntime, discoverManagedBrowserExecutable, discoverBrowserExecutable, BROWSER_INSTALL_GUIDANCE } from './browser-discovery.mjs';

const failure = (message, code = 'BROWSER_BOOTSTRAP_FAILED') => Object.assign(new Error(message), { code, status: 409 });
const ENVIRONMENT = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);

export function createBrowserBootstrap({ cacheDirectory, packageRoot, nodePath = process.execPath, environment = process.env,
  discoverBrowser = discoverBrowserExecutable } = {}) {
  if (!path.isAbsolute(cacheDirectory || '') || !path.isAbsolute(packageRoot || '') || !path.isAbsolute(nodePath || ''))
    throw failure('Browser setup requires private absolute installation paths.');
  let installing = null, child = null, closed = false, lastFailure = null, generation = 0;
  async function status() {
    const runtime = await resolveBrowserRuntime({ packageRoot });
    const installed = !!await discoverManagedBrowserExecutable({ cacheDirectory, packageRoot });
    // Report the same read-only system discovery used at launch, rather than
    // describing an absent managed download as an absent usable browser.
    const systemAvailable = !installed && !!await discoverBrowser({ cacheDirectory, packageRoot, env: environment });
    return { state: installing ? 'installing' : installed ? 'installed' : systemAvailable ? 'available' : lastFailure ? 'failed' : 'not-installed',
      version: runtime.version, revision: runtime.revision,
      ...(installed || systemAvailable ? { browserSource: installed ? 'managed' : 'system' } : {}),
      ...(installed ? {} : { guidance: systemAvailable
        ? 'A supported system browser is available for ChainChat’s separate owned profile. Managed Chromium setup is optional; personal browser data is not imported.'
        : BROWSER_INSTALL_GUIDANCE }),
      ...(lastFailure ? { code: lastFailure } : {}) };
  }
  async function install() {
    if (closed) throw failure('Browser setup is closed.');
    if (installing) return installing;
    const attempt = generation;
    installing = (async () => {
      lastFailure = null;
      const runtime = await resolveBrowserRuntime({ packageRoot });
      if (await discoverManagedBrowserExecutable({ cacheDirectory, packageRoot })) return { ...await status(), state: 'installed' };
      await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
      const info = await fs.lstat(cacheDirectory), canonical = await fs.realpath(cacheDirectory);
      if (!info.isDirectory() || info.isSymbolicLink() || path.relative(path.resolve(cacheDirectory), canonical) ||
          process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o022))
        throw failure('Browser cache must be a private directory owned by your user.', 'BROWSER_CACHE_UNSAFE');
      if (closed || attempt !== generation) throw failure('Browser setup was cancelled.');
      const env = Object.fromEntries(Object.entries(environment).filter(([key]) => ENVIRONMENT.has(key.toUpperCase())));
      env.PLAYWRIGHT_BROWSERS_PATH = canonical;
      await new Promise((resolve, reject) => {
        let finished = false;
        const settle = error => { if (finished) return; finished = true; clearTimeout(timer); child = null; error ? reject(error) : resolve(); };
        child = spawn(nodePath, [runtime.cliPath, 'install', 'chromium'], { cwd: path.dirname(runtime.cliPath), env,
          shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
        const timer = setTimeout(() => { child?.kill(); settle(failure('Browser download timed out. Retry setup when the network is available.')); }, 10 * 60 * 1000);
        timer.unref?.();
        child.once('error', () => settle(failure('The bundled browser installer could not start.')));
        child.once('exit', code => settle(code === 0 && !closed && attempt === generation ? null : failure('Browser setup did not complete. Check network access and required browser system libraries, then retry.')));
      });
      if (!await discoverManagedBrowserExecutable({ cacheDirectory, packageRoot })) throw failure('The downloaded Chromium executable could not be verified.');
      return { ...await status(), state: 'installed' };
    })().catch(error => { lastFailure = error.code || 'BROWSER_BOOTSTRAP_FAILED'; throw error; }).finally(() => { installing = null; });
    return installing;
  }
  async function cancel() {
    generation++;
    const owned = child;
    if (owned?.pid && owned.exitCode === null && owned.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(owned.pid), '/T', '/F'],
          { windowsHide: true, timeout: 5000 }, () => resolve()));
      } else {
        try { process.kill(-owned.pid, 'SIGKILL'); }
        catch { owned.kill('SIGKILL'); }
      }
      let timer;
      try {
        await Promise.race([installing?.catch(() => {}), new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure('The owned browser installer did not confirm shutdown.')), 5000);
        })]);
      } finally { clearTimeout(timer); }
    } else await installing?.catch(() => {});
  }
  return { status, install, cancel, async close() { closed = true; await cancel(); } };
}
