"""Apply exact official same-major security archives to npm's bundled copies.

No lifecycle scripts, credentials, source patches, shell commands or user npm
configuration are involved. The committed pin records both SHA-256 and npm SRI.
"""
import argparse
import base64
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tarfile
import tempfile
import urllib.request

PINS = {
    'ip-address': ('10.7.6', 'd593a65a5ffa85e704ffd4b2c7220d2c5c3ff879264416f694b2a15d124be7ca', 'sha512-00LYkM6byILa9eQIx6qoaXCM40xTLd56AZ4vyaPW3YTyb49VZYPo5xsiAq4tuQ54GH4R7gVdYScJ1B7B77PuTg=='),
}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Security archive redirects are not accepted.')

def validate_pin(pin):
    name = pin.get('name')
    if name not in PINS:
        raise ValueError('Unsupported bundled security overlay.')
    version, sha256, integrity = PINS[name]
    if pin.get('target') != 'node_modules/npm/node_modules/' + name or pin.get('version') != version or pin.get('source') != 'https://registry.npmjs.org/' + name + '/-/' + name + '-' + version + '.tgz' or pin.get('sha256') != sha256 or pin.get('integrity') != integrity:
        raise ValueError('The bundled security overlay differs from its reviewed archive.')

def verify_archive(data, pin):
    validate_pin(pin)
    if len(data) > 4 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != pin['sha256'] or 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() != pin['integrity']:
        raise ValueError('The bundled security archive failed verification.')

def extract_archive(data, destination):
    total, seen = 0, set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        if len(members) > 1024:
            raise ValueError('The security archive has too many entries.')
        for member in members:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != 'package' or '..' in parts or '\\' in member.name or ':' in member.name or member.name.startswith('/') or not (member.isfile() or member.isdir()):
                raise ValueError('The security archive has an unsafe member.')
            key = member.name.casefold()
            if key in seen:
                raise ValueError('The security archive has duplicate paths.')
            seen.add(key)
            total += member.size
            if total > 4 * 1024 * 1024:
                raise ValueError('The security archive exceeds the extracted limit.')
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o644)

def apply_npm_archives(npm_root, pins, cache):
    npm_root, cache = Path(os.path.abspath(npm_root)), Path(cache).resolve()
    if not npm_root.is_dir() or npm_root.is_symlink() or npm_root.resolve() != npm_root:
        raise ValueError('The owned npm directory is invalid.')
    if not isinstance(pins, list) or len(pins) != 1 or not isinstance(pins[0], dict):
        raise ValueError('The required bundled security overlay commitment is missing or duplicated.')
    validate_pin(pins[0])
    cache.mkdir(parents=True, exist_ok=True)
    results = []
    for pin in pins:
        archive_file = cache / (pin['name'] + '-' + pin['version'] + '-' + pin['sha256'] + '.tgz')
        if archive_file.exists():
            if not archive_file.is_file() or archive_file.is_symlink() or archive_file.stat().st_size > 4 * 1024 * 1024:
                raise ValueError('The security cache entry is invalid.')
            data = archive_file.read_bytes()
        else:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(urllib.request.Request(pin['source'], headers={'User-Agent': 'CypherTempre-ChainChat-Installer'}), timeout=60) as response:
                if response.status != 200:
                    raise ValueError('The security registry archive was unavailable.')
                data = response.read(4 * 1024 * 1024 + 1)
            verify_archive(data, pin)
            with archive_file.open('xb') as output:
                output.write(data)
        verify_archive(data, pin)
        relative = PurePosixPath(pin['target']).relative_to('node_modules/npm')
        target = npm_root.joinpath(*relative.parts)
        if target.is_symlink() or not target.is_dir() or target.resolve() != target or not target.is_relative_to(npm_root):
            raise ValueError('The exact bundled package target is invalid.')
        parent = target.parent
        with tempfile.TemporaryDirectory(prefix='.chainchat-security-', dir=parent) as temporary:
            temporary = Path(temporary)
            extract_archive(data, temporary)
            replacement = temporary / 'package'
            package = json.loads((replacement / 'package.json').read_text(encoding='utf-8'))
            if package.get('name') != pin['name'] or package.get('version') != pin['version']:
                raise ValueError('The official security archive package differs from its pin.')
            backup = temporary / 'previous'
            # Both resolved paths are within this exact owned npm dependency
            # directory. Rename first so any failed replacement can roll back.
            if parent.resolve() != parent or temporary.resolve().parent != parent:
                raise ValueError('The security staging directory changed ownership.')
            os.replace(target, backup)
            try:
                os.replace(replacement, target)
            except BaseException:
                os.replace(backup, target)
                raise
        results.append({'target': pin['target'], 'version': pin['version'], 'sha256': pin['sha256']})
    return results


def apply(application, cache):
    application, cache = Path(application).resolve(strict=True), Path(cache).resolve()
    runtime = application / 'openclaw/runtime'
    if not runtime.is_dir() or runtime.is_symlink() or runtime.resolve() != runtime:
        raise ValueError('The owned runtime directory is invalid.')
    pins = json.loads((application / 'openclaw/upstream-lock.json').read_text(encoding='utf-8')).get('bundledDependencyOverlays')
    # Check the commitment before resolving an installed package or creating a
    # cache. In particular, an incomplete lock must not become a no-op install.
    if not isinstance(pins, list) or len(pins) != 1 or not isinstance(pins[0], dict):
        raise ValueError('The required bundled security overlay commitment is missing or duplicated.')
    validate_pin(pins[0])
    return apply_npm_archives(runtime / 'node_modules/npm', pins, cache)


def apply_all(application, cache):
    npm_module = _source_helper('npm_security')
    zod_module = _source_helper('zod_security_overlay')
    npm_descriptor, zod_descriptor = npm_module.DESCRIPTOR, zod_module.DESCRIPTOR
    application = Path(application).resolve(strict=True)
    lock = json.loads((application / 'openclaw/upstream-lock.json').read_text(encoding='utf-8'))
    if lock.get('npmSecurityOverlays') != [npm_descriptor] or lock.get('runtimeSecurityOverlays') != [zod_descriptor]:
        raise ValueError('A required dependency security backport commitment is missing or changed.')
    archives = apply(application, cache)
    npm_root = application / 'openclaw/runtime/node_modules/npm'
    npm_patch = npm_module.apply_npm_security(npm_root, npm_descriptor)
    zod_patch = zod_module.apply_package(application / 'openclaw/runtime/node_modules/openclaw', zod_descriptor)
    return {'bundledSecurityOverlays': archives, 'npmSecurityOverlays': [npm_patch],
            'runtimeSecurityOverlays': [zod_patch]}


def _source_helper(name):
    # Windows embedded Python does not add the script directory to sys.path.
    # Load only known, payload-verified sibling source; never adjacent bytecode.
    if name not in ('npm_security', 'zod_security_overlay'):
        raise ValueError('An unsupported installer helper was requested.')
    filename = Path(__file__).absolute().parent / (name + '.py')
    info = filename.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 2 * 1024 * 1024 or filename.resolve() != filename:
        raise ValueError('The reviewed installer helper changed ownership.')
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    exec(compile(filename.read_bytes(), str(filename), 'exec'), module.__dict__)
    return module

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--application', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(apply_all(args.application, args.cache)))
