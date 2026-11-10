# Signing ChainChat installers

Build the platform installers from the same reviewed commit and test them before
signing. Keep private signing credentials in the publisher's OS certificate store,
hardware token or Apple Keychain. The ordinary build and acceptance jobs need no
signing credentials. Publish the checksums and manifests produced after signing.

## Windows

On a Windows publisher machine, install the Windows SDK SignTool and make a
publicly trusted code-signing certificate available in the current user's
certificate store. Use the certificate's SHA-1 thumbprint to select its identity.
The installer signature and timestamp themselves use SHA-256. Use the RFC 3161
timestamp service specified by your certificate provider.

```powershell
pwsh -File installer/sign_windows.ps1 -Installer <reviewed-exe> -OutputDirectory <new-directory> -SignTool <signtool-path> -CertificateThumbprint <publisher-thumbprint> -TimestampUrl <https-rfc3161-url>
```

The command requires both trusted Authenticode verification and a timestamp
before it produces the release directory. Test the resulting EXE on a fresh
Windows machine. For a cloud signing identity, use the certificate provider's
protected Windows signing runner and the equivalent Authenticode policy checks.

## macOS

Use a Mac with Xcode command-line tools and a **Developer ID Application** identity
in Keychain. Configure a local profile with `xcrun notarytool store-credentials`.
Then build the app bundle, sign it, submit it to Apple and attach the ticket:

```sh
python3 installer/sign_macos.py --installer <reviewed-macos-zip> --output-dir <new-directory> --signing-identity 'Developer ID Application: Publisher (TEAMID)' --team-id <team-id> --notary-profile <profile>
```

The command builds a universal setup app with the reviewed installer as a signed
resource. It checks the publisher Team ID, waits for Apple acceptance, staples
the app and checks the extracted release ZIP with Gatekeeper. Use
`--prepare-only` to build and check both architectures without credentials.
Test the resulting ZIP on a fresh Mac and open **Install ChainChat.app**.

[Microsoft Authenticode timestamping](https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures) · [Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
