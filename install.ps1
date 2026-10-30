# AirBridge installer for Windows — no SmartScreen drama, no accounts, no fees.
#
#   powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/DigantaDey/AirBridge/main/install.ps1 -UseBasicParsing | iex"
#
# or:  .\install.ps1 [-Autostart]
param([switch]$Autostart)

$ErrorActionPreference = "Stop"
$Repo = if ($env:AIRBRIDGE_REPO) { $env:AIRBRIDGE_REPO } else { "DigantaDey/AirBridge" }
$Dir  = if ($env:AIRBRIDGE_INSTALL_DIR) { $env:AIRBRIDGE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "AirBridge" }
$Version = $env:AIRBRIDGE_VERSION

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Exe = Join-Path $Dir "AirBridge.exe"

# Release assets are published as AirBridge-windows-<arch>.exe (.exe included —
# without it the URL 404s, which is why older installs of this script failed).
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$Asset = "AirBridge-windows-$arch.exe"
$Base  = "https://github.com/$Repo/releases"
$Url   = if ($Version) { "$Base/download/$Version/$Asset" } else { "$Base/latest/download/$Asset" }

# Use inbox curl.exe: it downloads WITHOUT Mark-of-the-Web, so the portable
# EXE runs without a SmartScreen "protected your PC" sheet — the app is
# unsigned (Microsoft signing certificates cost money we don't pay), and the
# SHA256SUMS.txt on the release page gives you the integrity check instead.
Write-Host "▸ downloading $Asset"
& curl.exe -fL --proto "=https" --tlsv1.2 --retry 2 -o "$Exe.tmp" $Url
if ($LASTEXITCODE -ne 0) {
  Remove-Item "$Exe.tmp" -ErrorAction SilentlyContinue
  throw @"
download failed — no $Asset published yet.
  Check what is available:  $Base/latest
  Or build from source:     git clone https://github.com/$Repo.git; cd AirBridge; npm ci; npm run build:desktop
"@
}
if (-not (Test-Path "$Exe.tmp") -or (Get-Item "$Exe.tmp").Length -eq 0) {
  Remove-Item "$Exe.tmp" -ErrorAction SilentlyContinue
  throw "download produced an empty file"
}

# Integrity check against the release manifest (skipped if none is published).
try {
  $SumsUrl = if ($Version) { "$Base/download/$Version/SHA256SUMS.txt" } else { "$Base/latest/download/SHA256SUMS.txt" }
  $Sums = (& curl.exe -fsSL --proto "=https" --tlsv1.2 $SumsUrl) 2>$null
  $line = $Sums | Where-Object { $_ -match [regex]::Escape($Asset) } | Select-Object -First 1
  if ($line) {
    $want = ($line -split '\s+')[0].ToLower()
    $got  = (Get-FileHash "$Exe.tmp" -Algorithm SHA256).Hash.ToLower()
    if ($want -ne $got) {
      Remove-Item "$Exe.tmp" -ErrorAction SilentlyContinue
      throw "checksum mismatch for $Asset (expected $want, got $got)"
    }
    Write-Host "▸ checksum verified (sha256 $($got.Substring(0,16))…)"
  }
} catch {
  if ("$($_.Exception.Message)" -like "checksum mismatch*") { throw }
}

Move-Item -Force "$Exe.tmp" $Exe

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
Write-Host "  UI:      http://localhost:3000"
Write-Host "  Android: sideload AirBridge.apk from $Base/latest"
