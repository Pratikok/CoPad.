$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  Write-Host 'Node.js and npm were not found. Install the current Node.js LTS release, then run start.bat again.' -ForegroundColor Red
  exit 1
}
$nodeHelp = & $node.Source --help 2>&1 | Out-String
if ($nodeHelp -notmatch '--watch-kill-signal') {
  Write-Host 'This CoPad host needs Node.js with watch-mode support so server fixes load without leaving an old backend running. Install the current Node.js LTS release, then run start.bat again.' -ForegroundColor Red
  exit 1
}
$ngrok = Get-Command ngrok -ErrorAction SilentlyContinue
if (-not $ngrok) {
  Write-Host 'ngrok was not found. Install the ngrok app and configure its authtoken, then run start.bat again.' -ForegroundColor Red
  Write-Host 'Install guide: https://ngrok.com/download/windows'
  exit 1
}

& $ngrok.Source config check *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'ngrok is not configured yet. Sign in at ngrok.com, copy your authtoken, and run:' -ForegroundColor Yellow
  Write-Host 'ngrok config add-authtoken YOUR_TOKEN'
  exit 1
}

$activeAgent = $null
try { $activeAgent = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2 } catch { }
if ($activeAgent -and @($activeAgent.tunnels).Count -gt 0) {
  Write-Host 'An ngrok tunnel is already running. Close its CoPad launcher window before starting another one.' -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path (Join-Path $root 'node_modules\y-websocket\bin\utils.cjs'))) {
  Write-Host 'Preparing CoPad collaboration dependencies (first run only)...'
  Push-Location $root
  try { & $npm.Source install --omit=optional; if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Check your internet connection and retry.' } }
  finally { Pop-Location }
}

$port = $null
$reuseServer = $false
$serverPath = Join-Path $root 'server.mjs'
foreach ($candidate in 8000..8010) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) { continue }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$candidate/__copad_health" -TimeoutSec 1
    if ($health.service -ne 'CoPad' -or $health.status -ne 'ready' -or $health.roomPresenceProtocol -lt 1) { continue }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $parent = if ($owner -and $owner.ParentProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId=$($owner.ParentProcessId)" -ErrorAction SilentlyContinue }
    $commandLine = [string]$owner.CommandLine + ' ' + [string]$parent.CommandLine
    if ($commandLine -like "*$serverPath*" -and $commandLine -match '--watch' -and $commandLine -match '--watch-kill-signal=SIGINT') {
      $port = $candidate
      $reuseServer = $true
      break
    }
  } catch { }
}

if ($reuseServer) {
  Write-Host "Reusing the up-to-date CoPad server on port $port." -ForegroundColor Green
} else {
  foreach ($candidate in 8000..8010) {
    $listener = $null
    try {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
      $listener.Start()
      $port = $candidate
      break
    } catch {
    } finally {
      if ($listener) { $listener.Stop() }
    }
  }
}
if (-not $port) {
  Write-Host 'No free port found between 8000 and 8010. Close another local server and try again.' -ForegroundColor Red
  exit 1
}

$server = $null
$tunnel = $null
try {
  if (-not $reuseServer) {
    # Watch the backend entry point and imported server modules. SIGINT asks
    # server.mjs to flush Yjs documents before Node restarts it on code changes.
    $serverArguments = '--watch --watch-kill-signal=SIGINT "' + $serverPath + '" --port ' + $port
    $server = Start-Process -FilePath $node.Source -ArgumentList $serverArguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
  }
  $localReady = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/__copad_health" -TimeoutSec 2
      if ($health.service -eq 'CoPad' -and $health.status -eq 'ready' -and $health.roomPresenceProtocol -ge 1) { $localReady = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $localReady) { throw 'The CoPad server did not start with the current room-presence features.' }

  Write-Host "CoPad is running locally at http://127.0.0.1:$port/"
  Write-Host 'Starting the secure ngrok tunnel. Keep this window open while your friends are using CoPad.'
  $tunnel = Start-Process -FilePath $ngrok.Source -ArgumentList @('http', "127.0.0.1:$port", '--log', 'stdout') -PassThru

  $publicUrl = $null
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($tunnel.HasExited) { throw 'ngrok closed before the public link was ready. Check the ngrok window for its error.' }
    try {
      $state = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2
      $publicUrl = $state.tunnels | Where-Object { $_.public_url -like 'https://*' -and $_.config.addr -like "*:$port" } | Select-Object -First 1 -ExpandProperty public_url
      if ($publicUrl) { break }
    } catch { }
    Start-Sleep -Milliseconds 750
  }
  if (-not $publicUrl) { throw 'ngrok did not provide an HTTPS link in time. Check the ngrok window and try again.' }

  Write-Host ''
  Write-Host 'Your CoPad public link:' -ForegroundColor Green
  Write-Host $publicUrl -ForegroundColor Cyan
  Write-Host 'The first time someone opens a free ngrok link, ngrok may ask them to click “Visit Site” once.' -ForegroundColor Yellow
  Write-Host 'Share a room from inside CoPad. The computer running this launcher must stay online.'
  Start-Process $publicUrl
  Write-Host ''
  Write-Host 'This window will close after the ngrok tunnel stops.'
  Wait-Process -Id $tunnel.Id
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
  exit 1
} finally {
  if ($tunnel -and -not $tunnel.HasExited) {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
  }
  if ($server -and -not $server.HasExited) {
    try { & $node.Source -e "process.kill($($server.Id), 'SIGINT')" *> $null } catch { }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      $server.Refresh()
      if ($server.HasExited) { break }
      Start-Sleep -Milliseconds 200
    }
    $server.Refresh()
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  }
}
