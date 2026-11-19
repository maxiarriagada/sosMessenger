$ErrorActionPreference = "Stop"

$python = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"

if (-not (Test-Path -LiteralPath $python)) {
  Write-Host "Python not found. Installing Python 3.12 (user scope)..."
  winget install --id Python.Python.3.12 -e --scope user --silent `
    --accept-package-agreements --accept-source-agreements

  if (-not (Test-Path -LiteralPath $python)) {
    throw "Python install finished but python.exe was not found at $python"
  }
}

& $python -m pip install --user -U platformio

$scripts = Join-Path $env:APPDATA "Python\Python312\Scripts"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$scripts*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$scripts", "User")
  Write-Host "Added $scripts to the user PATH."
}

Write-Host "PlatformIO installed. Close and reopen the terminal to use 'pio'."
