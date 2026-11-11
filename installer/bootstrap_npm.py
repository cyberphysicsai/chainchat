"""Build and verify a secured npm tree without executing Node's bundled npm.

The original Node archive remains separately pinned. Only a new, security-profile
keyed staging directory may receive this replacement; existing runtimes are read
and verified, never modified. All package bytes are verified before extraction.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile
import types
import urllib.parse
import urllib.request
import zipfile

BOOTSTRAP_NPM = {
    'name': 'npm',
    'version': '12.2.2',
    'source': 'https://registry.npmjs.org/npm/-/npm-12.2.2.tgz',
    'integrity': 'sha512-KglgbZyacf7jH+FHuNRqVuCzQi8VhI2a7J87Ix43FsPTuZoGWmIXXGdZtBUOA79vwL+IJREqURVzupA7PsQTcA==',
    'sha256': '07fecbf753e2c3bc10ebeb3e9ed8738f6a0cc1292998b79e2e9f1dd2a5525e0c',
}
MAX_NPM_ARCHIVE = 32 * 1024 * 1024
MAX_NPM_EXPANDED = 128 * 1024 * 1024
MAX_NPM_ENTRIES = 20000
MAX_NODE_ARCHIVE = 1024 * 1024 * 1024
MAX_NODE_EXPANDED = 4 * MAX_NODE_ARCHIVE


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Bootstrap npm archive redirects are not accepted.')


def digest_file(filename):
    digest = hashlib.sha256()
    with io_path(filename).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def safe_parts(name):
    parts = name.rstrip('/').split('/')
    if (not parts or any(part in ('', '.', '..') for part in parts)
            or name.startswith('/') or '\\' in name or ':' in name
            or any(ord(char) < 32 for char in name)
            or any(part.endswith((' ', '.')) or re.fullmatch(r'(?i)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part) for part in parts)):
        raise ValueError('An npm/runtime archive contains an unsafe path.')
    return tuple(parts)


def io_path(path):
    """Use Windows namespace paths even when machine long-path policy is off."""
    raw = os.path.abspath(path)
    if os.name == 'nt' and not raw.startswith('\\\\?\\'):
        raw = '\\\\?\\UNC\\' + raw[2:] if raw.startswith('\\\\') else '\\\\?\\' + raw
    return Path(raw)


def ordinary_path(path):
    path = io_path(path)
    if io_path(path.resolve()) != path or path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
        raise ValueError('A bootstrap path cannot contain links or aliases.')
    return path


def npm_security_profile(lock):
    if not isinstance(lock, dict) or any(key not in lock for key in (
            'bootstrapNpm', 'bundledDependencyOverlays', 'npmSecurityOverlays')):
        raise ValueError('The npm security profile inputs are incomplete.')
    selected = {key: lock[key] for key in ('bootstrapNpm', 'bundledDependencyOverlays', 'npmSecurityOverlays')}
    return hashlib.sha256(json.dumps(selected, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=True).encode('utf-8')).hexdigest()


def validate_lock(lock):
    if lock.get('bootstrapNpm') != BOOTSTRAP_NPM or lock.get('dependencyOverrides', {}).get('npm') != BOOTSTRAP_NPM['version']:
        raise ValueError('The bootstrap npm commitment differs from its reviewed archive.')
    if lock.get('npmSecurityProfile') != npm_security_profile(lock):
        raise ValueError('The npm security profile commitment changed.')
    if not isinstance(lock.get('npmSecurityOverlays'), list) or len(lock['npmSecurityOverlays']) != 1:
        raise ValueError('The npm security backport commitment is missing or duplicated.')


def node_pin(lock, platform):
    if platform == 'windowsX64':
        pin = lock['windowsX64']['node']
    elif platform in ('darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'):
        pin = lock['posix'][platform]['node']
    else:
        raise ValueError('An unsupported bootstrap runtime platform was requested.')
    if (not re.fullmatch(r'\d+\.\d+\.\d+', pin.get('version', ''))
            or not re.fullmatch(r'[a-f0-9]{64}', pin.get('sha256', ''))):
        raise ValueError('The reviewed Node pin is invalid.')
    return pin


def expected_node_home(root, lock, platform):
    pin = node_pin(lock, platform)
    architecture = '' if platform == 'windowsX64' else platform + '-'
    return Path(root) / 'runtimes' / ('node-' + pin['version'] + '-' + architecture
        + pin['sha256'][:12] + '-npm-' + lock['npmSecurityProfile'][:12])


def npm_relative(platform):
    return PurePosixPath('node_modules/npm' if platform == 'windowsX64' else 'lib/node_modules/npm')


def verify_npm_archive(data, pin):
    if (pin != BOOTSTRAP_NPM or len(data) > MAX_NPM_ARCHIVE
            or hashlib.sha256(data).hexdigest() != pin['sha256']
            or 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() != pin['integrity']):
        raise ValueError('The bootstrap npm archive failed SHA-256 or SRI verification.')


def fetch_npm_archive(pin, cache):
    if pin != BOOTSTRAP_NPM:
        raise ValueError('The bootstrap npm archive is not the reviewed pin.')
    cache = io_path(Path(cache).resolve())
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    filename = cache / ('npm-' + pin['version'] + '-' + pin['sha256'] + '.tgz')
    if filename.exists() or filename.is_symlink():
        if filename.is_symlink() or not filename.is_file() or filename.stat().st_size > MAX_NPM_ARCHIVE:
            raise ValueError('The bootstrap npm cache entry is invalid.')
        data = filename.read_bytes()
    else:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(urllib.request.Request(pin['source'], headers={
                'User-Agent': 'CypherTempre-ChainChat-Installer'}), timeout=90) as response:
            if response.status != 200 or response.url != pin['source']:
                raise ValueError('The official bootstrap npm archive is unavailable.')
            data = response.read(MAX_NPM_ARCHIVE + 1)
        verify_npm_archive(data, pin)
        with tempfile.NamedTemporaryFile(prefix='.bootstrap-npm-', suffix='.tgz', dir=cache, delete=False) as temporary:
            temporary.write(data)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary.name, filename)
    verify_npm_archive(data, pin)
    return data


def extract_npm(data, destination):
    """Accept only regular reviewed package files, with Windows-safe paths."""
    destination = ordinary_path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError('A bootstrap extraction destination already exists.')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        if len(members) > MAX_NPM_ENTRIES or sum(member.size for member in members) > MAX_NPM_EXPANDED:
            raise ValueError('The bootstrap npm archive exceeds extraction limits.')
        seen = set()
        for member in members:
            parts = safe_parts(member.name)
            if parts[0] != 'package' or not (member.isfile() or member.isdir()) or member.mode & 0o7000:
                raise ValueError('The bootstrap npm archive has an unsupported entry.')
            key = '/'.join(parts).casefold()
            if key in seen:
                raise ValueError('The bootstrap npm archive contains duplicate paths.')
            seen.add(key)
        destination.mkdir(mode=0o700)
        for member in members:
            target = destination.joinpath(*safe_parts(member.name))
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with archive.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
    return destination / 'package'


def package_tree(directory):
    directory = ordinary_path(directory)
    files = {}
    directories = set()
    for filename in directory.rglob('*'):
        if filename.is_symlink() or getattr(filename, 'is_junction', lambda: False)():
            raise ValueError('The secured npm tree cannot contain links.')
        relative = filename.relative_to(directory).as_posix()
        mode = filename.stat().st_mode
        if mode & 0o6000:
            raise ValueError('The secured npm tree cannot contain privileged executables.')
        if filename.is_file():
            if filename.stat().st_nlink != 1:
                raise ValueError('The secured npm tree cannot contain hardlinked files.')
            files[relative] = (digest_file(filename), mode & 0o111 if os.name == 'posix' else 0)
        elif filename.is_dir():
            directories.add(relative)
        else:
            raise ValueError('The secured npm tree has an unsupported entry.')
    return files, directories


def verify_package_tree(actual, expected):
    if package_tree(actual) != package_tree(expected):
        raise ValueError('The installed secured npm tree differs from the reviewed bytes.')


def secured_npm_tree(data, destination, lock, cache):
    package = extract_npm(data, destination)
    identity = json.loads((package / 'package.json').read_text(encoding='utf-8'))
    if identity.get('name') != 'npm' or identity.get('version') != lock['bootstrapNpm']['version']:
        raise ValueError('The bootstrap npm package identity differs from its pin.')
    # Embedded Python's isolated _pth has no script-directory/site search path.
    # Compile payload-verified sibling source directly; never import an adjacent
    # unverified .pyc, sitecustomize module, or package from a user's Python path.
    security = source_module('npm_security')
    archives = source_module('security_overlays')
    security.apply_npm_security(package, lock['npmSecurityOverlays'][0])
    archives.apply_npm_archives(package, lock['bundledDependencyOverlays'], cache)
    security.verify_npm_security(package, lock['npmSecurityOverlays'][0])
    if not (package / 'bin/npm-cli.js').is_file():
        raise ValueError('The reviewed bootstrap npm CLI is missing.')
    return package


def source_module(name):
    if name not in {'npm_security', 'security_overlays'}:
        raise ValueError('An unreviewed installer module was requested.')
    filename = ordinary_path(Path(__file__).parent / (name + '.py'))
    if not filename.is_file() or filename.stat().st_nlink != 1 or filename.stat().st_size > 512 * 1024:
        raise ValueError('A reviewed installer source file changed type or bounds.')
    module = types.ModuleType('chainchat_installer_' + name)
    module.__file__ = str(filename)
    module.__package__ = ''
    exec(compile(filename.read_bytes(), str(filename), 'exec', dont_inherit=True), module.__dict__)
    return module


def prepare_npm_tree(destination, lock, cache):
    """Prepare a fresh CLI for CI/source installs without running any npm."""
    validate_lock(lock)
    destination = ordinary_path(destination)
    parent = ordinary_path(destination.parent)
    if not parent.is_dir() or destination.exists() or destination.is_symlink():
        raise ValueError('The secured npm destination must be a new owned path.')
    data = fetch_npm_archive(lock['bootstrapNpm'], cache)
    with tempfile.TemporaryDirectory(prefix='.secured-npm-', dir=parent) as temporary:
        expected = secured_npm_tree(data, Path(temporary) / 'npm', lock, cache)
        files, directories = package_tree(expected)
        tree_hash = hashlib.sha256(json.dumps(files, sort_keys=True,
            separators=(',', ':')).encode('utf-8')).hexdigest()
        os.replace(expected, destination)
        if package_tree(destination) != (files, directories):
            raise ValueError('The new secured npm tree changed during publication.')
    return {'npmCli': str(destination / 'bin/npm-cli.js'),
        'npmVersion': lock['bootstrapNpm']['version'],
        'npmSecurityProfile': lock['npmSecurityProfile'], 'npmTreeSha256': tree_hash}


def verify_node_archive(archive_file, node_home, pin, platform):
    """Check original Node bytes/links, excluding only the replaced npm tree."""
    # Cache locations can use a system alias such as macOS /var. Only archive
    # bytes are read there; the writable installed runtime must be canonical.
    archive_file, node_home = io_path(Path(archive_file).resolve(strict=True)), ordinary_path(node_home)
    if not archive_file.is_file() or archive_file.stat().st_size > MAX_NODE_ARCHIVE or digest_file(archive_file) != pin['sha256']:
        raise ValueError('The original Node archive failed verification.')
    prefix = tuple(safe_parts(pin['prefix']))
    excluded = npm_relative(platform).parts
    expected_paths, seen, total = set(), set(), 0

    def checked(name, size):
        nonlocal total
        parts = safe_parts(name)
        if parts[:len(prefix)] != prefix:
            raise ValueError('A Node archive path is outside its reviewed prefix.')
        relative = parts[len(prefix):]
        key = '/'.join(relative).casefold()
        if key in seen:
            raise ValueError('The Node archive contains duplicate paths.')
        seen.add(key)
        total += size
        if len(seen) > 200000 or total > MAX_NODE_EXPANDED:
            raise ValueError('The Node archive exceeds verification limits.')
        for count in range(1, len(relative) + 1):
            partial = relative[:count]
            if partial[:len(excluded)] != excluded:
                expected_paths.add('/'.join(partial))
        return None if not relative or relative[:len(excluded)] == excluded else node_home.joinpath(*relative)

    def compare_file(target, source):
        if target.is_symlink() or not target.is_file() or not io_path(target.resolve()).is_relative_to(node_home):
            raise ValueError('An installed Node file has changed type or location.')
        if target.stat().st_nlink != 1:
            raise ValueError('The reviewed Node file cannot be hardlinked outside its attested entry.')
        expected = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            expected.update(chunk)
        if digest_file(target) != expected.hexdigest() or target.stat().st_mode & 0o6000:
            raise ValueError('An installed Node file differs from the reviewed archive.')

    if platform == 'windowsX64':
        with zipfile.ZipFile(archive_file) as archive:
            for member in archive.infolist():
                target = checked(member.orig_filename, member.file_size)
                if member.external_attr >> 16 & 0o170000 == 0o120000:
                    raise ValueError('The Windows Node archive cannot contain links.')
                if target is None:
                    continue
                if member.is_dir():
                    if target.is_symlink() or not target.is_dir():
                        raise ValueError('An installed Node directory changed type.')
                else:
                    with archive.open(member) as source:
                        compare_file(target, source)
    else:
        with tarfile.open(archive_file, 'r:gz') as archive:
            for member in archive.getmembers():
                target = checked(member.name, member.size)
                if not (member.isfile() or member.isdir() or member.issym() or member.islnk()) or member.mode & 0o7000:
                    raise ValueError('The Node archive contains an unsupported entry.')
                if target is None:
                    continue
                if member.issym():
                    if not target.is_symlink() or os.readlink(target) != member.linkname or not io_path(target.resolve()).is_relative_to(node_home):
                        raise ValueError('An installed Node link differs from the reviewed archive.')
                elif member.isdir():
                    if target.is_symlink() or not target.is_dir():
                        raise ValueError('An installed Node directory changed type.')
                else:
                    if member.islnk():
                        link_parts = safe_parts(member.linkname)
                        if link_parts[:len(prefix)] != prefix:
                            raise ValueError('A Node hardlink escaped its runtime.')
                    with archive.extractfile(member) as source:
                        compare_file(target, source)
    actual_paths = {filename.relative_to(node_home).as_posix() for filename in node_home.rglob('*')
        if filename.relative_to(node_home).parts[:len(excluded)] != excluded}
    if actual_paths != expected_paths:
        raise ValueError('The installed Node runtime contains unexpected or missing paths.')


def prepare_or_verify(application, install_root, node_home, archive_file, platform, cache, prepare=False):
    application, root, node_home = ordinary_path(application), ordinary_path(install_root), ordinary_path(node_home)
    lock = json.loads((application / 'openclaw/upstream-lock.json').read_text(encoding='utf-8'))
    validate_lock(lock)
    final = expected_node_home(root, lock, platform)
    staging = re.fullmatch(re.escape(str(final)) + r'\.stage-[a-f0-9]{32}', str(node_home)) is not None
    if node_home != final and not staging or prepare and not staging:
        raise ValueError('Only a new exact secured Node staging directory may be prepared.')
    if not node_home.is_dir() or node_home.parent != root / 'runtimes':
        raise ValueError('The owned Node staging directory is unavailable.')
    target = node_home.joinpath(*npm_relative(platform).parts)
    if prepare and (target.exists() or target.is_symlink()):
        raise ValueError('The old npm tree must be omitted from the new Node staging directory.')
    data = fetch_npm_archive(lock['bootstrapNpm'], cache)
    with tempfile.TemporaryDirectory(prefix='.secured-npm-', dir=root / 'runtimes') as temporary:
        expected = secured_npm_tree(data, Path(temporary) / 'npm', lock, cache)
        if prepare:
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            ordinary_path(target.parent)
            os.replace(expected, target)
            # Rebuild to attest the published tree against independently
            # reconstructed expected bytes rather than a writable receipt.
            expected = secured_npm_tree(data, Path(temporary) / 'verify', lock, cache)
        verify_package_tree(target, expected)
        tree_hash = hashlib.sha256(json.dumps(package_tree(expected)[0], sort_keys=True,
            separators=(',', ':')).encode('utf-8')).hexdigest()
    verify_node_archive(archive_file, node_home, node_pin(lock, platform), platform)
    return {'npmCli': str(target / 'bin/npm-cli.js'), 'npmVersion': lock['bootstrapNpm']['version'],
        'npmSecurityProfile': lock['npmSecurityProfile'], 'npmTreeSha256': tree_hash,
        'nodeArchiveVerified': True, 'existingRuntimeModified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--application', type=Path, required=True)
    common.add_argument('--cache', type=Path, required=True)
    standalone = commands.add_parser('prepare-npm', parents=[common])
    standalone.add_argument('--destination', type=Path, required=True)
    for action in ('prepare', 'verify'):
        command = commands.add_parser(action, parents=[common])
        command.add_argument('--install-root', type=Path, required=True)
        command.add_argument('--node-home', type=Path, required=True)
        command.add_argument('--archive', type=Path, required=True)
        command.add_argument('--platform', required=True)
    args = parser.parse_args()
    if args.action == 'prepare-npm':
        lock = json.loads((args.application / 'openclaw/upstream-lock.json').read_text(encoding='utf-8'))
        result = prepare_npm_tree(args.destination, lock, args.cache)
    else:
        result = prepare_or_verify(args.application, args.install_root, args.node_home,
            args.archive, args.platform, args.cache, prepare=args.action == 'prepare')
    print(json.dumps(result))
