# Push keys from .env.local to Vercel production environment.
# Run:  powershell -ExecutionPolicy Bypass -File .\push-env.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Vercel CLI..."
  npm install -g vercel
}

if (-not (Test-Path .env.local)) { throw ".env.local not found" }

$vars = @{}
foreach ($line in Get-Content .env.local) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $k, $v = $line -split '=', 2
  $vars[$k.Trim()] = $v.Trim()
}

# Link the local folder to the Vercel project if not already linked.
if (-not (Test-Path .vercel\project.json)) {
  Write-Host "Linking to your Vercel project (follow the prompts)..."
  vercel link --yes
}

# The env var names changed (AIAPI_*/GOODAPI_* -> PROV1_*/PROV2_*). If the new
# key names are blank but the old ones are still on Vercel, copy them over
# instead of making you retype a key you already have.
# `vercel env ls <environment>` lists what is set; it takes no name filter.
function Get-EnvNames($envName) {
  $out = vercel env ls $envName --yes 2>$null | Out-String
  return ($out -split "`n" | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ -match '^[A-Z][A-Z0-9_]*$' })
}

$existing = Get-EnvNames 'production'
Write-Host "Already on Vercel (production): $($existing -join ', ')"

$old = @{ PROV1_KEY = 'AIAPI_KEY'; PROV2_KEY = 'GOODAPI_KEY' }
foreach ($new in $old.Keys) {
  if ($vars[$new]) { continue }
  $oldName = $old[$new]
  if ($existing -contains $oldName) {
    # `vercel env add <new> <target> <existing>` copies the value server-side.
    Write-Host "$new is blank but $oldName exists on Vercel — copying it over."
    vercel env rm $new production --yes 2>$null | Out-Null
    vercel env add $new production $oldName --yes
    if ($LASTEXITCODE -ne 0) { throw "Failed to copy $oldName -> $new" }
    Write-Host "OK $new (copied from $oldName)"
  } else {
    Write-Host "Skipping $new (blank, and no $oldName on Vercel to copy from)"
  }
}

foreach ($name in @('PROV1_BASE', 'PROV1_KEY', 'PROV1_MODEL', 'PROV2_BASE', 'PROV2_KEY', 'PROV2_MODEL_1K', 'PROV2_MODEL_2K', 'PROV2_MODEL_4K', 'APP_PASSWORD', 'ADMIN_TOKEN')) {
  $val = $vars[$name]
  if (-not $val) {
    if ((Get-EnvNames 'production') -contains $name) { Write-Host "Keeping existing $name"; continue }
    Write-Host "Skipping $name (empty in .env.local and not set on Vercel)"
    continue
  }
  # Remove then re-add: `vercel env add` refuses to overwrite an existing value.
  vercel env rm $name production --yes 2>$null | Out-Null
  $val | vercel env add $name production
  if ($LASTEXITCODE -eq 0) { Write-Host "OK $name" } else { throw "Failed: $name" }
}

Write-Host "`nDone. Redeploying production..."
vercel --prod --yes
