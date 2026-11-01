# Run once: Docker Desktop at login + scheduled task to start home-cinema stack.
$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$stackScript = Join-Path $PSScriptRoot "start-stack-at-login.ps1"
$taskName = "HomeCinema-DockerStack"

$dockerSettings = Join-Path $env:APPDATA "Docker\settings-store.json"
if (Test-Path $dockerSettings) {
    $raw = Get-Content $dockerSettings -Raw -Encoding UTF8
    if ($raw -match '"AutoStart"\s*:\s*true') {
        Write-Host "Docker Desktop: AutoStart already enabled."
    } elseif ($raw -match '"AutoStart"\s*:\s*false') {
        $updated = $raw -replace '"AutoStart"\s*:\s*false', '"AutoStart": true'
        Set-Content -Path $dockerSettings -Value $updated -Encoding UTF8 -NoNewline
        Write-Host "Docker Desktop: AutoStart enabled in settings-store.json"
        Write-Host "Restart Docker Desktop once so the setting applies."
    } else {
        Write-Warning "Could not find AutoStart in Docker settings; enable startup in Docker Desktop manually."
    }
} else {
    Write-Warning "Docker settings not found at $dockerSettings; enable Start Docker Desktop when you sign in in Docker Desktop manually."
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$stackScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Starts home-cinema docker compose after Windows login (waits for Docker Engine)." `
    -Force | Out-Null

Write-Host "Scheduled task registered: $taskName"
Write-Host "Project: $ProjectRoot"
Write-Host "Containers use restart: unless-stopped; this task runs 'docker compose up -d' after each login."
