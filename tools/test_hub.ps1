param(
  [string]$Ssid = "LM-A608",
  [string]$Password = "loraMessenger",
  [string]$HostIp = "192.168.4.1",
  [string]$CaPath = "",
  [string]$RestoreSsid,
  [switch]$KeepConnected
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root "firmware"
if (-not $CaPath) {
  $CaPath = Join-Path $firmware "data\certs\ca.crt"
}
if (-not (Test-Path -LiteralPath $CaPath)) {
  throw "CA file not found: $CaPath"
}

$configPath = Join-Path $firmware "src\config.h"
$expectedVersion = "unknown"
if (Test-Path -LiteralPath $configPath) {
  $config = Get-Content -LiteralPath $configPath -Raw
  if ($config -match '#define FW_VERSION "([^"]+)"') {
    $expectedVersion = $Matches[1]
  }
}

$currentSsid = ""
$iface = (& netsh wlan show interfaces 2>$null) -join "`n"
$match = [regex]::Match($iface, '(?m)^\s*SSID\s*:\s*(.+?)\s*$')
if ($match.Success) {
  $currentSsid = $match.Groups[1].Value.Trim()
}

if (-not $PSBoundParameters.ContainsKey("RestoreSsid")) {
  $RestoreSsid = $currentSsid
}
if ($RestoreSsid -eq $Ssid) {
  $RestoreSsid = ""
}

$results = @()

function Add-Result {
  param([string]$Name, $Expected, $Actual)
  $pass = "$Expected" -eq "$Actual"
  $script:results += [pscustomobject]@{
    Name = $Name
    Expected = $Expected
    Actual = $Actual
    Pass = $pass
  }
}

function Invoke-CurlCode {
  param([string]$Url, [string[]]$Extra = @())
  $curlArgs = @(
    "-sS", "--noproxy", "*", "--http1.1", "--max-time", "10",
    "-H", "Connection: close", "-o", "NUL", "-w", "%{http_code}"
  ) + $Extra + @($Url)
  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = (& curl.exe @curlArgs 2>&1) -join "`n"
    $curlExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldEap
  }
  if ($curlExit -ne 0) {
    throw "curl failed for $Url : $output"
  }
  return [int]($output.Trim())
}

function Invoke-CurlText {
  param([string]$Url, [string[]]$Extra = @())
  $curlArgs = @(
    "-sS", "--noproxy", "*", "--http1.1", "--max-time", "10",
    "-H", "Connection: close"
  ) + $Extra + @($Url)
  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = (& curl.exe @curlArgs 2>&1) -join "`n"
    $curlExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldEap
  }
  if ($curlExit -ne 0) {
    throw "curl failed for $Url : $output"
  }
  return $output
}

$xmlPath = Join-Path $env:TEMP "lm-test-$Ssid.xml"
$escapedSsid = [System.Security.SecurityElement]::Escape($Ssid)
$escapedPassword = [System.Security.SecurityElement]::Escape($Password)
$profileXml = @"
<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>$escapedSsid</name>
  <SSIDConfig>
    <SSID>
      <name>$escapedSsid</name>
    </SSID>
  </SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM>
    <security>
      <authEncryption>
        <authentication>WPA2PSK</authentication>
        <encryption>AES</encryption>
        <useOneX>false</useOneX>
      </authEncryption>
      <sharedKey>
        <keyType>passPhrase</keyType>
        <protected>false</protected>
        <keyMaterial>$escapedPassword</keyMaterial>
      </sharedKey>
    </security>
  </MSM>
</WLANProfile>
"@
Set-Content -LiteralPath $xmlPath -Value $profileXml -Encoding ASCII
& netsh wlan add profile filename="$xmlPath" user=current 2>$null | Out-Null
& netsh wlan set profileparameter name="$Ssid" connectionmode=manual 2>$null | Out-Null

