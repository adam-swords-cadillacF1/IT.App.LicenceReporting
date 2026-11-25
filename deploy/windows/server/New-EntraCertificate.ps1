#Requires -RunAsAdministrator
<#
  One-time, ON THE SERVER (elevated PowerShell), after the first deploy has created app.env. Creates the
  certificate the app uses to sign in to Entra, so the private key is made on the server and never leaves it.

    C:\Apps\LicenceReportingApp\deploy\windows\server\New-EntraCertificate.ps1

  - Creates a self-signed certificate (RSA 2048, SHA-256, valid 2 years)
  - Writes the private key to C:\ProgramData\LicenceReportingApp\certs\entra-key.pem (folder is SYSTEM and
    Administrators only) and the public certificate to ...\certs\entra-cert.cer
  - Sets ENTRA_CERT_KEY_PATH and ENTRA_CERT_THUMBPRINT in app.env if it exists, otherwise prints them
  - Removes the certificate from the Windows certificate store again, so the PEM file is the only copy of the key

  Then upload entra-cert.cer to the app registration (Certificates & secrets > Certificates > Upload). It is
  the public half only, so it is safe to copy. Make a new one before the expiry date shown at the end.
#>
param(
    [string] $ConfigRoot = 'C:\ProgramData\LicenceReportingApp',
    [string] $Subject    = 'CN=Licence Reporting (Entra sign-in)',
    [int]    $Years      = 2,
    [switch] $Force                          # replace an existing key
)

$ErrorActionPreference = 'Stop'
$certs   = Join-Path $ConfigRoot 'certs'
$keyFile = Join-Path $certs 'entra-key.pem'
$cerFile = Join-Path $certs 'entra-cert.cer'
$envFile = Join-Path $ConfigRoot 'app.env'

if (-not (Test-Path $ConfigRoot)) { throw "$ConfigRoot doesn't exist yet. Run Enable-SmbDeploy.ps1 first (it creates and locks it)." }
if ((Test-Path $keyFile) -and -not $Force) { throw "$keyFile already exists. Use -Force to replace it (then upload the new .cer to Entra)." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is needed (it converts the key to the format the app reads).' }
if (-not (Test-Path $certs)) { New-Item -ItemType Directory -Path $certs | Out-Null }

# ── DER encoding of an RSA private key (PKCS#1), from the key's parameters ──
function Get-DerLength([int] $Length) {
    if ($Length -lt 0x80) { return ,([byte[]]@($Length)) }
    $bytes = [BitConverter]::GetBytes($Length); [Array]::Reverse($bytes)
    $i = 0; while ($bytes[$i] -eq 0) { $i++ }
    $bytes = $bytes[$i..($bytes.Length - 1)]
    return ,([byte[]](@(0x80 + $bytes.Length) + $bytes))
}
function Get-DerInteger([byte[]] $Value) {
    $i = 0; while ($i -lt $Value.Length - 1 -and $Value[$i] -eq 0) { $i++ }
    $v = [byte[]]$Value[$i..($Value.Length - 1)]
    if ($v[0] -ge 0x80) { $v = [byte[]](@(0) + $v) }
    return ,([byte[]](@(0x02) + (Get-DerLength $v.Length) + $v))
}
function ConvertTo-Pkcs1Der([System.Security.Cryptography.RSAParameters] $p) {
    $body = New-Object System.Collections.Generic.List[byte]
    foreach ($part in @([byte[]]@(0), $p.Modulus, $p.Exponent, $p.D, $p.P, $p.Q, $p.DP, $p.DQ, $p.InverseQ)) {
        $body.AddRange([byte[]](Get-DerInteger $part))
    }
    return ,([byte[]](@(0x30) + (Get-DerLength $body.Count) + $body.ToArray()))
}

# The legacy CSP provider lets the key be exported as plain parameters (CNG keys can refuse to)
$cert = New-SelfSignedCertificate -Subject $Subject -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeySpec Signature -KeyExportPolicy Exportable `
    -Provider 'Microsoft Enhanced RSA and AES Cryptographic Provider' -NotAfter (Get-Date).AddYears($Years)
try {
    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
    $der = ConvertTo-Pkcs1Der $rsa.ExportParameters($true)
    $pkcs1 = "-----BEGIN RSA PRIVATE KEY-----`n" + ([Convert]::ToBase64String($der) -replace '(.{64})', "`$1`n").TrimEnd("`n") +
        "`n-----END RSA PRIVATE KEY-----`n"
    # Node checks the key and rewrites it as PKCS#8, the usual format for the app's sign-in library.
    # The key goes through standard input, never the command line.
    $js = "const c=require('crypto');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(c.createPrivateKey(s).export({type:'pkcs8',format:'pem'})))"
    $pkcs8 = ($pkcs1 | node -e $js) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $pkcs8 -notmatch 'BEGIN PRIVATE KEY') { throw 'Node could not read the exported key.' }
    [IO.File]::WriteAllText($keyFile, "$pkcs8`n", (New-Object System.Text.UTF8Encoding($false)))
    [IO.File]::WriteAllBytes($cerFile, $cert.RawData)
    $sha256 = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData) | ForEach-Object { $_.ToString('X2') })
    $sha1 = $cert.Thumbprint
    $expires = $cert.NotAfter
} finally {
    # Leave no copy of the key in the certificate store
    Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey -ErrorAction SilentlyContinue
}

if (Test-Path $envFile) {
    $lines = @(Get-Content $envFile)
    foreach ($pair in @(@('ENTRA_CERT_KEY_PATH', $keyFile), @('ENTRA_CERT_THUMBPRINT', $sha256))) {
        $name, $value = $pair
        if ($lines -match "^\s*$name\s*=") { $lines = $lines -replace "^\s*$name\s*=.*$", "$name=$value" }
        else { $lines += "$name=$value" }
    }
    Set-Content -Path $envFile -Value $lines -Encoding ascii
    Write-Host "Updated ENTRA_CERT_KEY_PATH and ENTRA_CERT_THUMBPRINT in $envFile" -ForegroundColor Green
} else {
    Write-Host "app.env doesn't exist yet (the first deploy creates it). Put these in it:" -ForegroundColor Yellow
    Write-Host "  ENTRA_CERT_KEY_PATH=$keyFile"
    Write-Host "  ENTRA_CERT_THUMBPRINT=$sha256"
}
Write-Host ''
Write-Host "Private key : $keyFile (stays on this server)"
Write-Host "Upload this : $cerFile  ->  App registration > Certificates & secrets > Certificates > Upload certificate"
Write-Host "Entra will list it with thumbprint $sha1 (SHA-1). It expires $($expires.ToString('dd MMM yyyy'))."
