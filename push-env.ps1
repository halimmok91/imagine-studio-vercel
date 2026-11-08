# Push the values in .env.local to Vercel's production environment.
# Run:  powershell -ExecutionPolicy Bypass -File .\push-env.ps1
#
# THIS FILE MUST STAY PURE ASCII. Windows PowerShell reads .ps1 as ANSI, so a
# single em-dash or CJK character in a comment corrupts the byte stream, eats
# the closing quote, and the script dies with a parser error. It has happened
# twice. If you edit this file, keep it ASCII.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$self = Get-Content $PSCommandPath -Raw
if ($self -match '[^\x00-\x7F]') {
  throw "push-env.ps1 contains non-ASCII characters and will not parse on Windows PowerShell. Remove them."
}

# The Vercel CLI writes its banner and progress to stderr. With
# ErrorActionPreference = Stop, PowerShell turns that into a terminating
# NativeCommandError even when the command succeeded. Relax it around every
# native call and rely on the exit code and captured output instead.
function Invoke-Vercel {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Cmd)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Cmd[0] @($Cmd[1..($Cmd.Count - 1)]) 2>&1 | Out-String
    return @{ code = $LASTEXITCODE; out = $out }
  } finally { $ErrorActionPreference = $prev }
}

# Feed the value to `vercel env add` as raw bytes through cmd redirection.
# PowerShell's own pipe re-encodes a string with the console code page (ASCII
# in Windows PowerShell 5.1), which corrupts the non-ASCII model id.
function Add-EnvVar {
  param([string]$Name, [string]$TmpFile)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = cmd /c "vercel env add $Name production < `"$TmpFile`" 2>&1" 2>&1 | Out-String
    return @{ code = $LASTEXITCODE; out = $out }
  } finally { $ErrorActionPreference = $prev }
}

if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Vercel CLI..."
  npm install -g vercel
}

if (-not (Test-Path .env.local)) { throw ".env.local not found" }

# Read as UTF8. Windows PowerShell defaults to ANSI and would corrupt the
# non-ASCII model id - the upstream then rejects the model name.
$vars = @{}
foreach ($line in Get-Content .env.local -Encoding UTF8) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $k, $v = $line -split '=', 2
  $vars[$k.Trim()] = $v.Trim()
}

# Link the local folder to the Vercel project if not already linked.
# Newer CLI versions write .vercel/repo.json, older ones .vercel/project.json.
if (-not (Test-Path .vercel\project.json) -and -not (Test-Path .vercel\repo.json)) {
  Write-Host "Linking to your Vercel project..."
  $r = Invoke-Vercel vercel link --yes
  if ($r.code -ne 0) { throw "vercel link failed`n$($r.out)" }
}

$tmp = Join-Path $env:TEMP "vercel-env-value.txt"
$failed = @()

foreach ($name in @('PROV1_BASE', 'PROV1_KEY', 'PROV1_MODEL', 'PROV2_BASE', 'PROV2_KEY', 'PROV2_MODEL_1K', 'PROV2_MODEL_2K', 'PROV2_MODEL_4K', 'APP_PASSWORD', 'ADMIN_TOKEN')) {
  $val = $vars[$name]
  if (-not $val) { Write-Host "Skipping $name (blank in .env.local)"; continue }
  [System.IO.File]::WriteAllText($tmp, $val, (New-Object System.Text.UTF8Encoding $false))

  # `vercel env add` refuses to overwrite an existing value, so remove first.
  # The remove is allowed to fail - it fails when the variable does not exist
  # yet, and the add below then succeeds anyway.
  $rm = Invoke-Vercel vercel env rm $name production --yes
  Start-Sleep -Milliseconds 1500

  $r = Add-EnvVar $name $tmp

  # The remove above can fail for reasons the CLI does not explain (the
  # variable is protected, or the remove raced the add). If the add says the
  # value already exists, remove again and retry once.
  if ($r.code -ne 0 -and $r.out -match 'already exists') {
    Write-Host "  $name already exists, removing and retrying..."
    $rm = Invoke-Vercel vercel env rm $name production --yes
    Start-Sleep -Milliseconds 1500
    $r = Add-EnvVar $name $tmp
  }

  if ($r.code -eq 0) {
    Write-Host "OK $name"
  } else {
    # Last check: the add may have succeeded but the CLI exited non-zero.
    # `vercel env ls` is the source of truth.
    $ls = Invoke-Vercel vercel env ls production
    if ($ls.out -match [regex]::Escape($name)) {
      Write-Host "OK $name (already present)"
    } else {
      Write-Host "FAILED $name"
      Write-Host "  add said: $($r.out.Trim())"
      Write-Host "  rm said:  $($rm.out.Trim())"
      $failed += $name
    }
  }
}
Remove-Item $tmp -ErrorAction SilentlyContinue

if ($failed.Count -gt 0) {
  Write-Host ""
  Write-Host "These variables were not set: $($failed -join ', ')"
  Write-Host "Set them by hand in the Vercel dashboard, then redeploy."
  Write-Host "Nothing was redeployed."
  exit 1
}

Write-Host ""
Write-Host "Done. Redeploying production..."
$r = Invoke-Vercel vercel --prod --yes
if ($r.code -ne 0) { throw "vercel deploy failed`n$($r.out)" }
Write-Host "Redeployed."
