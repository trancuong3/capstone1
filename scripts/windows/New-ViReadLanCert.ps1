# Generate a scoped local ViRead LAN Test CA and leaf TLS certificate (OpenSSL).
# Keeps private keys strictly inside RuntimeDir\certs\private (never committed or bundled into APK).
param(
    [Parameter(Mandatory = $true)]
    [string]$LanHost,
    [string]$ExtraDns = "",
    [string]$ExtraIp = "",
    [string]$RuntimeDir = "",
    [switch]$ForceRegenerateLeaf
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WorkspaceParent = Split-Path -Parent $RepoRoot
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $RuntimeDir = Join-Path $WorkspaceParent "viread-host-runtime"
}

function Resolve-OpenSsl {
    $cmd = Get-Command openssl -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in @(
        "D:\Git\usr\bin\openssl.exe",
        "C:\Program Files\Git\usr\bin\openssl.exe",
        "C:\Program Files\OpenSSL-Win64\bin\openssl.exe"
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw "OpenSSL not found. Install Git for Windows or OpenSSL."
}

function Invoke-OpenSsl([string]$exe, [string[]]$argsList) {
    $p = Start-Process -FilePath $exe -ArgumentList $argsList -WindowStyle Hidden -Wait -PassThru
    if ($p.ExitCode -ne 0) {
        throw "OpenSSL command failed (exit $($p.ExitCode)): $($argsList -join ' ')"
    }
}

$openssl = Resolve-OpenSsl
$certsDir = Join-Path $RuntimeDir "certs"
$privateDir = Join-Path $certsDir "private"
New-Item -ItemType Directory -Force -Path $certsDir, $privateDir | Out-Null

$caKey = Join-Path $privateDir "viread-lan-ca.key"
$caCertPem = Join-Path $certsDir "viread-lan-ca.pem"
$caCertCrt = Join-Path $certsDir "viread-lan-ca.crt"
$leafKey = Join-Path $privateDir "viread-lan-server.key"
$leafCsr = Join-Path $privateDir "viread-lan-server.csr"
$leafCert = Join-Path $certsDir "viread-lan-server.pem"
$leafExt = Join-Path $privateDir "viread-lan-server.ext"
$metaFile = Join-Path $certsDir "cert-meta.json"

# 1. Create scoped Test Root CA once (825 days max, basicConstraints CA:TRUE, pathlen:0)
if (-not (Test-Path $caKey) -or -not (Test-Path $caCertPem)) {
    Write-Host "Creating scoped ViRead LAN Test CA..."
    $caCfg = Join-Path $privateDir "ca.cnf"
    @"
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no

[dn]
CN = ViRead Local LAN Acceptance CA
O = ViRead Local Test Host
OU = Non-Production LAN Acceptance Only

[v3_ca]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, digitalSignature, cRLSign, keyCertSign
"@ | Set-Content -Encoding ASCII $caCfg

    Invoke-OpenSsl $openssl @("req", "-x509", "-new", "-nodes", "-newkey", "rsa:2048", "-sha256", "-days", "365",
        "-config", $caCfg, "-keyout", $caKey, "-out", $caCertPem)
    Copy-Item -Force $caCertPem $caCertCrt
}

# Check whether existing leaf cert already matches LanHost
$needLeaf = $ForceRegenerateLeaf -or (-not (Test-Path $leafKey)) -or (-not (Test-Path $leafCert))
if (-not $needLeaf -and (Test-Path $metaFile)) {
    $meta = Get-Content $metaFile -Raw | ConvertFrom-Json
    if ($meta.lanHost -ne $LanHost) { $needLeaf = $true }
}

if ($needLeaf) {
    Write-Host "Issuing leaf TLS certificate for $LanHost..."
    $sanEntries = New-Object System.Collections.Generic.List[string]
    if ($LanHost -match "^\d{1,3}(\.\d{1,3}){3}$") {
        $sanEntries.Add("IP.1 = $LanHost")
        $sanEntries.Add("IP.2 = 127.0.0.1")
        if ($ExtraIp) { $sanEntries.Add("IP.3 = $ExtraIp") }
        $sanEntries.Add("DNS.1 = localhost")
        if ($ExtraDns) { $sanEntries.Add("DNS.2 = $ExtraDns") }
    } else {
        $sanEntries.Add("DNS.1 = $LanHost")
        $sanEntries.Add("DNS.2 = localhost")
        $sanEntries.Add("IP.1 = 127.0.0.1")
        if ($ExtraIp) { $sanEntries.Add("IP.2 = $ExtraIp") }
        if ($ExtraDns) { $sanEntries.Add("DNS.3 = $ExtraDns") }
    }

    @"
authorityKeyIdentifier = keyid,issuer
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
$($sanEntries -join "`r`n")
"@ | Set-Content -Encoding ASCII $leafExt

    $leafCfg = Join-Path $privateDir "leaf.cnf"
    @"
[req]
distinguished_name = dn
prompt = no

[dn]
CN = $LanHost
O = ViRead Local Test Host
"@ | Set-Content -Encoding ASCII $leafCfg

    Invoke-OpenSsl $openssl @("req", "-new", "-nodes", "-newkey", "rsa:2048",
        "-config", $leafCfg,
        "-keyout", $leafKey, "-out", $leafCsr)

    Invoke-OpenSsl $openssl @("x509", "-req", "-in", $leafCsr, "-CA", $caCertPem, "-CAkey", $caKey, "-CAcreateserial",
        "-out", $leafCert, "-days", "180", "-sha256", "-extfile", $leafExt)
    Remove-Item -Force $leafCsr -ErrorAction SilentlyContinue

    $caSha = (Get-FileHash -Algorithm SHA256 -Path $caCertPem).Hash.ToLowerInvariant()
    $leafSha = (Get-FileHash -Algorithm SHA256 -Path $leafCert).Hash.ToLowerInvariant()
    @{
        lanHost = $LanHost
        issuedAt = (Get-Date).ToString("o")
        caCertPem = $caCertPem
        caCertCrt = $caCertCrt
        caSha256 = $caSha
        leafCertPem = $leafCert
        leafSha256 = $leafSha
    } | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $metaFile
}

# Verify leaf against CA strictly
Invoke-OpenSsl $openssl @("verify", "-CAfile", $caCertPem, $leafCert)
Write-Host "OpenSSL chain verification: OK"

Write-Host "CA Cert (public, safe to embed in LAN debug APK): $caCertPem"
Write-Host "Leaf Cert: $leafCert"
exit 0
