param(
  [string]$Config = "cloudflared.local-llm-chat.yml"
)

$ErrorActionPreference = "Stop"

$cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
$cloudflared = if ($cmd) { $cmd.Source } else { "C:\Program Files (x86)\cloudflared\cloudflared.exe" }

if (-not (Test-Path $cloudflared)) {
  throw "cloudflared.exe was not found. Install it with: winget install --id Cloudflare.cloudflared --exact"
}

$root = (Resolve-Path ".").Path
$configPath = Join-Path $root $Config
if (-not (Test-Path $configPath)) {
  throw "Missing tunnel config: $configPath"
}

$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stdout = Join-Path $logDir "cloudflared-named.stdout.log"
$stderr = Join-Path $logDir "cloudflared-named.stderr.log"
Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue

Start-Process `
  -FilePath $cloudflared `
  -ArgumentList @("tunnel", "--config", $configPath, "run") `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr | Out-Null

Write-Host "Named tunnel started."
Write-Host "Config: $configPath"
Write-Host "Log: $stderr"
