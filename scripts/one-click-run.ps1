param(
  [switch]$Pause
)

$ErrorActionPreference = 'Stop'

$RequiredEnvDefaults = [ordered]@{
  TARGET_URL = 'https://your-checkin-domain.example.com'
  CHECKIN_USERNAME = 'your_username'
  CHECKIN_PASSWORD = 'your_password'
}

function Get-EnvValueFromContent {
  param(
    [string]$Content,
    [string]$Key
  )

  foreach ($line in ($Content -split "`r?`n")) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) {
      continue
    }

    if ($trimmed -match ("^" + [regex]::Escape($Key) + "\s*=\s*(.*)$")) {
      return $Matches[1].Trim()
    }
  }

  return $null
}

function Update-EnvFile {
  param(
    [string]$Path,
    [hashtable]$Values
  )

  $lines = @()
  if (Test-Path $Path) {
    $lines = Get-Content $Path -Encoding UTF8
  }

  $output = New-Object System.Collections.Generic.List[string]
  $seen = @{}

  foreach ($line in $lines) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) {
      $output.Add($line)
      continue
    }

    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
      $key = $Matches[1]
      if ($Values.ContainsKey($key)) {
        $output.Add("$key=$($Values[$key])")
        $seen[$key] = $true
        continue
      }
    }

    $output.Add($line)
  }

  foreach ($key in $Values.Keys) {
    if (-not $seen.ContainsKey($key)) {
      if ($output.Count -gt 0 -and $output[$output.Count - 1] -ne '') {
        $output.Add('')
      }
      $output.Add("$key=$($Values[$key])")
    }
  }

  Set-Content -Path $Path -Value $output -Encoding UTF8
}

function Initialize-EnvFile {
  param([string]$EnvPath)

  $templatePath = Join-Path $ProjectRoot '.env.example'
  if (-not (Test-Path $templatePath)) {
    Stop-WithMessage 'Missing .env.example. Please check that the repository is complete.'
  }

  if (-not (Test-Path $EnvPath)) {
    Copy-Item $templatePath $EnvPath
    Write-Host '.env was missing. A template has been created from .env.example.'
  }

  $currentContent = Get-Content $EnvPath -Raw -Encoding UTF8
  $promptMap = [ordered]@{
    TARGET_URL = 'Enter TARGET_URL (for example https://example.com)'
    CHECKIN_USERNAME = 'Enter CHECKIN_USERNAME'
    CHECKIN_PASSWORD = 'Enter CHECKIN_PASSWORD'
  }

  $updates = @{}
  $needsPrompt = $false

  foreach ($key in $RequiredEnvDefaults.Keys) {
    $currentValue = Get-EnvValueFromContent -Content $currentContent -Key $key
    if (-not $currentValue -or $currentValue -eq $RequiredEnvDefaults[$key]) {
      $needsPrompt = $true
      $inputValue = Read-Host $promptMap[$key]
      if ([string]::IsNullOrWhiteSpace($inputValue)) {
        Stop-WithMessage "$key cannot be empty. Please run again and provide a valid value."
      }
      $updates[$key] = $inputValue.Trim()
    }
  }

  if ($needsPrompt) {
    Update-EnvFile -Path $EnvPath -Values $updates
    Write-Host '.env has been updated. Continuing with the automated run.'
  }
}

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Stop-WithMessage {
  param([string]$Message)
  Write-Host ""
  Write-Host $Message -ForegroundColor Yellow
  if ($Pause) {
    Write-Host ""
    Read-Host 'Press Enter to exit'
  }
  exit 1
}

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $ProjectRoot

Write-Host 'Auto check-in one-click runner'
Write-Host ('Project root: ' + $ProjectRoot)

Write-Step 'Checking Node.js'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Stop-WithMessage 'Node.js was not found. Please install Node.js 20 or later and try again.'
}

$nodeVersionText = (& node -v).Trim()
$nodeMajor = [int]($nodeVersionText.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
  Stop-WithMessage ('Current Node.js version is ' + $nodeVersionText + ', but the project requires Node.js 20 or later.')
}
Write-Host ('Node.js ' + $nodeVersionText)

Write-Step 'Checking .env'
Initialize-EnvFile -EnvPath (Join-Path $ProjectRoot '.env')
Write-Host '.env is ready'

Write-Step 'Checking dependencies'
if (-not (Test-Path 'node_modules\playwright')) {
  Write-Host 'node_modules was not found. Running npm install...'
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage 'npm install failed. Please check your network or npm configuration.'
  }
} else {
  Write-Host 'Dependencies are already installed'
}

Write-Step 'Using Microsoft Edge'
Write-Host 'Playwright is configured to launch the msedge channel.'

Write-Step 'Starting automated check-in'
New-Item -ItemType Directory -Force -Path 'runtime' | Out-Null
& npm.cmd run start
$runExitCode = $LASTEXITCODE

Write-Host ""
if ($runExitCode -eq 0) {
  Write-Host 'Run finished. Log file: runtime\app.log' -ForegroundColor Green
} else {
  Write-Host ('Run failed with exit code ' + $runExitCode + '. Check runtime\app.log and runtime\screenshots.') -ForegroundColor Red
}

if ($Pause) {
  Write-Host ""
  Read-Host 'Press Enter to exit'
}

exit $runExitCode
