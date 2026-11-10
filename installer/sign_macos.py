"""Wrap the reviewed macOS installer in a Developer ID app, notarize, and staple."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
from zipfile import ZipFile

LAUNCHER = Path(__file__).with_name("macos_setup.swift")
IDENTIFIER = "ai.cyphertempre.chainchat.setup"
APP_NAME = "Install ChainChat.app"


def command(*args, capture=False, timeout=300):
    return subprocess.run(args, check=True, text=True, capture_output=capture, timeout=timeout)


def prepare(archive: Path, app: Path, version: str):
    contents = app / "Contents"
    executable = contents / "MacOS" / "Setup"
    resources = contents / "Resources"
    executable.parent.mkdir(parents=True)
    resources.mkdir()
    with ZipFile(archive) as packaged:
        bootstrap = packaged.getinfo("Install ChainChat.command")
        if not 0 < bootstrap.file_size < 100 * 1024 * 1024:
            raise ValueError("Unexpected setup resource size.")
        (resources / "install.sh").write_bytes(packaged.read(bootstrap))
    (contents / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleExecutable": "Setup",
        "CFBundleIdentifier": IDENTIFIER,
        "CFBundleName": "Install ChainChat",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
        "LSMinimumSystemVersion": "13.5",
        "NSHighResolutionCapable": True,
    }))
    with tempfile.TemporaryDirectory(prefix="chainchat-macos-arch-") as build:
        slices = []
        for arch in ("arm64", "x86_64"):
            binary = str(Path(build) / arch)
            command("xcrun", "--sdk", "macosx", "swiftc", "-target", f"{arch}-apple-macos13.5",
                    "-O", str(LAUNCHER), "-o", binary)
            slices.append(binary)
        command("xcrun", "lipo", "-create", *slices, "-output", str(executable))
    slices = command("xcrun", "lipo", "-archs", str(executable), capture=True).stdout.split()
    if sorted(slices) != ["arm64", "x86_64"]:
        raise ValueError("The installer needs both macOS architectures.")
    command("plutil", "-lint", str(contents / "Info.plist"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--signing-identity")
    parser.add_argument("--team-id")
    parser.add_argument("--notary-profile")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Run on macOS with Xcode command-line tools.")
    if not args.prepare_only and (
            not args.signing_identity or not args.notary_profile or
            not re.fullmatch(r"[A-Z0-9]{10}", args.team_id or "")):
        parser.error("Provide the Developer ID Application identity, Team ID and local notarytool profile.")
    archive, output = args.installer.resolve(strict=True), args.output_dir.resolve()
    if output.exists() or not output.parent.is_dir():
        parser.error("Choose a new output directory inside an existing directory.")
    report = json.loads(archive.with_name(archive.name + ".json").read_bytes())
    if (archive.stat().st_size > 100 * 1024 * 1024 or report.get("platform") != "macos" or
            report.get("installer") != archive.name or report.get("publisherSigned") is not False or
            report.get("sha256") != hashlib.sha256(archive.read_bytes()).hexdigest() or
            not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", report.get("version", ""))):
        parser.error("Build the reviewed unsigned macOS ZIP and its matching manifest first.")

    with tempfile.TemporaryDirectory(prefix=".chainchat-notary-", dir=output.parent) as temporary:
        staging = Path(temporary)
        final = staging / "release"
        final.mkdir()
        app = final / APP_NAME if args.prepare_only else staging / APP_NAME
        prepare(archive, app, report["version"])
        if not args.prepare_only:
            command("codesign", "--sign", args.signing_identity, "--options", "runtime", "--timestamp", str(app))
            command("codesign", "--verify", "--strict", "--deep", str(app))
            signature = command("codesign", "-d", "--verbose=4", str(app), capture=True).stderr.splitlines()
            if (f"TeamIdentifier={args.team_id}" not in signature or
                    not any(line.startswith("Authority=Developer ID Application: ") for line in signature)):
                raise ValueError("The app must use the expected Developer ID Application identity.")
            submission = staging / "submission.zip"
            command("/usr/bin/ditto", "-c", "-k", "--keepParent", str(app), str(submission))
            response = command("xcrun", "notarytool", "submit", str(submission), "--keychain-profile",
                               args.notary_profile, "--wait", "--output-format", "json", capture=True, timeout=1800)
            receipt = json.loads(response.stdout)
            if receipt.get("status") != "Accepted":
                raise ValueError("Apple did not accept this submission. Review notarytool history and logs.")
            command("xcrun", "stapler", "staple", str(app))
            command("xcrun", "stapler", "validate", str(app))
            signed = final / archive.name
            command("/usr/bin/ditto", "-c", "-k", "--keepParent", str(app), str(signed))
            verification = staging / "verification"
            command("/usr/bin/ditto", "-x", "-k", str(signed), str(verification))
            restored = verification / APP_NAME
            command("codesign", "--verify", "--strict", "--deep", str(restored))
            command("xcrun", "stapler", "validate", str(restored))
            command("spctl", "--assess", "--type", "execute", str(restored))
            report.update(publisherSigned=True, notarized=True, publisherTeamId=args.team_id,
                          notarizationId=receipt["id"], bytes=signed.stat().st_size,
                          sha256=hashlib.sha256(signed.read_bytes()).hexdigest())
            signed.with_name(signed.name + ".json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            signed.with_name(signed.name + ".sha256").write_text(report["sha256"] + "  " + signed.name + "\n", encoding="ascii")
        # Publish the completed directory together only after every verification.
        final.rename(output)


if __name__ == "__main__":
    main()
