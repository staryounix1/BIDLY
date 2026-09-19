# BIDLY — run everything locally with one command (Windows PowerShell).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
  exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Docker is installed but not running. Open Docker Desktop and try again."
  exit 1
}

if (-not (Test-Path ".env")) { Copy-Item "env.local" ".env" }

Write-Host "==> Building images (this can take a few minutes the first time)"
docker compose build

Write-Host "==> Starting database"
docker compose up -d db
Write-Host "==> Waiting for database"
for ($i = 0; $i -lt 60; $i++) {
  docker compose exec -T db pg_isready -U bidly -d bidly *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 2
}

Write-Host "==> Applying migrations"
Get-ChildItem "..\..\db\migrations\*.sql" | Sort-Object Name | ForEach-Object {
  Get-Content $_.FullName | docker compose exec -T db psql -U bidly -d bidly -v ON_ERROR_STOP=1 -q
}

Write-Host "==> Seeding data"
Get-Content "..\..\db\seed\seed.sql" | docker compose exec -T db psql -U bidly -d bidly -v ON_ERROR_STOP=1 -q

Write-Host "==> Setting demo account passwords"
Get-Content "fix-passwords.sql" | docker compose exec -T db psql -U bidly -d bidly -v ON_ERROR_STOP=1 -q

Write-Host "==> Starting API and web"
docker compose up -d api web

Write-Host ""
Write-Host "===================================================="
Write-Host "  BIDLY is running:"
Write-Host "  Website :  http://localhost:3000"
Write-Host "  API     :  http://localhost:4000"
Write-Host "  Health  :  http://localhost:4000/health"
Write-Host ""
Write-Host "  Demo accounts (password: BidlyDev!2026)"
Write-Host "    customer@bidly.test"
Write-Host "    provider@bidly.test"
Write-Host ""
Write-Host "  Stop everything:   docker compose down"
Write-Host "  View API logs:     docker compose logs -f api"
Write-Host "===================================================="
