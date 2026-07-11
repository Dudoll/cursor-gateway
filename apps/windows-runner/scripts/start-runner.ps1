param(
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

Set-Location $ProjectRoot

$envFile = Join-Path $ProjectRoot "apps\windows-runner\.env"
$exampleFile = Join-Path $ProjectRoot "apps\windows-runner\.env.windows.example"

if (-not (Test-Path $envFile)) {
  Copy-Item $exampleFile $envFile
  Write-Host "Created $envFile"
  Write-Host "Edit CURSOR_API_KEY and RUNNER_WORKSPACES in that file, then run this script again."
  throw "Runner environment file must be configured before startup."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22+ is required. Install it from https://nodejs.org/ and reopen PowerShell."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required and should be installed with Node.js."
}

if (-not $SkipInstall) {
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE"
  }
}

npm run build -w "@cursor-gateway/shared"
if ($LASTEXITCODE -ne 0) {
  throw "Shared package build failed with exit code $LASTEXITCODE"
}

npm run build -w "@cursor-gateway/windows-runner"
if ($LASTEXITCODE -ne 0) {
  throw "Windows runner build failed with exit code $LASTEXITCODE"
}

npm run start -w "@cursor-gateway/windows-runner"
if ($LASTEXITCODE -ne 0) {
  throw "Windows runner exited with code $LASTEXITCODE"
}