$exitCode = 0
try {
  Write-Host "Conectando a $Ssid ..."
  & netsh wlan connect name="$Ssid" ssid="$Ssid" | Out-Null

  $reachable = $false
  for ($i = 0; $i -lt 40; $i++) {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -like "192.168.4.*" } |
      Select-Object -First 1 -ExpandProperty IPAddress
    if ($ip) {
      & curl.exe -sS --noproxy "*" --http1.1 --max-time 2 -H "Connection: close" -o NUL "http://$HostIp/install" 2>$null
      if ($LASTEXITCODE -eq 0) {
        $reachable = $true
        break
      }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $reachable) {
    $ifaceNow = (& netsh wlan show interfaces 2>$null) -join "`n"
    $ssidNow = [regex]::Match($ifaceNow, '(?m)^\s*SSID\s*:\s*(.+?)\s*$')
    $ssidText = if ($ssidNow.Success) { $ssidNow.Groups[1].Value.Trim() } else { "desconocido" }
    throw "No se pudo alcanzar http://$HostIp/install (SSID actual: $ssidText)"
  }

  $httpBase = "http://$HostIp"
  $httpsBase = "https://$HostIp"
  $tlsArgs = @("--cacert", $CaPath, "--ssl-no-revoke")

  Add-Result "http.root" 302 (Invoke-CurlCode "$httpBase/")
  Add-Result "http.install" 200 (Invoke-CurlCode "$httpBase/install")
  Add-Result "http.ca" 200 (Invoke-CurlCode "$httpBase/ca.crt")
  Add-Result "http.appjs" 404 (Invoke-CurlCode "$httpBase/app.js")
  Add-Result "http.api.state" 404 (Invoke-CurlCode "$httpBase/api/state")
  Add-Result "http.certs.key" 404 (Invoke-CurlCode "$httpBase/certs/server.key")
  Add-Result "http.tls-test" 302 (Invoke-CurlCode "$httpBase/tls-test")

  Add-Result "https.root" 200 (Invoke-CurlCode "$httpsBase/" $tlsArgs)
  Add-Result "https.install" 200 (Invoke-CurlCode "$httpsBase/install" $tlsArgs)
  Add-Result "https.appjs" 200 (Invoke-CurlCode "$httpsBase/app.js" $tlsArgs)
  Add-Result "https.certs.key" 404 (Invoke-CurlCode "$httpsBase/certs/server.key" $tlsArgs)
  Add-Result "https.tls-test" 302 (Invoke-CurlCode "$httpsBase/tls-test" $tlsArgs)

  $healthRaw = Invoke-CurlText "$httpsBase/api/health" $tlsArgs
  $health = $healthRaw | ConvertFrom-Json
  Add-Result "health.name" "LoRaMessenger" $health.name
  Add-Result "health.version" $expectedVersion $health.version
  Add-Result "health.role" "hub" $health.role
  Add-Result "health.https" "True" ([bool]$health.https).ToString()
  Add-Result "health.tls_spike" "False" ($health.PSObject.Properties.Name -contains "tls_spike").ToString()

  $stateRaw = Invoke-CurlText "$httpsBase/api/state" $tlsArgs
  $state = $stateRaw | ConvertFrom-Json
  Add-Result "state.api" 1 $state.api
  Add-Result "state.secure" "True" ([bool]$state.secure).ToString()
  Add-Result "state.https" "True" ([bool]$state.https).ToString()
  Add-Result "state.authenticated" "False" ([bool]$state.authenticated).ToString()

  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $logoutHeaders = (& curl.exe -sS --noproxy "*" --http1.1 --max-time 10 `
      --cacert $CaPath --ssl-no-revoke -D - -o NUL -X POST `
      -H "Connection: close" -H "Origin: https://$HostIp" `
      "$httpsBase/api/logout" 2>&1) -join "`n"
    $curlExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldEap
  }
  if ($curlExit -ne 0) {
    throw "curl failed for $httpsBase/api/logout : $logoutHeaders"
  }
  $statusLine = [regex]::Match($logoutHeaders, '(?m)^HTTP/\S+\s+(\d{3})').Groups[1].Value
  $setCookie = [regex]::Match($logoutHeaders, '(?im)^Set-Cookie:\s*(.+)$').Groups[1].Value.Trim()
  Add-Result "logout.status" 200 $statusLine
  Add-Result "cookie.present" "True" ($setCookie -match '^lm_session=').ToString()
  Add-Result "cookie.secure" "True" ($setCookie -match ';\s*Secure').ToString()
  Add-Result "cookie.httponly" "True" ($setCookie -match ';\s*HttpOnly').ToString()
  Add-Result "cookie.samesite" "True" ($setCookie -match ';\s*SameSite=Lax').ToString()

  Start-Sleep -Milliseconds 500
  $parallelUrls = @(
    "$httpsBase/api/health",
    "$httpsBase/api/health"
  )
  $parallelArgs = @(
    "-sS", "--noproxy", "*", "--http1.1", "--parallel", "--parallel-max", "2",
    "--max-time", "10", "--cacert", $CaPath, "--ssl-no-revoke",
    "-H", "Connection: close", "-w", "%{http_code}`n"
  )
  foreach ($parallelUrl in $parallelUrls) {
    $parallelArgs += @("-o", "NUL", $parallelUrl)
  }
  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $parallelOut = (& curl.exe @parallelArgs 2>&1) -join "`n"
    $curlExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldEap
  }
  if ($curlExit -ne 0) {
    throw "curl parallel failed: $parallelOut"
  }
  $parallelCodes = @(
    $parallelOut -split "`n" |
      Where-Object { $_ -match '^\d{3}$' } |
      ForEach-Object { [int]$_ } |
      Sort-Object
  )
  Add-Result "https.parallel2" "200,200" ($parallelCodes -join ",")

  $bodyPath = Join-Path $env:TEMP "lm-test-body.json"
  [System.IO.File]::WriteAllText($bodyPath, '{"username":"x","password":"x"}', [System.Text.Encoding]::ASCII)
  $evilOrigin = @(
    "-X", "POST",
    "-H", "Content-Type: application/json",
    "-H", "Origin: http://evil.example",
    "--data-binary", "@$bodyPath"
  )
  Add-Result "login.evil_origin" 403 (Invoke-CurlCode "$httpsBase/api/login" ($tlsArgs + $evilOrigin))
  Add-Result "setup.evil_origin" 403 (Invoke-CurlCode "$httpsBase/api/setup" ($tlsArgs + $evilOrigin))

  $locationBodyPath = Join-Path $env:TEMP "lm-test-location.json"
  [System.IO.File]::WriteAllText($locationBodyPath, '{"lat":0,"lon":0}', [System.Text.Encoding]::ASCII)
  $sameOrigin = @(
    "-X", "POST",
    "-H", "Content-Type: application/json",
    "-H", "Origin: https://$HostIp",
    "--data-binary", "@$locationBodyPath"
  )
  Add-Result "location.active.unauth" 401 (Invoke-CurlCode "$httpsBase/api/location/active" ($tlsArgs + $sameOrigin))
  Add-Result "location.manual.unauth" 401 (Invoke-CurlCode "$httpsBase/api/location/manual" ($tlsArgs + $sameOrigin))
  Add-Result "location.phone.unauth" 401 (Invoke-CurlCode "$httpsBase/api/location/phone" ($tlsArgs + $sameOrigin))
  Add-Result "location.request.unauth" 401 (Invoke-CurlCode "$httpsBase/api/location/request" ($tlsArgs + $sameOrigin))
  Add-Result "location.clear.unauth" 401 (Invoke-CurlCode "$httpsBase/api/location/clear" ($tlsArgs + $sameOrigin))

  $failed = @($results | Where-Object { -not $_.Pass })
  $results | Format-Table Name, Expected, Actual, Pass -AutoSize

  if ($failed.Count -gt 0) {
    Write-Host "$($failed.Count) prueba(s) fallaron." -ForegroundColor Red
    $exitCode = 1
  } else {
    Write-Host "Todas las pruebas pasaron." -ForegroundColor Green
  }
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  $exitCode = 2
} finally {
  if (-not $KeepConnected -and $RestoreSsid) {
    Write-Host "Restaurando Wi-Fi: $RestoreSsid ..."
    & netsh wlan connect name="$RestoreSsid" | Out-Null
  }
  Remove-Item -LiteralPath $xmlPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $env:TEMP "lm-test-body.json") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $env:TEMP "lm-test-location.json") -Force -ErrorAction SilentlyContinue
}

exit $exitCode
