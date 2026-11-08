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
# native call and rely on the exit code instead.
function Invoke-Native {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Cmd)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Cmd.Count -gt 1) { & $Cmd[0] @($Cmd[1..($Cmd.Count - 1)]) 2>&1 | Out-Null }
    else { & $Cmd[0] 2>&1 | Out-Null }
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
}

if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Vercel CLI..."
  npm install -g vercel
}

if (-not (Test-Path .env.local)) { throw ".env.local not found" }

# Read as UTF8. Windows PowerShell defaults to ANSI and would corrupt the
# non-ASCII model id (CJK chars) - the upstream then rejects the model name.
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
  if ((Invoke-Native vercel link --yes) -ne 0) { throw "vercel link failed" }
}

# Each value goes through a UTF-8 file, never through the shell. Piping a
# string into vercel env add re-encodes it with the console code page and
# mangles anything outside ASCII.
$tmp = Join-Path $env:TEMP "vercel-env-value.txt"
foreach ($name in @('PROV1_BASE', 'PROV1_KEY', 'PROV1_MODEL', 'PROV2_BASE', 'PROV2_KEY', 'PROV2_MODEL_1K', 'PROV2_MODEL_2K', 'PROV2_MODEL_4K', 'APP_PASSWORD', 'ADMIN_TOKEN')) {
  $val = $vars[$name]
  if (-not $val) { Write-Host "Skipping $name (blank in .env.local)"; continue }
  [System.IO.File]::WriteAllText($tmp, $val, (New-Object System.Text.UTF8Encoding $false))

  # Remove then re-add: `vercel env add` refuses to overwrite an existing value.
  # A missing variable is not an error here, so the exit code is ignored.
  Invoke-Native vercel env rm $name production --yes | Out-Null

  # vercel env add reads the value from stdin.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    Get-Content $tmp -Raw -Encoding UTF8 | vercel env add $name production 2>&1 | Out-Null
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }

  if ($code -eq 0) { Write-Host "OK $name" } else { throw "Failed: $name (vercel env add exited $code)" }
}
Remove-Item $tmp -ErrorAction SilentlyContinue

Write-Host "`nDone. Redeploying production..."
if ((Invoke-Native vercel --prod --yes) -ne 0) { throw "vercel deploy failed" }
Write-Host "Redeployed."
