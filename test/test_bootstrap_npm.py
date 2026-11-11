"""Bootstrap archives must be secured before any npm CLI becomes executable."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import py_compile
import stat
import tarfile
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('chainchat_bootstrap_npm', ROOT / 'installer/bootstrap_npm.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
posix_spec = importlib.util.spec_from_file_location('chainchat_bootstrap_posix', ROOT / 'installer/posix_install.py')
posix_installer = importlib.util.module_from_spec(posix_spec)
posix_spec.loader.exec_module(posix_installer)


def package_archive(entries=None):
    entries = entries or [('package/package.json', json.dumps({'name': 'npm', 'version': '12.2.2'}).encode(), tarfile.REGTYPE, ''),
        ('package/bin/npm-cli.js', b'original-cli', tarfile.REGTYPE, ''),
        ('package/README.md', b'license and documentation', tarfile.REGTYPE, '')]
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as packed:
        for name, content, kind, link in entries:
            info = tarfile.TarInfo(name)
            info.type, info.linkname, info.size = kind, link, len(content) if kind == tarfile.REGTYPE else 0
            info.mode = 0o755 if name.endswith('npm-cli.js') else 0o644
            packed.addfile(info, io.BytesIO(content) if kind == tarfile.REGTYPE else None)
    return output.getvalue()


def fixture_lock():
    lock = {'bootstrapNpm': copy.deepcopy(bootstrap.BOOTSTRAP_NPM),
        'dependencyOverrides': {'npm': bootstrap.BOOTSTRAP_NPM['version']},
        'bundledDependencyOverlays': [], 'npmSecurityOverlays': [{'id': 'fixture-backport'}],
        'windowsX64': {'node': {'version': '26.13.1', 'sha256': 'f' * 64, 'prefix': 'node-fixture/'}}}
    lock['npmSecurityProfile'] = bootstrap.npm_security_profile(lock)
    return lock


class BootstrapNpmTests(unittest.TestCase):
    def test_sibling_loader_reads_source_despite_matching_poisoned_bytecode(self):
        with tempfile.TemporaryDirectory(prefix='ct-npm-source-only-') as temporary:
            root = Path(temporary).resolve()
            source = root / 'npm_security.py'
            source.write_text("SENTINEL = 'evil'\n", encoding='utf-8')
            timestamp = source.stat()
            py_compile.compile(str(source), doraise=True)
            source.write_text("SENTINEL = 'safe'\n", encoding='utf-8')
            os.utime(source, ns=(timestamp.st_atime_ns, timestamp.st_mtime_ns))
            self.assertTrue(Path(importlib.util.cache_from_source(str(source))).is_file())
            with mock.patch.object(bootstrap, '__file__', str(root / 'bootstrap_npm.py')):
                module = bootstrap.source_module('npm_security')
                self.assertEqual(module.SENTINEL, 'safe')
                self.assertEqual(Path(module.__file__).name, source.name)
                with self.assertRaisesRegex(ValueError, 'unreviewed'):
                    bootstrap.source_module('sitecustomize')

    def test_cached_python_is_verified_before_use_and_unknown_bytecode_is_not_ignored(self):
        with tempfile.TemporaryDirectory(prefix='ct-python-preflight-') as temporary:
            root = Path(temporary).resolve()
            reference, cached = root / 'fresh-python', root / 'cached-python'
            for directory in (reference, cached):
                (directory / 'bin').mkdir(parents=True)
                (directory / 'bin/python3').write_bytes(b'verified interpreter')
            posix_installer.verify_python_copy(reference, cached)
            (cached / 'bin/python3').write_bytes(b'tampered interpreter')
            with self.assertRaisesRegex(ValueError, 'freshly verified'):
                posix_installer.verify_python_copy(reference, cached)
            (cached / 'bin/python3').write_bytes(b'verified interpreter')
            (cached / 'unexpected.pyc').write_bytes(b'unverified bytecode')
            with self.assertRaisesRegex(ValueError, 'freshly verified'):
                posix_installer.verify_python_copy(reference, cached)

    def test_managed_posix_environment_drops_preloads_credentials_and_unknown_configuration(self):
        inherited = {'PATH': 'system-path', 'NODE_OPTIONS': '--require=unreviewed.js',
            'NODE_PATH': '/unreviewed', 'PYTHONSTARTUP': '/unreviewed.py',
            'PYTHONPATH': '/unreviewed', 'PROVIDER_API_KEY': 'private',
            'OPENCLAW_PROFILE': 'unreviewed', 'CT_UNREVIEWED': 'unreviewed',
            'NPM_CONFIG_IGNORE_SCRIPTS': 'false'}
        active = {'node': '/owned/bin/node', 'python': '/owned/bin/python',
            'data': '/owned/data', 'release': '/owned/release'}
        with mock.patch.dict(os.environ, inherited, clear=True):
            projected = posix_installer.environment(active)
        for name in inherited:
            if name != 'PATH': self.assertNotIn(name, projected)
        self.assertEqual(projected['CT_CHAT_PYTHON'], active['python'])
        self.assertEqual(projected['CT_CHAT_DATA'], active['data'])
        self.assertEqual(projected['PYTHONDONTWRITEBYTECODE'], '1')

    def test_security_profile_covers_archive_and_backports_independently_of_order(self):
        lock = fixture_lock()
        original = bootstrap.npm_security_profile(lock)
        self.assertEqual(original, bootstrap.npm_security_profile(dict(reversed(list(lock.items())))))
        for key in ('bootstrapNpm', 'bundledDependencyOverlays', 'npmSecurityOverlays'):
            changed = copy.deepcopy(lock)
            if key == 'bootstrapNpm': changed[key]['sha256'] = '0' * 64
            else: changed[key].append({'id': 'changed'})
            self.assertNotEqual(original, bootstrap.npm_security_profile(changed))
        bootstrap.validate_lock(lock)
        lock['npmSecurityProfile'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'profile commitment'):
            bootstrap.validate_lock(lock)

    def test_bootstrap_pin_cannot_select_an_unreviewed_archive(self):
        lock = fixture_lock()
        lock['bootstrapNpm']['source'] = 'https://untrusted.invalid/npm.tgz'
        lock['npmSecurityProfile'] = bootstrap.npm_security_profile(lock)
        with self.assertRaisesRegex(ValueError, 'reviewed archive'):
            bootstrap.validate_lock(lock)
        with mock.patch.object(bootstrap.urllib.request, 'build_opener') as network:
            with self.assertRaisesRegex(ValueError, 'reviewed pin'):
                bootstrap.fetch_npm_archive(lock['bootstrapNpm'], Path('unused'))
            network.assert_not_called()

    def test_archive_requires_both_sha256_and_sha512_sri(self):
        data = package_archive()
        pin = {**bootstrap.BOOTSTRAP_NPM, 'sha256': hashlib.sha256(data).hexdigest(),
            'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()}
        with mock.patch.object(bootstrap, 'BOOTSTRAP_NPM', pin):
            bootstrap.verify_npm_archive(data, pin)
            for changed in (data + b'changed', data[:-1]):
                with self.assertRaisesRegex(ValueError, 'SHA-256 or SRI'):
                    bootstrap.verify_npm_archive(changed, pin)
            wrong = {**pin, 'integrity': 'sha512-wrong'}
            with self.assertRaisesRegex(ValueError, 'SHA-256 or SRI'):
                bootstrap.verify_npm_archive(data, wrong)

    def test_archive_refuses_links_traversal_devices_and_case_collisions_before_writing(self):
        bad_entries = [
            [('package/../outside', b'x', tarfile.REGTYPE, '')],
            [('package/link', b'', tarfile.SYMTYPE, '../../outside')],
            [('package/link', b'', tarfile.LNKTYPE, 'package/README.md')],
            [('package/device', b'', tarfile.CHRTYPE, '')],
            [('package/NUL.txt', b'x', tarfile.REGTYPE, '')],
            [('package/A', b'x', tarfile.REGTYPE, ''), ('package/a', b'y', tarfile.REGTYPE, '')],
        ]
        with tempfile.TemporaryDirectory(prefix='ct-npm-extraction-') as temporary:
            root = Path(temporary).resolve()
            for number, entries in enumerate(bad_entries):
                target = root / str(number)
                with self.subTest(entries=entries), self.assertRaises(ValueError):
                    bootstrap.extract_npm(package_archive(entries), target)
                self.assertFalse(target.exists())
            package = bootstrap.extract_npm(package_archive(), root / 'valid')
            self.assertEqual((package / 'bin/npm-cli.js').read_bytes(), b'original-cli')
            self.assertFalse((root / 'outside').exists())
            if os.name == 'posix':
                self.assertEqual(stat.S_IMODE((package / 'bin/npm-cli.js').stat().st_mode), 0o755)

    def test_standalone_cli_publishes_only_after_security_work_and_never_overwrites(self):
        data = package_archive()
        lock = fixture_lock()
        with tempfile.TemporaryDirectory(prefix='ct-npm-publication-') as temporary:
            root = Path(temporary).resolve()
            destination = root / 'secured-npm'
            observed = []

            def secure(archive, target, reviewed, cache):
                self.assertFalse(destination.exists())
                self.assertEqual(reviewed, lock)
                package = bootstrap.extract_npm(archive, target)
                (package / 'bin/npm-cli.js').write_bytes(b'reviewed-and-secured-cli')
                observed.append('secured-before-publication')
                return package

            with (mock.patch.object(bootstrap, 'fetch_npm_archive', return_value=data),
                  mock.patch.object(bootstrap, 'secured_npm_tree', side_effect=secure)):
                result = bootstrap.prepare_npm_tree(destination, lock, root / 'cache')
            self.assertEqual(observed, ['secured-before-publication'])
            self.assertEqual(Path(result['npmCli']).read_bytes(), b'reviewed-and-secured-cli')
            self.assertEqual(result['npmSecurityProfile'], lock['npmSecurityProfile'])
            with mock.patch.object(bootstrap, 'fetch_npm_archive') as network:
                with self.assertRaisesRegex(ValueError, 'new owned path'):
                    bootstrap.prepare_npm_tree(destination, lock, root / 'cache')
                network.assert_not_called()
            self.assertEqual(Path(result['npmCli']).read_bytes(), b'reviewed-and-secured-cli')

    def test_complete_npm_tree_check_detects_ordinary_file_changes_and_extra_files(self):
        with tempfile.TemporaryDirectory(prefix='ct-npm-tree-') as temporary:
            root = Path(temporary).resolve()
            expected = bootstrap.extract_npm(package_archive(), root / 'expected')
            actual = bootstrap.extract_npm(package_archive(), root / 'actual')
            bootstrap.verify_package_tree(actual, expected)
            (actual / 'README.md').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'reviewed bytes'):
                bootstrap.verify_package_tree(actual, expected)
            (actual / 'README.md').write_bytes(b'license and documentation')
            (actual / 'injected.js').write_bytes(b'extra')
            with self.assertRaisesRegex(ValueError, 'reviewed bytes'):
                bootstrap.verify_package_tree(actual, expected)

    def test_npm_tree_refuses_a_matching_executable_hardlinked_outside_its_root(self):
        with tempfile.TemporaryDirectory(prefix='ct-npm-hardlink-') as temporary:
            root = Path(temporary).resolve()
            actual = bootstrap.extract_npm(package_archive(), root / 'actual')
            outside = root / 'mutable-outside.js'
            outside.write_bytes(b'original-cli')
            cli = actual / 'bin/npm-cli.js'
            cli.unlink()
            os.link(outside, cli)
            with self.assertRaisesRegex(ValueError, 'hardlinked'):
                bootstrap.package_tree(actual)
            self.assertEqual(outside.read_bytes(), b'original-cli')

    @unittest.skipUnless(os.name == 'nt', 'Windows namespace-path regression')
    def test_long_windows_destination_does_not_silently_omit_deep_package_files(self):
        deepest = 'node_modules/@npmcli/installed-package-contents/node_modules/npm-normalize-package-bin/lib/index.js'
        data = package_archive([
            ('package/package.json', b'{"name":"npm","version":"12.2.2"}', tarfile.REGTYPE, ''),
            ('package/bin/npm-cli.js', b'cli', tarfile.REGTYPE, ''),
            ('package/' + deepest, b'deep reviewed bytes', tarfile.REGTYPE, '')])
        with tempfile.TemporaryDirectory(prefix='ct-npm-long-path-', dir=bootstrap.io_path(tempfile.gettempdir())) as temporary:
            root = bootstrap.io_path(Path(temporary).resolve())
            parent = root / ('a' * 80) / ('b' * 65)
            parent.mkdir(parents=True)
            destination = parent / ('secured-npm-' + 'c' * 32)
            self.assertGreater(len(str(destination / deepest)), 260)
            with (mock.patch.object(bootstrap, 'fetch_npm_archive', return_value=data),
                  mock.patch.object(bootstrap, 'secured_npm_tree', side_effect=lambda data, target, *_: bootstrap.extract_npm(data, target))):
                bootstrap.prepare_npm_tree(destination, fixture_lock(), root / 'cache')
            files, _ = bootstrap.package_tree(destination)
            self.assertIn(deepest, files)
            self.assertEqual((destination / deepest).read_bytes(), b'deep reviewed bytes')

    def test_node_archive_exclusion_is_exact_and_non_npm_files_remain_attested(self):
        with tempfile.TemporaryDirectory(prefix='ct-secured-node-') as temporary:
            root = Path(temporary).resolve()
            archive = root / 'node.zip'
            with zipfile.ZipFile(archive, 'w') as packed:
                packed.writestr('node-fixture/node.exe', b'original-node')
                packed.writestr('node-fixture/npm.cmd', b'original-wrapper')
                packed.writestr('node-fixture/node_modules/npm/bin/npm-cli.js', b'old-npm-not-extracted')
            pin = {'prefix': 'node-fixture/', 'sha256': bootstrap.digest_file(archive)}
            node = root / 'node'; node.mkdir()
            (node / 'node.exe').write_bytes(b'original-node')
            (node / 'npm.cmd').write_bytes(b'original-wrapper')
            npm = node / 'node_modules/npm/bin'; npm.mkdir(parents=True)
            (npm / 'npm-cli.js').write_bytes(b'new-secured-npm')
            bootstrap.verify_node_archive(archive, node, pin, 'windowsX64')
            (node / 'node.exe').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'reviewed archive'):
                bootstrap.verify_node_archive(archive, node, pin, 'windowsX64')
            (node / 'node.exe').write_bytes(b'original-node')
            (node / 'node_modules/other.js').write_bytes(b'injected')
            with self.assertRaisesRegex(ValueError, 'unexpected or missing'):
                bootstrap.verify_node_archive(archive, node, pin, 'windowsX64')

    def test_node_archive_refuses_matching_binary_hardlinked_to_an_external_file(self):
        with tempfile.TemporaryDirectory(prefix='ct-node-hardlink-') as temporary:
            root = Path(temporary).resolve()
            archive = root / 'node.zip'
            with zipfile.ZipFile(archive, 'w') as packed:
                packed.writestr('node-fixture/node.exe', b'original-node')
            node = root / 'node'; node.mkdir()
            external = root / 'mutable-node.exe'; external.write_bytes(b'original-node')
            os.link(external, node / 'node.exe')
            with self.assertRaisesRegex(ValueError, 'hardlinked'):
                bootstrap.verify_node_archive(archive, node, {
                    'prefix': 'node-fixture/', 'sha256': bootstrap.digest_file(archive)}, 'windowsX64')

    def test_prepare_rejects_existing_runtime_before_network_or_mutation(self):
        with tempfile.TemporaryDirectory(prefix='ct-npm-existing-') as temporary:
            root = Path(temporary).resolve()
            app = root / 'application'; (app / 'openclaw').mkdir(parents=True)
            lock = fixture_lock()
            (app / 'openclaw/upstream-lock.json').write_text(json.dumps(lock), encoding='utf-8')
            node = bootstrap.expected_node_home(root, lock, 'windowsX64')
            node.mkdir(parents=True)
            preserved = node / 'sentinel'; preserved.write_bytes(b'existing runtime')
            with mock.patch.object(bootstrap, 'fetch_npm_archive') as network:
                with self.assertRaisesRegex(ValueError, 'new exact secured Node staging'):
                    bootstrap.prepare_or_verify(app, root, node, root / 'unused.zip', 'windowsX64', root / 'cache', prepare=True)
                network.assert_not_called()
            self.assertEqual(preserved.read_bytes(), b'existing runtime')


if __name__ == '__main__':
    unittest.main()
