# Windows launcher: finds Node.js 18+ (or downloads a private copy into %USERPROFILE%\.surehand\node,
# verified against the nodejs.org checksums) and runs the Surehand MCP command given as arguments.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
# release layout: the server sits next to this script; source checkout: server\dist
$server = Join-Path $PSScriptRoot "surehand-ae.mjs"
if (-not (Test-Path $server)) { $server = Join-Path $root "server\dist\surehand-ae.mjs" }
$surehand = Join-Path $env:USERPROFILE ".surehand"
$privateNode = Join-Path $surehand "node"
# version 1.3 kept it in .aemcp\node (the server moves it on its first run)
$legacyNode = Join-Path $env:USERPROFILE ".aemcp\node"

# Files extracted from a downloaded zip carry the "downloaded from the internet" mark; clear it.
Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

# Surehand MCP's own entries in .surehand\ae and .aemcp: the same list as OWN_FILES in
# server/src/cli/uninstall.ts (a test keeps them equal). Everything else there is the user's.
$ownFiles = @("server", "config.json", "runtime.json", "extension-hash", "bridge-status.json", "instances", "update-check.json", "activity.jsonl", "tmp", "renders", "compat", "install.log", "install-result.json", "chatgpt.json", "chatgpt.lock", "sessions", "skills", "xray", "chat", "MOVED.txt")
# Our Agent Skills in .claude\skills and .agents\skills: the same list as SKILL_NAMES in server/src/cli/skills.ts.
$skills = @("surehand-ae", "surehand-ae-delivery", "surehand-ae-safe-restructure", "surehand-ae-timing-layout")
$legacyDir = Join-Path $env:USERPROFILE ".aemcp"

# Another Surehand app (.surehand\<app>) is installed: the shared Node.js stays for it.
function Test-OtherApps {
  if (-not (Test-Path $surehand)) { return $false }
  return [bool](Get-ChildItem $surehand -Directory -Force -ErrorAction SilentlyContinue | Where-Object { @("ae", "node", "ffmpeg", "bin") -notcontains $_.Name -and -not $_.Name.StartsWith(".") })
}

# Removes only our own entries of a folder (never the user's data) and says what was kept.
function Remove-Own($dir) {
  if (-not (Test-Path $dir)) { return }
  $kept = @()
  foreach ($item in Get-ChildItem $dir -Force -ErrorAction SilentlyContinue) {
    if ($item.Name -eq "node") {
      # .aemcp\node: 1.3's private Node.js, or the junction the move left (remove the link itself)
      if ($dir -eq $legacyDir) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $item.Delete() } else { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $item.FullName }
      }
      continue
    }
    if ($ownFiles -contains $item.Name) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $item.FullName }
    else { $kept += $item.Name }
  }
  if (-not (Get-ChildItem $dir -Force -ErrorAction SilentlyContinue)) { Remove-Item $dir -ErrorAction SilentlyContinue }
  if ($kept.Count) { Write-Host "Kept your files in ${dir}: $($kept -join ', ')" }
}

