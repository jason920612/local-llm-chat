param(
  [string]$Target = "http://127.0.0.1:3000",
  [string]$LogDir = "logs"
)

$ErrorActionPreference = "Stop"

$cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
$cloudflared = if ($cmd) { $cmd.Source } else { "C:\Program Files (x86)\cloudflared\cloudflared.exe" }

if (-not (Test-Path $cloudflared)) {
  throw "cloudflared.exe was not found. Install it with: winget install --id Cloudflare.cloudflared --exact"
}

$root = (Resolve-Path ".").Path
$fullLogDir = Join-Path $root $LogDir
New-Item -ItemType Directory -Force -Path $fullLogDir | Out-Null

$stdout = Join-Path $fullLogDir "cloudflared-quick.stdout.log"
$stderr = Join-Path $fullLogDir "cloudflared-quick.stderr.log"
Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue

Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

Start-Process `
  -FilePath $cloudflared `
  -ArgumentList @("tunnel", "--url", $Target) `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr | Out-Null

$deadline = (Get-Date).AddSeconds(30)
$url = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $stderr) {
    $content = Get-Content $stderr -Raw -ErrorAction SilentlyContinue
    if ($content -match "https://[a-z0-9-]+\.trycloudflare\.com") {
      $url = $Matches[0]
      break
    }
  }
}

if (-not $url) {
  Write-Host "Tunnel started, but the public URL was not found yet."
  Write-Host "Check: $stderr"
  exit 1
}

Write-Host "Cloudflare Quick Tunnel:"
Write-Host $url
Write-Host ""
Write-Host "Target: $Target"
Write-Host "Log: $stderr"
