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

# Every Vercel CLI call goes through cmd /c as ONE string. Two reasons:
#
#   1. Calling the npm shim directly from PowerShell raises a terminating
#      NativeCommandError, because vercel.ps1 writes its banner to stderr.
#      cmd captures stderr instead.
#   2. Passing arguments as an array to a PowerShell function drops the
#      program name. `Invoke-Vercel vercel env rm $name` once ran as
#      "D:\...\env rm ..." and reported "Could not find".
#
# cmd also passes stdin redirection through untouched, so the non-ASCII model
# id survives. PowerShell's own pipe re-encodes with the console code page
# (ASCII in Windows PowerShell 5.1) and corrupts it.
function Run-Cmd {
  param([string]$Line)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = cmd /c "$Line 2>&1"
    return @{ code = $LASTEXITCODE; out = ($out -join "`n") }
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
  $r = Run-Cmd "vercel link --yes"
  if ($r.code -ne 0) { throw "vercel link failed`n$($r.out)" }
}

$tmp = Join-Path $env:TEMP "vercel-env-value.txt"
$failed = @()

foreach ($name in @('PROV1_BASE', 'PROV1_KEY', 'PROV1_MODEL', 'PROV2_BASE', 'PROV2_KEY', 'PROV2_MODEL_1K', 'PROV2_MODEL_2K', 'PROV2_MODEL_4K', 'APP_PASSWORD', 'ADMIN_TOKEN')) {
  $val = $vars[$name]
  if (-not $val) { Write-Host "Skipping $name (blank in .env.local)"; continue }
  [System.IO.File]::WriteAllText($tmp, $val, (New-Object System.Text.UTF8Encoding $false))

  # `vercel env add` refuses to overwrite an existing value, so remove first.
  # The remove is allowed to fail: it fails when the variable does not exist
  # yet, and the add below then succeeds anyway.
  $rm = Run-Cmd "vercel env rm $name production --yes"
  Start-Sleep -Milliseconds 1500

  $r = Run-Cmd "vercel env add $name production < `"$tmp`""

  # If the add says the value already exists, the remove did not take effect.
  # Remove again and retry once.
  if ($r.code -ne 0 -and $r.out -match 'already exists') {
    Write-Host "  $name already exists, removing and retrying..."
    $rm = Run-Cmd "vercel env rm $name production --yes"
    Start-Sleep -Milliseconds 1500
    $r = Run-Cmd "vercel env add $name production < `"$tmp`""
  }

  if ($r.code -eq 0) {
    Write-Host "OK $name"
  } else {
    # Last check: the add may have succeeded but the CLI exited non-zero.
    # `vercel env ls` is the source of truth.
    $ls = Run-Cmd "vercel env ls production"
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
Write-Host "Variables on Vercel:"
(Run-Cmd "vercel env ls production").out

Write-Host ""
Write-Host "Done. Redeploying production..."
$r = Run-Cmd "vercel --prod --yes"
if ($r.code -ne 0) { throw "vercel deploy failed`n$($r.out)" }
Write-Host "Redeployed."
