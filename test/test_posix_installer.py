import importlib.util
import base64
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'installer'))
import posix_install as installer
import build_posix


class PortableInstallerGuards(unittest.TestCase):
    def active_fixture(self, root, name, missing=None):
        release, runtime = root / 'releases' / name, root / 'runtimes' / name
        if missing != 'release':
            (release / 'openclaw').mkdir(parents=True)
            if missing != 'launcher':
                (release / 'openclaw/launcher.mjs').write_text('// fixture only\n', encoding='utf-8')
        runtime.mkdir(parents=True)
        for executable in ('node', 'python'):
            if missing != executable:
                (runtime / executable).write_text('not executed', encoding='utf-8')
        (root / 'data').mkdir(exist_ok=True)
        return {'product': 'cypher-tempre-chainchat', 'version': {'new': '1.1.2', 'old': '1.1.1', 'rollback': '1.1.0'}[name], 'payloadSha256': 'a' * 64,
                'release': str(release), 'node': str(runtime / 'node'),
                'python': str(runtime / 'python'), 'data': str(root / 'data')}

    def test_owned_incomplete_previous_release_can_be_repaired_without_changing_data_or_rollback(self):
        for missing in ('release', 'launcher', 'node', 'python'):
            for no_launch in (False, True):
                with self.subTest(missing=missing, no_launch=no_launch), tempfile.TemporaryDirectory(prefix='ct-posix-repair-') as temporary:
                    root = Path(temporary).resolve()
                    active = self.active_fixture(root, 'new')
                    old = self.active_fixture(root, 'old', missing)
                    rollback = self.active_fixture(root, 'rollback')
                    current_raw = (json.dumps(old, indent=3) + '\n').encode()
                    rollback_raw = (json.dumps(rollback, indent=2) + '\n').encode()
                    (root / 'current.json').write_bytes(current_raw)
                    (root / 'previous.json').write_bytes(rollback_raw)
                    history = root / 'data/history'; history.write_bytes(b'existing chain bytes\n')
                    with self.assertRaises(installer.IncompleteReleaseError):
                        installer.check_active(root, old)
                    with mock.patch.object(installer, 'run_checked') as stop, contextlib.redirect_stderr(io.StringIO()) as notice:
                        installer.promote_release(root, active, no_launch)
                    self.assertEqual(json.loads((root / 'current.json').read_text(encoding='utf-8')), active)
                    self.assertEqual((root / 'previous.json').read_bytes(), rollback_raw)
                    self.assertEqual(history.read_bytes(), b'existing chain bytes\n')
                    records = list((root / 'install-recovery').glob('current-*.json'))
                    self.assertEqual(len(records), 1); self.assertEqual(records[0].read_bytes(), current_raw)
                    self.assertIn('previous application files are incomplete', notice.getvalue())
                    if no_launch:
                        stop.assert_not_called()
                    else:
                        stop.assert_called_once_with([active['node'], Path(active['release']) / 'openclaw/launcher.mjs', '--stop'],
                                                     active, root / 'install.log', 60)

    def test_healthy_previous_release_remains_rollback_and_only_verified_new_launcher_can_stop(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-update-') as temporary:
            root = Path(temporary).resolve()
            active, old = self.active_fixture(root, 'new'), self.active_fixture(root, 'old')
            (root / 'current.json').write_text(json.dumps(old), encoding='utf-8')
            with mock.patch.object(installer, 'run_checked') as stop:
                installer.promote_release(root, active, False)
            self.assertEqual(json.loads((root / 'previous.json').read_text(encoding='utf-8')), old)
            self.assertEqual(stop.call_args.args[0][0], active['node'])
            self.assertFalse((root / 'install-recovery').exists())

    def test_idempotent_reinstall_retains_healthy_prior_rollback(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-same-release-') as temporary:
            root = Path(temporary).resolve()
            active, rollback = self.active_fixture(root, 'new'), self.active_fixture(root, 'rollback')
            (root / 'current.json').write_text(json.dumps(active), encoding='utf-8')
            raw = (json.dumps(rollback, indent=3) + '\n').encode(); (root / 'previous.json').write_bytes(raw)
            with mock.patch.object(installer, 'run_checked') as stop:
                installer.promote_release(root, active, True)
            stop.assert_not_called(); self.assertEqual((root / 'previous.json').read_bytes(), raw)

    def test_missing_rollback_is_archived_and_never_offered_as_a_working_release(self):
        for healthy_current in (False, True):
            with self.subTest(healthy_current=healthy_current), tempfile.TemporaryDirectory(prefix='ct-posix-retired-rollback-') as temporary:
                root = Path(temporary).resolve()
                active = self.active_fixture(root, 'new')
                old = self.active_fixture(root, 'old', None if healthy_current else 'node')
                rollback = self.active_fixture(root, 'rollback', 'launcher')
                current_raw = json.dumps(old, indent=2).encode(); rollback_raw = json.dumps(rollback, indent=3).encode()
                (root / 'current.json').write_bytes(current_raw); (root / 'previous.json').write_bytes(rollback_raw)
                with mock.patch.object(installer, 'run_checked') as stop, contextlib.redirect_stderr(io.StringIO()):
                    installer.promote_release(root, active, True)
                stop.assert_not_called(); self.assertEqual(json.loads((root / 'current.json').read_text(encoding='utf-8')), active)
                archived = list((root / 'install-recovery').glob('previous-*.json'))
                self.assertEqual(len(archived), 1); self.assertEqual(archived[0].read_bytes(), rollback_raw)
                if healthy_current:
                    self.assertEqual(json.loads((root / 'previous.json').read_text(encoding='utf-8')), old)
                else:
                    self.assertFalse((root / 'previous.json').exists())
                    with self.assertRaisesRegex(ValueError, 'No complete previous release'):
                        installer.rollback(root, quiet=True, no_launch=True)

    def test_owner_pointer_changes_during_stop_hold_promotion_without_overwriting_their_edits(self):
        for name in ('current.json', 'previous.json'):
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix='ct-posix-pointer-race-') as temporary:
                root = Path(temporary).resolve()
                active = self.active_fixture(root, 'new')
                old, rollback = self.active_fixture(root, 'old', 'node'), self.active_fixture(root, 'rollback')
                before = {'current.json': json.dumps(old).encode(), 'previous.json': json.dumps(rollback).encode()}
                for filename, raw in before.items(): (root / filename).write_bytes(raw)
                changed = (json.dumps(active, indent=4) + '\n').encode()
                def owner_edit(*_): (root / name).write_bytes(changed)
                with mock.patch.object(installer, 'run_checked', side_effect=owner_edit), self.assertRaisesRegex(RuntimeError, 'selection changed'):
                    installer.promote_release(root, active, False)
                for filename, raw in before.items():
                    self.assertEqual((root / filename).read_bytes(), changed if filename == name else raw)
                self.assertFalse((root / 'install-recovery').exists())

    def test_failed_authenticated_stop_does_not_promote_or_archive_pointers(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-stop-held-') as temporary:
            root = Path(temporary).resolve()
            active, old = self.active_fixture(root, 'new'), self.active_fixture(root, 'old', 'node')
            raw = json.dumps(old).encode(); (root / 'current.json').write_bytes(raw)
            with mock.patch.object(installer, 'run_checked', side_effect=RuntimeError('Authentication held.')), self.assertRaisesRegex(RuntimeError, 'Authentication held'):
                installer.promote_release(root, active, False)
            self.assertEqual((root / 'current.json').read_bytes(), raw)
            self.assertFalse((root / 'previous.json').exists()); self.assertFalse((root / 'install-recovery').exists())

    def test_files_are_rechecked_after_stop_before_candidate_or_rollback_promotion(self):
        for changed in ('candidate', 'current', 'rollback'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory(prefix='ct-posix-file-race-') as temporary:
                root = Path(temporary).resolve()
                active, old, rollback = (self.active_fixture(root, name) for name in ('new', 'old', 'rollback'))
                current_raw, rollback_raw = json.dumps(old).encode(), json.dumps(rollback).encode()
                (root / 'current.json').write_bytes(current_raw); (root / 'previous.json').write_bytes(rollback_raw)
                chosen = active if changed == 'candidate' else old if changed == 'current' else rollback
                def missing_after_stop(*_): Path(chosen['python']).unlink()
                with mock.patch.object(installer, 'run_checked', side_effect=missing_after_stop), contextlib.redirect_stderr(io.StringIO()):
                    if changed == 'candidate':
                        with self.assertRaises(installer.IncompleteReleaseError): installer.promote_release(root, active, False)
                    else:
                        installer.promote_release(root, active, False)
                if changed == 'candidate':
                    self.assertEqual((root / 'current.json').read_bytes(), current_raw)
                    self.assertEqual((root / 'previous.json').read_bytes(), rollback_raw)
                    self.assertFalse((root / 'install-recovery').exists())
                elif changed == 'current':
                    self.assertEqual((root / 'previous.json').read_bytes(), rollback_raw)
                    self.assertEqual(len(list((root / 'install-recovery').glob('current-*.json'))), 1)
                else:
                    self.assertEqual(json.loads((root / 'previous.json').read_text(encoding='utf-8')), old)
                    self.assertEqual(len(list((root / 'install-recovery').glob('previous-*.json'))), 1)

    def test_malformed_or_unowned_pointers_never_enter_missing_file_recovery(self):
        for pointer in ('current.json', 'previous.json'):
            for malformed in ('json', 'null', 'product', 'version', 'hash', 'missing-hash', 'outside-node', 'wrong-data', 'wrong-release'):
                with self.subTest(pointer=pointer, malformed=malformed), tempfile.TemporaryDirectory(prefix='ct-posix-repair-guard-') as temporary:
                    root = Path(temporary).resolve()
                    active = self.active_fixture(root, 'new')
                    old = self.active_fixture(root, 'old', 'node')
                    (root / 'current.json').write_text(json.dumps(old), encoding='utf-8')
                    bad = dict(old)
                    if malformed == 'product': bad['product'] = 'another-app'
                    if malformed == 'version': bad['version'] = 'not-a-version'
                    if malformed == 'hash': bad['payloadSha256'] = 'invalid'
                    if malformed == 'missing-hash': bad.pop('payloadSha256')
                    if malformed == 'outside-node': bad['node'] = str(root.parent / 'outside-node')
                    if malformed == 'wrong-data': bad['data'] = str(root / 'another-data')
                    if malformed == 'wrong-release': bad['release'] = str(root / 'another-release')
                    raw = b'{' if malformed == 'json' else b'null' if malformed == 'null' else json.dumps(bad).encode()
                    (root / pointer).write_bytes(raw)
                    before = {p.name: p.read_bytes() for p in (root / 'current.json', root / 'previous.json') if p.exists()}
                    with mock.patch.object(installer, 'run_checked') as stop, self.assertRaises(ValueError):
                        installer.promote_release(root, active, False)
                    stop.assert_not_called(); self.assertFalse((root / 'install-recovery').exists())
                    self.assertEqual({name: (root / name).read_bytes() for name in before}, before)

    def test_access_failures_and_wrong_file_types_are_not_treated_as_missing_old_files(self):
        for kind in ('permission', 'directory'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix='ct-posix-file-kind-') as temporary:
                root = Path(temporary).resolve()
                active, old = self.active_fixture(root, 'new'), self.active_fixture(root, 'old', 'node')
                node = Path(old['node'])
                if kind == 'directory': node.mkdir()
                (root / 'current.json').write_text(json.dumps(old), encoding='utf-8')
                original = Path.stat
                def inspect(filename, *args, **kwargs):
                    if kind == 'permission' and filename == node:
                        raise PermissionError('Fixture access refused.')
                    return original(filename, *args, **kwargs)
                expected = PermissionError if kind == 'permission' else ValueError
                with mock.patch.object(Path, 'stat', inspect), mock.patch.object(installer, 'run_checked') as stop, self.assertRaises(expected):
                    installer.promote_release(root, active, False)
                stop.assert_not_called(); self.assertFalse((root / 'install-recovery').exists())

    def test_repair_does_not_stop_or_prepare_rollback_when_new_candidate_is_incomplete(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-bad-candidate-') as temporary:
            root = Path(temporary).resolve()
            active, old = self.active_fixture(root, 'new', 'launcher'), self.active_fixture(root, 'old', 'node')
            raw = json.dumps(old).encode(); (root / 'current.json').write_bytes(raw)
            with mock.patch.object(installer, 'run_checked') as stop, self.assertRaises(installer.IncompleteReleaseError):
                installer.promote_release(root, active, False)
            stop.assert_not_called(); self.assertEqual((root / 'current.json').read_bytes(), raw)
            self.assertFalse((root / 'previous.json').exists()); self.assertFalse((root / 'install-recovery').exists())

    @unittest.skipUnless(os.name == 'posix', 'POSIX symbolic-link guard')
    def test_repair_refuses_symlinked_pointers_recovery_and_release_directories(self):
        for kind in ('current', 'previous', 'recovery', 'release'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix='ct-posix-repair-link-') as temporary:
                root = Path(temporary).resolve()
                active, old = self.active_fixture(root, 'new'), self.active_fixture(root, 'old', 'node')
                raw = json.dumps(old).encode()
                (root / 'current.json').write_bytes(raw)
                if kind in ('current', 'previous'):
                    target = root / 'pointer-record.json'; target.write_bytes(raw)
                    selected = root / ('current.json' if kind == 'current' else 'previous.json')
                    if selected.exists(): selected.unlink()
                    selected.symlink_to(target)
                elif kind == 'recovery':
                    target = root / 'recovery-target'; target.mkdir()
                    (root / 'install-recovery').symlink_to(target, target_is_directory=True)
                else:
                    target = Path(old['release']); target.rename(root / 'old-release-target')
                    target.symlink_to(root / 'old-release-target', target_is_directory=True)
                with mock.patch.object(installer, 'run_checked') as stop, self.assertRaises(ValueError):
                    installer.promote_release(root, active, False)
                stop.assert_not_called()

    @unittest.skipIf(os.name == 'nt', 'POSIX portable-Python startup acceptance runs in native CI.')
    def test_managed_python_environment_blocks_user_site_startup_code(self):
        with tempfile.TemporaryDirectory(prefix='ct-user-site-') as directory:
            base = Path(directory)
            env = {**os.environ, 'PYTHONUSERBASE': str(base / 'user-base')}
            env.pop('PYTHONNOUSERSITE', None)
            env.pop('PYTHONPATH', None)
            site = Path(subprocess.check_output([sys.executable, '-S', '-c',
                'import site; print(site.getusersitepackages())'], env=env, text=True).strip())
            self.assertTrue(site.is_relative_to(base))
            site.mkdir(parents=True)
            (site / 'usercustomize.py').write_text("print('UNREVIEWED_USER_SITE')\n", encoding='utf-8')
            command = [sys.executable, '-c', "print('MAIN_SCRIPT')"]
            negative = subprocess.check_output(command, env=env, text=True)
            self.assertIn('UNREVIEWED_USER_SITE', negative)
            active = {'release': str(base), 'data': str(base / 'data'),
                      'python': sys.executable, 'node': str(base / 'node')}
            with mock.patch.dict(os.environ, env, clear=True):
                safe = installer.environment(active)
            self.assertEqual(safe['PYTHONNOUSERSITE'], '1')
            safe['PYTHONUSERBASE'] = env['PYTHONUSERBASE']
            positive = subprocess.check_output(command, env=safe, text=True)
            self.assertNotIn('UNREVIEWED_USER_SITE', positive)
            self.assertIn('MAIN_SCRIPT', positive)

    def test_guided_progress_does_not_claim_chat_readiness_or_pollute_json_output(self):
        args = mock.Mock(quiet=False, no_launch=False)
        progress, result = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(progress), contextlib.redirect_stdout(result):
            installer.setup_stage(args, 4, 'Check the local runtime')
            installer.setup_handoff(args)
        self.assertEqual(result.getvalue(), '')
        self.assertIn('Step 4/6: Check the local runtime', progress.getvalue())
        self.assertIn('Your local runtime is ready.', progress.getvalue())
        self.assertIn('Chat is ready when that guide confirms it.', progress.getvalue())
        self.assertIn('select an existing one', progress.getvalue())
        self.assertIn('Proof of Interaction', progress.getvalue())
        self.assertNotIn('Your chat is ready', progress.getvalue())

    def test_quiet_and_no_launch_handoffs_preserve_their_distinct_meanings(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            installer.setup_stage(mock.Mock(quiet=True), 3, 'Do not print')
            installer.setup_handoff(mock.Mock(quiet=True, no_launch=False))
        self.assertEqual(output.getvalue(), '')
        with contextlib.redirect_stderr(output):
            installer.setup_handoff(mock.Mock(quiet=False, no_launch=True))
        self.assertIn('runtime was not started', output.getvalue())
        self.assertNotIn('Your local runtime is ready', output.getvalue())

    def source_fixture(self, filename, mutate=None):
        pins = json.loads((ROOT / 'openclaw/upstream-lock.json').read_text(encoding='utf-8'))
        if mutate: mutate(pins)
        runtime = {'dependencies': {'openclaw': pins['openclaw']['version']}, 'overrides': pins['dependencyOverrides']}
        locked = {'packages': {'node_modules/openclaw': {'version': pins['openclaw']['version'],
            'integrity': pins['openclaw']['integrity'], 'resolved': pins['openclaw']['source']},
            **{'node_modules/' + name: {'version': version} for name, version in pins['dependencyOverrides'].items()}}}
        files = {'package.json': json.dumps({'name': 'cypher-tempre-chat', 'version': '0.8.0'}).encode(),
            'server.mjs': b'// reviewed fixture\n', 'engine_bridge.py': b'# fixture\n', 'openclaw/launcher.mjs': b'// fixture\n',
            'openclaw/upstream-lock.json': json.dumps(pins).encode(), 'openclaw/runtime/package.json': json.dumps(runtime).encode(),
            'openclaw/runtime/package-lock.json': json.dumps(locked).encode(), 'installer/windows-installer.cs': b'// fixture\n',
            'installer/windows.manifest': b'<fixture/>', 'public/fonts/orbitron/Orbitron-Variable.ttf': b'fixture',
            'installer/posix_install.py': b'# only the reviewed archive copy\n',
            'installer/security_overlays.py': b'# reviewed security fixture\n',
            **{name: b'# reviewed security fixture\n' for name in ('installer/bootstrap_npm.py', 'installer/npm_security.py', 'installer/zod_security_overlay.py')},
            **{name: b'// reviewed security fixture\n' for name in ('openclaw/runtime-security.mjs', 'openclaw/npm-security.mjs', 'openclaw/zod-security.mjs')},
            'installer/runtime_compatibility.py': b'# reviewed compatibility fixture\n', 'openclaw/runtime-compatibility.mjs': b'// reviewed compatibility fixture\n',
            'installer/posix_bootstrap.sh': (ROOT / 'installer/posix_bootstrap.sh').read_bytes().replace(
                b'# Generated setup', b'# REVIEWED_ARCHIVE_MARKER\n# Generated setup')}
        with zipfile.ZipFile(filename, 'w') as archive:
            for name, content in files.items(): archive.writestr('app/' + name, content)

    def test_built_installers_preserve_reviewed_payload_and_executable_modes(self):
        with tempfile.TemporaryDirectory(prefix='ct-portable-build-') as temporary:
            base = Path(temporary); source = base / 'source.zip'; self.source_fixture(source)
            mac = build_posix.build(source, base / 'built', 'darwin')[0]
            linux = build_posix.build(source, base / 'built', 'linux')
            with zipfile.ZipFile(base / 'built' / mac['installer']) as archive:
                entry = archive.getinfo('Install ChainChat.command')
                self.assertEqual(entry.external_attr >> 16 & 0o777, 0o755)
                self.assertIn(b'REVIEWED_ARCHIVE_MARKER', archive.read(entry))
            direct = base / 'built' / linux[1]['installer']
            encoded = direct.read_bytes().split(b'\n__CHAINCHAT_PAYLOAD__\n', 1)[1]
            with tarfile.open(fileobj=io.BytesIO(base64.b64decode(encoded)), mode='r:gz') as archive:
                manifest = json.load(archive.extractfile('manifest.json'))
                self.assertEqual(archive.extractfile('payload.zip').read(), source.read_bytes())
                self.assertEqual(manifest['payloadSha256'], hashlib.sha256(source.read_bytes()).hexdigest())
                self.assertEqual(set(manifest['runtimes']), {'linux-x64', 'linux-arm64'})
            self.assertEqual(json.loads(direct.with_name(direct.name + '.json').read_text())['sha256'], hashlib.sha256(direct.read_bytes()).hexdigest())
            with self.assertRaises(ValueError): build_posix.build(source, base / 'built', 'linux')

    def test_builder_rejects_unreviewed_runtime_sources(self):
        with tempfile.TemporaryDirectory(prefix='ct-portable-bad-pin-') as temporary:
            base = Path(temporary); source = base / 'source.zip'
            self.source_fixture(source, lambda pins: pins['posix']['linux-x64']['python'].update(url='https://untrusted.example/python.tar.gz'))
            with self.assertRaises(ValueError): build_posix.build(source, base / 'built', 'linux')

    def test_source_rejects_traversal_symlinks_and_case_collisions(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-guards-') as temporary:
            base = Path(temporary)
            for number, entries in enumerate((
                [('app/../escape', b'x', 0o100644)],
                [('app/link', b'../escape', 0o120777)],
                [('app/A', b'x', 0o100644), ('app/a', b'y', 0o100644)],
                [('app/.env', b'private', 0o100644)],
            )):
                packed = base / (str(number) + '.zip')
                with zipfile.ZipFile(packed, 'w') as archive:
                    for name, content, mode in entries:
                        info = zipfile.ZipInfo(name); info.external_attr = mode << 16
                        archive.writestr(info, content)
                output = base / ('out-' + str(number)); output.mkdir()
                with self.assertRaises(ValueError): installer.extract_source(packed, output, 'app/')
            self.assertFalse((base / 'escape').exists())

    def test_runtime_rejects_external_links_and_special_files(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-runtime-') as temporary:
            base = Path(temporary)
            for number, (kind, target) in enumerate(((tarfile.SYMTYPE, '../../escape'), (tarfile.CHRTYPE, ''))):
                packed = base / (str(number) + '.tar.gz')
                with tarfile.open(packed, 'w:gz') as archive:
                    info = tarfile.TarInfo('runtime/link'); info.type, info.linkname = kind, target
                    archive.addfile(info)
                with self.assertRaises(ValueError): installer.extract_runtime(packed, base / ('out-' + str(number)))

    def test_source_integrity_detects_a_modified_immutable_release(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-integrity-') as temporary:
            base = Path(temporary); packed = base / 'source.zip'
            with zipfile.ZipFile(packed, 'w') as archive:
                info = zipfile.ZipInfo('app/server.mjs'); info.external_attr = 0o100755 << 16
                archive.writestr(info, b'export const version = 1;\n')
            output = base / 'app'; output.mkdir()
            expected = installer.extract_source(packed, output, 'app/')
            installer.verify_source(output, expected)
            (output / 'server.mjs').write_bytes(b'changed')
            with self.assertRaises(ValueError): installer.verify_source(output, expected)

    def test_pointer_paths_cannot_select_executables_outside_install_root(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-pointer-') as temporary:
            root = Path(temporary)
            with self.assertRaises(ValueError):
                installer.check_active(root, {'product': 'cypher-tempre-chainchat', 'version': '0.8.0',
                    'release': str(root), 'data': str(root), 'node': '/bin/sh', 'python': '/bin/sh'})

    def test_bootstrap_declares_pins_and_never_runs_an_unverified_download(self):
        source = (ROOT / 'installer/posix_bootstrap.sh').read_text(encoding='utf-8')
        self.assertIn('hash_file "$temp_dir/python.tar.gz"', source)
        self.assertLess(source.index('Python integrity check failed'), source.index('tar -xzf "$python_archive"'))
        self.assertLess(source.index('Bundled application integrity check failed'), source.index('"$temp_dir/python/bin/python3" -I'))
        self.assertNotIn('curl |', source)
        self.assertNotIn('sudo ', source)

    def test_exact_runtime_pins_cover_both_architectures(self):
        pins = json.loads((ROOT / 'openclaw/upstream-lock.json').read_text(encoding='utf-8'))['posix']
        self.assertEqual(set(pins), {'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'})
        for pair in pins.values():
            for name in ('node', 'python'):
                self.assertRegex(pair[name]['sha256'], r'^[a-f0-9]{64}$')
                self.assertTrue(pair[name]['url'].startswith('https://'))
        self.assertEqual({pair['node']['version'] for pair in pins.values()}, {'26.13.1'})

    def test_front_door_allows_slow_owned_readiness_but_holds_wrong_owner_and_early_exit(self):
        for scenario in ('slow-owned', 'migration-owned', 'wrong-owner', 'child-failed', 'reused-owner'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory(prefix='ct-launch-grace-') as temporary:
                directory = Path(temporary)
                (directory / 'current.json').write_text('{}', encoding='utf-8')
                active = {'node': 'synthetic-node', 'release': str(directory / 'release'), 'version': '0.9.2'}
                elapsed = [0]
                child = mock.Mock(pid=42)
                child.poll.return_value = 1 if scenario == 'child-failed' else 0 if scenario == 'reused-owner' else None

                def sleep(_):
                    elapsed[0] += 30

                def owner(*_):
                    if scenario == 'slow-owned':
                        return {'pid': 42} if elapsed[0] >= 210 else None
                    if scenario == 'migration-owned':
                        return {'pid': 42} if elapsed[0] >= 600 else None
                    return {'pid': 99} if scenario in ('wrong-owner', 'reused-owner') else None

                with (mock.patch.object(installer, 'fcntl', mock.Mock(LOCK_EX=2)),
                      mock.patch.object(installer, 'check_active', return_value=active),
                      mock.patch.object(installer, 'environment', return_value={}),
                      mock.patch.object(installer.subprocess, 'Popen', return_value=child),
                      mock.patch.object(installer, 'authenticated_status', side_effect=owner),
                      mock.patch.object(installer.time, 'monotonic', side_effect=lambda: elapsed[0]),
                      mock.patch.object(installer.time, 'sleep', side_effect=sleep)):
                    if scenario in ('slow-owned', 'migration-owned', 'reused-owner'):
                        result = installer.launch(directory, quiet=True)
                        self.assertTrue(result['ready'])
                        self.assertEqual(result['reused'], scenario == 'reused-owner')
                        self.assertEqual(elapsed[0], {'slow-owned': 210, 'migration-owned': 600}.get(scenario, 0))
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'did not become ready'):
                            installer.launch(directory, quiet=True)
                        self.assertEqual(elapsed[0], 900 if scenario == 'wrong-owner' else 0)
                    child.kill.assert_not_called()

    @unittest.skipUnless(os.name == 'posix', 'POSIX permission ownership guard')
    def test_existing_public_writable_installation_root_is_refused(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-permissions-') as temporary:
            # macOS exposes its temporary root through the /var system alias.
            # Test permissions on a canonical path; alias rejection is separate.
            directory = Path(temporary).resolve() / 'shared'; directory.mkdir(); directory.chmod(0o777)
            with self.assertRaises(ValueError): installer.checked_root(directory)
            directory.chmod(0o700)
            self.assertEqual(installer.checked_root(directory), directory.resolve())

    @unittest.skipUnless(os.name == 'posix', 'POSIX symbolic-link ownership guard')
    def test_symlinked_installation_root_is_refused(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-alias-') as temporary:
            base = Path(temporary).resolve()
            actual = base / 'actual'; actual.mkdir(mode=0o700)
            marker = actual / 'preserved'; marker.write_text('preserved', encoding='utf-8')
            alias = base / 'alias'; alias.symlink_to(actual, target_is_directory=True)
            with self.assertRaises(ValueError): installer.checked_root(alias)
            self.assertEqual(marker.read_text(encoding='utf-8'), 'preserved')


if __name__ == '__main__': unittest.main()
