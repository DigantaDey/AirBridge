# AirBridge installer for Windows — no SmartScreen drama, no accounts, no fees.
#
#   powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/DigantaDey/AirBridge/main/install.ps1 -UseBasicParsing | iex"
#
# or:  .\install.ps1 [-Autostart]
param([switch]$Autostart)

$ErrorActionPreference = "Stop"
$Repo = if ($env:AIRBRIDGE_REPO) { $env:AIRBRIDGE_REPO } else { "DigantaDey/AirBridge" }
$Dir  = if ($env:AIRBRIDGE_INSTALL_DIR) { $env:AIRBRIDGE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "AirBridge" }

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Exe = Join-Path $Dir "AirBridge.exe"
$Url = "https://github.com/$Repo/releases/latest/download/AirBridge-windows-x64"

# Use inbox curl.exe: it downloads WITHOUT Mark-of-the-Web, so the portable
# EXE runs without a SmartScreen "protected your PC" sheet — the app is
# unsigned (Microsoft signing certificates cost money we don't pay), and the
# SHA256SUMS.txt on the release page gives you the integrity check instead.
Write-Host "▸ downloading AirBridge-windows-x64"
& curl.exe -fL --proto "=https" --tlsv1.2 -o $Exe $Url
if ($LASTEXITCODE -ne 0) { throw "download failed" }

# User-scope PATH (no admin).
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$Dir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$Dir", "User")
  Write-Host "▸ added to user PATH: $Dir"
}

if ($Autostart) {
  # Per-user Run key — no admin needed.
  & reg.exe ADD "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" `
    /v AirBridge /t REG_SZ /d "`"$Exe`" --no-browser" /f | Out-Null
  Write-Host "▸ autostart registered (HKCU Run)"
}

Write-Host "▸ installed: $Exe"
Write-Host ""
Write-Host "AirBridge is ready. Start it with:  AirBridge --no-browser"
Write-Host "  UI:      http://localhost:3411"
Write-Host "  Android: install AirBridge.apk from the same release (sideload)"