# .surehand\bin\cloudflared.exe only when Surehand downloaded it: its marker (cloudflared.surehand.json, written by
# `chatgpt --install-tunnel`) names the file's SHA-256 (server/src/cli/tunnel-install.ts removeOwnCloudflared)
function Remove-OwnCloudflared {
  $bin = Join-Path $surehand "bin"
  $exe = Join-Path $bin "cloudflared.exe"
  $marker = Join-Path $bin "cloudflared.surehand.json"
  if (-not (Test-Path $marker)) { return }
  try { $want = (Get-Content -Raw $marker | ConvertFrom-Json).sha256 } catch { $want = $null }
  if ((Test-Path $exe) -and $want -and ((Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower() -eq $want.ToLower())) { Remove-Item -Force -ErrorAction SilentlyContinue $exe }
  if (-not (Test-Path $exe)) { Remove-Item -Force -ErrorAction SilentlyContinue $marker }
  if ((Test-Path $bin) -and -not (Get-ChildItem $bin -Force)) { Remove-Item $bin -ErrorAction SilentlyContinue }
}

function Test-Node($path) {
  if (-not $path -or -not (Test-Path $path)) { return $false }
  try { return [int](& $path -p "process.versions.node.split('.')[0]") -ge 18 } catch { return $false }
}

$node = $null
$onPath = Get-Command node -ErrorAction SilentlyContinue
$candidates = @($(if ($onPath) { $onPath.Source }), (Join-Path $privateNode "node.exe"), (Join-Path $legacyNode "node.exe"))
# CI/testing: SUREHAND_AE_FORCE_NODE_DOWNLOAD=1 (or AEMCP_FORCE_NODE_DOWNLOAD=1) ignores the system Node, so the private download is used
if ($env:SUREHAND_AE_FORCE_NODE_DOWNLOAD -or $env:AEMCP_FORCE_NODE_DOWNLOAD) { $candidates = @((Join-Path $privateNode "node.exe")) }
foreach ($c in $candidates) {
  if (Test-Node $c) { $node = $c; break }
}

if (-not $node) {
  if ($args.Count -gt 0 -and $args[0] -eq "uninstall") {
    # without Node.js the server can't run its uninstaller: remove the extension and Surehand MCP's
    # own files only; checkpoints, backups, history, proofs and anything else stay
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:APPDATA "Adobe\CEP\extensions\com.aemcp")
    Remove-Own (Join-Path $surehand "ae")
    Remove-Own $legacyDir
    foreach ($s in $skills) { foreach ($d in @(".claude", ".agents")) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:USERPROFILE "$d\skills\$s") } }
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $surehand "migration.log")
    Remove-OwnCloudflared
    if (Test-OtherApps) { Write-Host "Kept $privateNode (another Surehand app uses it)." } else { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $privateNode }
    if ((Test-Path $surehand) -and -not (Get-ChildItem $surehand -Force)) { Remove-Item $surehand }
    Write-Host "Removed the After Effects extension and Surehand MCP's own files (Node.js not found, so AI app settings were left unchanged)."
    exit 0
  }
  Write-Host "Node.js was not found. Downloading a private copy for Surehand MCP (one time, about 30 MB)..."
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $base = "https://nodejs.org/dist/latest-v22.x"
  try {
    $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
    $line = ($sums -split "`n") | Where-Object { $_ -match " node-v[0-9.]+-win-$arch\.zip$" } | Select-Object -First 1
    $parts = $line.Trim() -split "\s+"
    $sum = $parts[0]; $file = $parts[1]
    $tmp = Join-Path $env:TEMP ("surehand-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp $file
    Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
  } catch {
    Write-Host "Download failed: $($_.Exception.Message)"
    Write-Host "Check your internet connection, or install Node.js from https://nodejs.org and run this again."
    Start-Process "https://nodejs.org/en/download"
    exit 1
  }
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $sum.ToLower()) {
    Write-Host "The downloaded Node.js failed its checksum check; aborting."
    exit 1
  }
  Write-Host "Unpacking Node.js (this can take a minute)..."
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $extracted = Get-ChildItem -Path $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName "node.exe") } | Select-Object -First 1
  if (-not $extracted) {
    Write-Host "Could not find node.exe in the downloaded archive; aborting."
    exit 1
  }
  if (Test-Path $privateNode) { Remove-Item -Recurse -Force $privateNode }
  # Move-Item does not create missing parent folders (%USERPROFILE%\.surehand may not exist yet)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $privateNode) | Out-Null
  try {
    Move-Item -Path $extracted.FullName -Destination $privateNode
  } catch {
    # e.g. TEMP on another drive: fall back to copying
    Copy-Item -Recurse -Path $extracted.FullName -Destination $privateNode
  }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
  $node = Join-Path $privateNode "node.exe"
  Write-Host "Node.js $(& $node --version) installed to $privateNode"
}

# Don't let Windows PowerShell 5.1 turn the server's normal stderr messages into terminating errors
$ErrorActionPreference = "Continue"
& $node $server @args
$status = $LASTEXITCODE
# The private Node can only be deleted after it has finished running the uninstaller.
if ($args.Count -gt 0 -and $args[0] -eq "uninstall") {
  if ($node -eq (Join-Path $privateNode "node.exe") -or $node -eq (Join-Path $legacyNode "node.exe")) {
    # .aemcp\node can be a junction to .surehand\node (after the move from 1.3): remove the link itself first
    if ((Test-Path $legacyNode) -and ((Get-Item $legacyNode -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { (Get-Item $legacyNode -Force).Delete() }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $legacyNode
    # the shared Node.js only when no other Surehand app needs it
    if (-not (Test-OtherApps)) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $privateNode }
  }
  foreach ($dir in @($surehand, (Join-Path $env:USERPROFILE ".aemcp"))) {
    if ((Test-Path $dir) -and -not (Get-ChildItem $dir -Force)) { Remove-Item $dir }
  }
}
exit $status
