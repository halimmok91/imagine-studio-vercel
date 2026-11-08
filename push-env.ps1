# Push the values in .env.local to Vercel's production environment.
# Run:  powershell -ExecutionPolicy Bypass -File .\push-env.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Vercel CLI..."
  npm install -g vercel
}

if (-not (Test-Path .env.local)) { throw ".env.local not found" }

# Read as UTF8. Windows PowerShell defaults to ANSI and would corrupt the
# non-ASCII model id (按次) - the upstream then rejects the model name.
$vars = @{}
foreach ($line in Get-Content .env.local -Encoding UTF8) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $k, $v = $line -split '=', 2
  $vars[$k.Trim()] = $v.Trim()
}

# Link the local folder to the Vercel project if not already linked.
if (-not (Test-Path .vercel\project.json)) {
  Write-Host "Linking to your Vercel project (follow the prompts)..."
  vercel link --yes
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
  vercel env rm $name production --yes 2>$null | Out-Null
  Get-Content $tmp -Raw -Encoding UTF8 | vercel env add $name production
  if ($LASTEXITCODE -eq 0) { Write-Host "OK $name" } else { throw "Failed: $name" }
}
Remove-Item $tmp -ErrorAction SilentlyContinue

Write-Host "`nDone. Redeploying production..."
vercel --prod --yes
