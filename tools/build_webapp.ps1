$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$webapp = Join-Path $root "webapp"
$dest = Join-Path $root "firmware\data"

if (-not (Test-Path (Join-Path $webapp "package.json"))) {
  Write-Host "webapp/package.json not found; keeping firmware/data placeholder."
  exit 0
}

Push-Location $webapp
try {
  if (-not (Test-Path "node_modules")) {
    npm install
  }
  npm run build
} finally {
  Pop-Location
}

$dist = Join-Path $webapp "dist"
if (-not (Test-Path $dist)) {
  throw "webapp build output not found: $dist"
}

if (Test-Path $dest) {
  Get-ChildItem -LiteralPath $dest -Force | Remove-Item -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path (Join-Path $dist "*") -Destination $dest -Recurse -Force

Write-Host "Copied webapp build to firmware/data"
