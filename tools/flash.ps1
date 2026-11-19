param(
  [ValidateSet("hub", "hub32", "node")]
  [string]$Env = "hub",
  [string]$Port = "",
  [switch]$Fs
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$firmware = Join-Path $root "firmware"

$pio = Join-Path $env:APPDATA "Python\Python312\Scripts\pio.exe"
if (-not (Test-Path -LiteralPath $pio)) {
  $cmd = Get-Command pio -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "PlatformIO not found. Run tools/setup_toolchain.ps1 first."
  }
  $pio = $cmd.Source
}

Push-Location $firmware
try {
  $uploadArgs = @("run", "-e", $Env, "-t", "upload")
  if ($Port) {
    $uploadArgs += @("--upload-port", $Port)
  }
  & $pio @uploadArgs
  if ($LASTEXITCODE -ne 0) {
    throw "firmware upload failed"
  }

  if ($Fs) {
    $fsArgs = @("run", "-e", $Env, "-t", "uploadfs")
    if ($Port) {
      $fsArgs += @("--upload-port", $Port)
    }
    & $pio @fsArgs
    if ($LASTEXITCODE -ne 0) {
      throw "filesystem upload failed"
    }
  }
} finally {
  Pop-Location
}
