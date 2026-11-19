param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root "firmware"
$dataCerts = Join-Path $firmware "data\certs"
$privateDir = Join-Path $root "tools\certs-private"

$openssl = $null
$cmd = Get-Command openssl -ErrorAction SilentlyContinue
if ($cmd) {
  $openssl = $cmd.Source
} else {
  $candidate = "C:\Program Files\Git\usr\bin\openssl.exe"
  if (Test-Path -LiteralPath $candidate) {
    $openssl = $candidate
  }
}
if (-not $openssl) {
  throw "OpenSSL not found. Install Git for Windows or add openssl to PATH."
}

New-Item -ItemType Directory -Force -Path $dataCerts | Out-Null
New-Item -ItemType Directory -Force -Path $privateDir | Out-Null

$caKey = Join-Path $privateDir "ca.key"
$caCrt = Join-Path $dataCerts "ca.crt"
$caSerial = Join-Path $privateDir "ca.srl"
$serverKey = Join-Path $dataCerts "server.key"
$serverCsr = Join-Path $privateDir "server.csr"
$serverCrt = Join-Path $dataCerts "server.crt"
$fingerprintFile = Join-Path $dataCerts "ca.fingerprint.txt"
$extFile = Join-Path $privateDir "server.ext"

$caGenerated = $false
if ($Force -or -not (Test-Path -LiteralPath $caKey) -or -not (Test-Path -LiteralPath $caCrt)) {
  Write-Output "[certs] generating CA"
  if (Test-Path -LiteralPath $caSerial) {
    Remove-Item -LiteralPath $caSerial -Force
  }
  & $openssl genrsa -out $caKey 2048
  if ($LASTEXITCODE -ne 0) {
    throw "CA key generation failed"
  }
  & $openssl req -x509 -new -key $caKey -sha256 -days 3650 -out $caCrt -subj "/CN=LoRaMessenger Local CA/O=LoRaMessenger" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
  if ($LASTEXITCODE -ne 0) {
    throw "CA certificate generation failed"
  }
  $caGenerated = $true
}

if ($Force -or $caGenerated -or -not (Test-Path -LiteralPath $serverKey) -or -not (Test-Path -LiteralPath $serverCrt)) {
  Write-Output "[certs] generating server certificate"
  foreach ($file in @($serverKey, $serverCrt, $serverCsr)) {
    if (Test-Path -LiteralPath $file) {
      Remove-Item -LiteralPath $file -Force
    }
  }
  & $openssl genrsa -out $serverKey 2048
  if ($LASTEXITCODE -ne 0) {
    throw "server key generation failed"
  }
  & $openssl req -new -key $serverKey -out $serverCsr -subj "/CN=192.168.4.1/O=LoRaMessenger"
  if ($LASTEXITCODE -ne 0) {
    throw "server CSR generation failed"
  }
  $ext = @(
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=IP:192.168.4.1"
  )
  Set-Content -LiteralPath $extFile -Value $ext -Encoding ASCII
  & $openssl x509 -req -in $serverCsr -CA $caCrt -CAkey $caKey -CAserial $caSerial -CAcreateserial -out $serverCrt -days 365 -sha256 -extfile $extFile
  if ($LASTEXITCODE -ne 0) {
    throw "server certificate signing failed"
  }
}

& $openssl verify -CAfile $caCrt $serverCrt
if ($LASTEXITCODE -ne 0) {
  throw "server certificate verification failed"
}

$fingerprint = (& $openssl x509 -in $caCrt -noout -fingerprint -sha256) -join ""
$fingerprint = $fingerprint -replace '^.*?=', ''
Set-Content -LiteralPath $fingerprintFile -Value $fingerprint -Encoding ASCII

Write-Output "[certs] OpenSSL: $openssl"
Write-Output "[certs] CA: $caCrt"
Write-Output "[certs] server: $serverCrt"
Write-Output "[certs] fingerprint: $fingerprint"
