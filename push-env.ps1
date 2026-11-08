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

foreach ($name in @('PROV1_BASE', 'PROV1_KEY', 'PROV1_MODEL', 'PROV2_BASE', 'PROV2_KEY', 'PROV2_MODEL_1K', 'PROV2_MODEL_2K', 'PROV2_MODEL_4K', 'APP_PASSWORD', 'ADMIN_TOKEN')) {
  $val = $vars[$name]
  if (-not $val) { Write-Host "Skipping $name (empty in .env.local)"; continue }
  # Remove then re-add: `vercel env add` refuses to overwrite an existing value.
  vercel env rm $name production --yes 2>$null | Out-Null
  $val | vercel env add $name production
  if ($LASTEXITCODE -eq 0) { Write-Host "OK $name" } else { throw "Failed: $name" }
}

Write-Host "`nDone. Redeploying production..."
vercel --prod --yes
