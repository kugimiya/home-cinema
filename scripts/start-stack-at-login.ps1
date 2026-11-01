# Waits for Docker Engine, then starts the home-cinema compose stack.
$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$maxWaitSec = 600
$stepSec = 5
$elapsed = 0

while ($elapsed -lt $maxWaitSec) {
    try {
        docker info *> $null
        if ($LASTEXITCODE -eq 0) { break }
    } catch {
        # Docker CLI not ready yet
    }
    Start-Sleep -Seconds $stepSec
    $elapsed += $stepSec
}

if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker did not become ready within ${maxWaitSec}s"
    exit 1
}

Set-Location $ProjectRoot
docker compose up -d
exit $LASTEXITCODE
