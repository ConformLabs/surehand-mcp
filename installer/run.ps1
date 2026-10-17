# Windows launcher: finds Node.js 18+ (or downloads a private copy into %USERPROFILE%\.aemcp\node,
# verified against the nodejs.org checksums) and runs the AE MCP command given as arguments.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root "server\dist\ae-mcp.mjs"
$privateNode = Join-Path $env:USERPROFILE ".aemcp\node"

# Files extracted from a downloaded zip carry the "downloaded from the internet" mark; clear it.
Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

function Test-Node($path) {
  if (-not $path -or -not (Test-Path $path)) { return $false }
  try { return [int](& $path -p "process.versions.node.split('.')[0]") -ge 18 } catch { return $false }
}

$node = $null
$onPath = Get-Command node -ErrorAction SilentlyContinue
foreach ($c in @($(if ($onPath) { $onPath.Source }), (Join-Path $privateNode "node.exe"))) {
  if (Test-Node $c) { $node = $c; break }
}

if (-not $node) {
  if ($args.Count -gt 0 -and $args[0] -eq "uninstall") {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:APPDATA "Adobe\CEP\extensions\com.aemcp"), (Join-Path $env:USERPROFILE ".aemcp")
    Write-Host "Removed the After Effects extension and .aemcp (Node.js not found, so AI app settings were left unchanged)."
    exit 0
  }
  Write-Host "Node.js was not found. Downloading a private copy for AE MCP (one time, about 30 MB)..."
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $base = "https://nodejs.org/dist/latest-v22.x"
  try {
    $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
    $line = ($sums -split "`n") | Where-Object { $_ -match " node-v[0-9.]+-win-$arch\.zip$" } | Select-Object -First 1
    $parts = $line.Trim() -split "\s+"
    $sum = $parts[0]; $file = $parts[1]
    $tmp = Join-Path $env:TEMP ("aemcp-" + [guid]::NewGuid())
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
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  if (Test-Path $privateNode) { Remove-Item -Recurse -Force $privateNode }
  Move-Item (Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($file))) $privateNode
  Remove-Item -Recurse -Force $tmp
  $node = Join-Path $privateNode "node.exe"
  Write-Host "Node.js $(& $node --version) installed to $privateNode"
}

& $node $server @args
$status = $LASTEXITCODE
# The private Node can only be deleted after it has finished running the uninstaller.
if ($args.Count -gt 0 -and $args[0] -eq "uninstall" -and $node -eq (Join-Path $privateNode "node.exe")) {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $privateNode
  $dir = Join-Path $env:USERPROFILE ".aemcp"
  if ((Test-Path $dir) -and -not (Get-ChildItem $dir -Force)) { Remove-Item $dir }
}
exit $status
