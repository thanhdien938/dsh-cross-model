<#
.SYNOPSIS
  P10-R0.2.4.2 Part U — read-only owner evidence collector.

.DESCRIPTION
  Prints, in order:
    1. The newest task/dispatch diagnostics folder under the runtime's
       logs/tasks/ root (this now correctly picks up a FAILED --task-file
       preflight dispatch's `dispatch-<id>` bundle, not just a real
       `task-<id>` bundle — see Part D/I/U).
    2. That folder's summary.md.
    3. That folder's events.jsonl.
    4. The newest docs/history/single/<folder> entry in the TARGET
       PROJECT's own repository (resolved from projects.yaml).
    5. That history entry's Task.md / Walkthrough.md / ExecutionLog.md.
    6. The tail of the target project's progress.md.

  Never mutates anything — every step is a read. Safe to run repeatedly.

.PARAMETER RuntimeEnv
  The .runtime/<env> segment (default: live1).

.PARAMETER ProjectId
  Canonical project id to resolve for the docs/history / progress.md steps
  (default: dsh-p6-test-b).

.PARAMETER ProgressTailLines
  How many trailing lines of progress.md to print (default: 10).
#>
[CmdletBinding()]
param(
  [string]$RuntimeEnv = 'live1',
  [string]$ProjectId = 'dsh-p6-test-b',
  [int]$ProgressTailLines = 10
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runtimeRoot = Join-Path $repoRoot ".runtime\$RuntimeEnv"
$tasksRoot = Join-Path $runtimeRoot 'logs\tasks'
$projectsYamlPath = Join-Path $runtimeRoot 'projects.yaml'

function Write-Section([string]$title) {
  Write-Host ''
  Write-Host "==== $title ====" -ForegroundColor Cyan
}

function Print-FileOrMissing([string]$path, [string]$label) {
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    Write-Host "--- $label ($path) ---"
    Get-Content -LiteralPath $path -Raw
  } else {
    Write-Host "--- $label MISSING: $path ---" -ForegroundColor Yellow
  }
}

# ---- 1. newest task/dispatch diagnostics folder (task-<id> or dispatch-<id>) ----
Write-Section "1. Latest task/dispatch diagnostics folder ($tasksRoot)"
if (-not (Test-Path -LiteralPath $tasksRoot -PathType Container)) {
  Write-Host "MISSING: $tasksRoot" -ForegroundColor Yellow
  $latestTaskDir = $null
} else {
  $latestTaskDir = Get-ChildItem -LiteralPath $tasksRoot -Directory |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if ($null -eq $latestTaskDir) {
    Write-Host "(no task/dispatch folders found yet)" -ForegroundColor Yellow
  } else {
    $kind = if ($latestTaskDir.Name -like 'dispatch-*') { 'FAILED PREFLIGHT DISPATCH' } else { 'TASK' }
    Write-Host "Latest: $($latestTaskDir.Name)  [$kind]  (last write: $($latestTaskDir.LastWriteTimeUtc.ToString('o')))"
  }
}

# ---- 2/3. summary.md + events.jsonl for that folder ----
if ($null -ne $latestTaskDir) {
  Write-Section "2. summary.md"
  Print-FileOrMissing (Join-Path $latestTaskDir.FullName 'summary.md') 'summary.md'

  Write-Section "3. events.jsonl"
  Print-FileOrMissing (Join-Path $latestTaskDir.FullName 'events.jsonl') 'events.jsonl'
}

# ---- resolve target project's repo_path from projects.yaml ----
Write-Section "Resolving project '$ProjectId' repo_path from $projectsYamlPath"
$targetRepoPath = $null
if (Test-Path -LiteralPath $projectsYamlPath -PathType Leaf) {
  $lines = Get-Content -LiteralPath $projectsYamlPath
  $inBlock = $false
  foreach ($ln in $lines) {
    if ($ln -match '^\s*-\s*id:\s*(\S+)\s*$') {
      $inBlock = ($matches[1] -eq $ProjectId)
      continue
    }
    if ($inBlock -and $ln -match '^\s*repo_path:\s*(.+?)\s*$') {
      $targetRepoPath = $matches[1].Trim()
      break
    }
  }
}
if ($null -eq $targetRepoPath) {
  Write-Host "Could not resolve repo_path for project '$ProjectId' from $projectsYamlPath" -ForegroundColor Yellow
} else {
  Write-Host "repo_path = $targetRepoPath"
}

# ---- 4/5. newest docs/history/single/<folder> + its files ----
if ($null -ne $targetRepoPath -and (Test-Path -LiteralPath $targetRepoPath -PathType Container)) {
  $historySingleRoot = Join-Path $targetRepoPath 'docs\history\single'
  Write-Section "4. Latest docs/history/single entry ($historySingleRoot)"
  if (Test-Path -LiteralPath $historySingleRoot -PathType Container) {
    $latestHistory = Get-ChildItem -LiteralPath $historySingleRoot -Directory |
      Sort-Object Name -Descending |
      Select-Object -First 1
    if ($null -eq $latestHistory) {
      Write-Host "(no SINGLE history entries yet)" -ForegroundColor Yellow
    } else {
      Write-Host "Latest: $($latestHistory.Name)"
      Write-Section "5. Task.md / Walkthrough.md / ExecutionLog.md"
      Print-FileOrMissing (Join-Path $latestHistory.FullName 'Task.md') 'Task.md'
      Print-FileOrMissing (Join-Path $latestHistory.FullName 'Walkthrough.md') 'Walkthrough.md'
      Print-FileOrMissing (Join-Path $latestHistory.FullName 'ExecutionLog.md') 'ExecutionLog.md'
    }
  } else {
    Write-Host "MISSING: $historySingleRoot" -ForegroundColor Yellow
  }

  # ---- 6. progress.md tail ----
  Write-Section "6. progress.md (last $ProgressTailLines lines)"
  $progressPath = Join-Path $targetRepoPath 'progress.md'
  if (Test-Path -LiteralPath $progressPath -PathType Leaf) {
    Get-Content -LiteralPath $progressPath -Tail $ProgressTailLines
  } else {
    Write-Host "MISSING: $progressPath" -ForegroundColor Yellow
  }
} else {
  Write-Host "Skipping steps 4-6: target project repo_path is unavailable or does not exist on disk." -ForegroundColor Yellow
}
