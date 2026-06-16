param(
  [string]$Url = "https://grok.coderyo.com",
  [string]$ProfileDir = "$env:TEMP\grok-coderyo-chrome-mtls"
)

$ErrorActionPreference = "Stop"

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  throw "Chrome was not found at $chrome"
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$ProfileDir",
  "--no-first-run",
  "--disable-quic",
  "--disable-http3",
  "--new-window",
  $Url
)
