# Run from a Windows publisher machine with a trusted code-signing identity.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$SignTool,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$CertificateThumbprint,
    [Parameter(Mandatory)][uri]$TimestampUrl
)
$ErrorActionPreference = 'Stop'
if (!$TimestampUrl.IsAbsoluteUri -or $TimestampUrl.Scheme -ne 'https' -or $TimestampUrl.UserInfo) {
    throw 'Use an HTTPS RFC 3161 timestamp URL.'
}
$inputPath = (Resolve-Path -LiteralPath $Installer).Path
$signToolPath = (Resolve-Path -LiteralPath $SignTool).Path
$name = [IO.Path]::GetFileName($inputPath)
$report = Get-Content -LiteralPath "$inputPath.json" -Raw | ConvertFrom-Json
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant()
if ($report.platform -ne 'windows-x64' -or $report.installer -ne $name -or $report.sha256 -ne $digest -or $report.authenticodeSigned -ne $false) {
    throw 'Build the reviewed unsigned Windows installer and its manifest first.'
}
$destination = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) {
    throw 'Choose a new output directory for the signed installer.'
}
$parent = Split-Path -Parent $destination
$staging = [IO.Directory]::CreateDirectory((Join-Path $parent ('.chainchat-sign-' + [guid]::NewGuid().ToString('N'))))
try {
    $output = Join-Path $staging.FullName $name
    Copy-Item -LiteralPath $inputPath -Destination $output
    & $signToolPath sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl.AbsoluteUri /td SHA256 $output
    if ($LASTEXITCODE) { throw 'Authenticode signing failed.' }
    & $signToolPath verify /pa /all /tw $output
    if ($LASTEXITCODE) { throw 'Trusted Authenticode verification failed.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $output
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $CertificateThumbprint -or !$signature.TimeStamperCertificate) {
        throw 'The expected publisher signature and trusted timestamp are required.'
    }
    $report.authenticodeSigned = $true
    $report.sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash.ToLowerInvariant()
    $report.bytes = (Get-Item -LiteralPath $output).Length
    $report | Add-Member -NotePropertyName publisherCertificateThumbprint -NotePropertyValue $signature.SignerCertificate.Thumbprint
    $report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath "$output.json" -Encoding utf8
    "$($report.sha256)  $name" | Set-Content -LiteralPath "$output.sha256" -Encoding ascii
    [IO.Directory]::Move($staging.FullName, $destination)
} finally {
    # Remove only the three known outputs in the unique staging directory.
    foreach ($file in $name, "$name.json", "$name.sha256") {
        $candidate = Join-Path $staging.FullName $file
        if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate }
    }
    if (Test-Path -LiteralPath $staging.FullName) { Remove-Item -LiteralPath $staging.FullName }
}
