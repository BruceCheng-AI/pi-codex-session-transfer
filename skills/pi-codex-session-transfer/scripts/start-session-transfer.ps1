[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 38711,
  [switch]$Refresh
)

$ErrorActionPreference = 'Stop'

function Get-CodexRoot {
  if ($env:CODEX_HOME) { return $env:CODEX_HOME }
  return (Join-Path $env:USERPROFILE '.codex')
}

function Get-PiAgentDir {
  $candidates = @()
  if ($env:PI_CODING_AGENT_DIR) { $candidates += $env:PI_CODING_AGENT_DIR }
  $candidates += 'D:\Pi\agent'
  $candidates += (Join-Path $env:USERPROFILE '.pi\agent')

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
    $hasPiData = (Test-Path -LiteralPath (Join-Path $candidate 'sessions')) -or
      (Test-Path -LiteralPath (Join-Path $candidate 'settings.json')) -or
      (Test-Path -LiteralPath (Join-Path $candidate 'models.json'))
    if ($hasPiData) { return $candidate }
  }
  return $null
}

function Get-ToolConfig([int]$CandidatePort) {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$CandidatePort/api/config" -TimeoutSec 1
  } catch {
    return $null
  }
}

function Test-LocalPortInUse([int]$CandidatePort) {
  try {
    return $null -ne (Get-NetTCPConnection -LocalPort $CandidatePort -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1)
  } catch {
    return $false
  }
}

$skillRoot = Split-Path -Parent $PSScriptRoot
$sourceTool = Join-Path $skillRoot 'assets\tool'
$codexRoot = Get-CodexRoot
$installedTool = Join-Path $codexRoot 'tools\pi-codex-session-transfer'
$node = Get-Command node -ErrorAction SilentlyContinue

if (-not $node) {
  throw 'Node.js was not found on PATH. Install Node.js, reopen Codex, then run this skill again.'
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceTool 'server.js') -PathType Leaf)) {
  throw "Bundled transfer tool is missing: $sourceTool"
}

if (-not (Test-Path -LiteralPath $installedTool -PathType Container)) {
  New-Item -ItemType Directory -Path $installedTool -Force | Out-Null
  Copy-Item -Path (Join-Path $sourceTool '*') -Destination $installedTool -Recurse -Force
} elseif ($Refresh) {
  Copy-Item -Path (Join-Path $sourceTool '*') -Destination $installedTool -Recurse -Force
}

$env:CODEX_HOME = $codexRoot
$piAgentDir = Get-PiAgentDir
if ($piAgentDir) {
  $env:PI_CODING_AGENT_DIR = $piAgentDir
} else {
  Write-Warning 'No Pi Agent data directory was detected. The service will start, but Pi transfers require Pi Agent to be installed and initialized.'
}

$selectedPort = $null
for ($candidate = $Port; $candidate -lt ($Port + 100); $candidate++) {
  $config = Get-ToolConfig $candidate
  if ($config -and $config.service -eq 'pi-codex-session-transfer') {
    [pscustomobject]@{
      Url = "http://127.0.0.1:$candidate"
      Port = $candidate
      Reused = $true
      CodexRoot = $config.codexRoot
      PiAgentDir = $config.piAgentDir
      ToolPath = $installedTool
    }
    return
  }
  if (-not (Test-LocalPortInUse $candidate)) {
    $selectedPort = $candidate
    break
  }
}
if (-not $selectedPort) {
  throw "No free loopback port was found between $Port and $($Port + 99)."
}

$env:CODEX_TO_PI_PORT = "$selectedPort"
$stdout = Join-Path $installedTool 'server.log'
$stderr = Join-Path $installedTool 'server.error.log'
$process = Start-Process -FilePath $node.Source -ArgumentList @((Join-Path $installedTool 'server.js')) `
  -WorkingDirectory $installedTool -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

$config = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 200
  $config = Get-ToolConfig $selectedPort
  if ($config -and $config.service -eq 'pi-codex-session-transfer') { break }
}
if (-not $config -or $config.service -ne 'pi-codex-session-transfer') {
  throw "The local service did not become ready. Review $stderr for details."
}

[pscustomobject]@{
  Url = "http://127.0.0.1:$selectedPort"
  Port = $selectedPort
  Reused = $false
  ProcessId = $process.Id
  CodexRoot = $config.codexRoot
  PiAgentDir = $config.piAgentDir
  ToolPath = $installedTool
}
