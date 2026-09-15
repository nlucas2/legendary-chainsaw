#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateRange(1, 300)]
    [int]$DrainTimeoutSeconds = 30,
    [switch]$CheckOnly
)

function Get-UpdatePaths([string]$Root) {
    $rootPath = [IO.Path]::GetFullPath($Root)
    @{
        Root = $rootPath
        App = Join-Path $rootPath 'target\release\copilot-sessions.exe'
        Daemon = Join-Path $rootPath 'target\release\bin\copilot-sessionsd.exe'
        Apps = @(
            (Join-Path $rootPath 'target\release\copilot-sessions.exe')
            (Join-Path $rootPath 'target\debug\copilot-sessions.exe')
        )
        Daemons = @(
            (Join-Path $rootPath 'target\release\bin\copilot-sessionsd.exe')
            (Join-Path $rootPath 'target\release\copilot-sessionsd.exe')
            (Join-Path $rootPath 'target\debug\bin\copilot-sessionsd.exe')
            (Join-Path $rootPath 'target\debug\copilot-sessionsd.exe')
        )
    }
}

function Get-UpdateProcesses {
    @(Get-CimInstance Win32_Process -ErrorAction Stop)
}

function Assert-ExternalUpdater($Paths, [object[]]$Processes, [int]$CurrentId = $PID) {
    $byId = @{}
    foreach ($process in $Processes) { $byId[[int]$process.ProcessId] = $process }
    if (-not $byId.ContainsKey($CurrentId)) { throw 'Cannot establish the updater process ancestry.' }
    $seen = [Collections.Generic.HashSet[int]]::new()
    while ($byId.ContainsKey($CurrentId) -and $seen.Add($CurrentId)) {
        $process = $byId[$CurrentId]
        if ($process.ExecutablePath -in ($Paths.Apps + $Paths.Daemons) -or
            $process.Name -in @('copilot-sessions.exe', 'copilot-sessionsd.exe')) {
            throw 'Run just update from a separate Windows Terminal, not from the app or one of its agent tools.'
        }
        $parentId = [int]$process.ParentProcessId
        if ($byId.ContainsKey($parentId) -and $byId[$parentId].CreationDate -gt $process.CreationDate) { break }
        $CurrentId = $parentId
    }
}

function Get-UpdateDaemon($Paths) {
    $owners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object LocalPort -eq 3847 | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -eq 0) { return $null }
    if ($owners.Count -ne 1) { throw 'Port 3847 has multiple owners. No processes were stopped.' }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])" -ErrorAction Stop
    if (-not $process -or $process.ExecutablePath -notin $Paths.Daemons) {
        throw 'Port 3847 is not owned by this repository''s daemon. No processes were stopped.'
    }
    $process
}

function Assert-SameUpdateProcess($Expected, $Actual) {
    if (($null -eq $Expected) -ne ($null -eq $Actual) -or
        ($Expected -and ($Expected.ProcessId -ne $Actual.ProcessId -or
            $Expected.CreationDate -ne $Actual.CreationDate -or
            $Expected.ExecutablePath -ne $Actual.ExecutablePath))) {
        throw 'The daemon/process changed during the update. Stopped rather than touching a replacement process.'
    }
}

function Invoke-UpdateApi([string]$Command, [hashtable]$Body = @{}, [int]$TimeoutSeconds = 20) {
    $headers = @{}
    if ($env:COPILOT_SESSIONS_TOKEN) { $headers.Authorization = "Bearer $env:COPILOT_SESSIONS_TOKEN" }
    Invoke-RestMethod "http://127.0.0.1:3847/api/$Command" -Method Post `
        -ContentType 'application/json' -Headers $headers -Body ($Body | ConvertTo-Json -Depth 8 -Compress) `
        -TimeoutSec $TimeoutSeconds -ErrorAction Stop
}

function Assert-NoQueuedOrBackgroundWork {
    $sessions = @(Invoke-UpdateApi 'list_sessions')
    foreach ($session in $sessions | Where-Object isActive) {
        $args = @{ sessionId = $session.sessionId }
        $queue = Invoke-UpdateApi 'queue_items' $args
        $tasks = Invoke-UpdateApi 'reference_section' @{ sessionId = $session.sessionId; section = 'tasks' }
        if ($null -eq $queue.items -or $null -eq $tasks.tasks) {
            throw "Cannot establish pending work for session $($session.sessionId). No restart was attempted."
        }
        $running = @($tasks.tasks | Where-Object { $_.status -notin @('completed', 'failed', 'cancelled', 'idle') })
        if (@($queue.items).Count -or @($queue.steeringMessages).Count -or
            $queue.inFlightSteeringCount -gt 0 -or $running.Count) {
            throw "Session $($session.sessionId) has queued messages or active background tasks. Try again when they finish."
        }
    }
}

function Assert-NoTerminalPrograms($Daemon) {
    $processes = Get-UpdateProcesses
    $shells = @($processes | Where-Object {
        $_.ParentProcessId -eq $Daemon.ProcessId -and $_.Name -in @('pwsh.exe', 'powershell.exe', 'cmd.exe', 'bash.exe', 'sh.exe', 'wsl.exe')
    })
    foreach ($shell in $shells) {
        if (@($processes | Where-Object ParentProcessId -eq $shell.ProcessId).Count) {
            throw "Terminal shell $($shell.ProcessId) still has a running child program. Finish it before updating."
        }
    }
}

function Stop-UpdateProcess($Expected) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($Expected.ProcessId)" -ErrorAction Stop
    if (-not $current) { return } # The user may already have closed the window.
    Assert-SameUpdateProcess $Expected $current
    Stop-Process -Id $current.ProcessId -ErrorAction Stop
    Wait-Process -Id $current.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
    if (Get-CimInstance Win32_Process -Filter "ProcessId = $($Expected.ProcessId)" -ErrorAction Stop) {
        throw "Process $($Expected.ProcessId) has not exited. Build was not started."
    }
}

function Invoke-UpdateBuild([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Program $($Arguments -join ' ') failed (exit $LASTEXITCODE). The update has stopped; keep this terminal open."
    }
}

function Start-UpdatedDesktop($Paths) {
    $names = @('COPILOT_SESSIONSD_PATH', 'COPILOT_SESSIONS_UI_DIR', 'COPILOT_SESSIONS_BIND')
    $previous = @{}
    foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        $env:COPILOT_SESSIONSD_PATH = $Paths.Daemon
        $env:COPILOT_SESSIONS_UI_DIR = Join-Path $Paths.Root 'target\release\web'
        $env:COPILOT_SESSIONS_BIND = '127.0.0.1:3847'
        Start-Process -FilePath $Paths.App -WorkingDirectory $Paths.Root -PassThru -ErrorAction Stop
    } finally {
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    }
}

function Wait-UpdatedDesktop($Paths, $App) {
    $deadline = [DateTime]::UtcNow.AddSeconds(75)
    $lastError = 'The daemon has not started listening.'
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($App.HasExited) { throw "The updated app exited before becoming ready (exit $($App.ExitCode))." }
        $daemon = Get-UpdateDaemon $Paths
        if ($daemon) {
            if ($daemon.ExecutablePath -ne $Paths.Daemon) { throw 'A different daemon started during the update.' }
            try {
                $status = Invoke-UpdateApi 'runtime_status' @{} 3
                if ($status.connected -eq $true -and $status.acceptingWork -eq $true) { return }
                $lastError = 'The daemon is listening but Copilot is not ready.'
            } catch [System.Net.Http.HttpRequestException], [System.Threading.Tasks.TaskCanceledException] {
                $lastError = $_.Exception.Message
            }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "The updated app did not become ready: $lastError"
}

function Invoke-DesktopUpdate([string]$Root, [int]$DrainSeconds = 30, [switch]$Check) {
    $ErrorActionPreference = 'Stop'
    if (-not $IsWindows) { throw 'The desktop updater currently supports Windows only.' }
    $paths = Get-UpdatePaths $Root
    $processes = Get-UpdateProcesses
    Assert-ExternalUpdater $paths $processes
    foreach ($tool in @('npm.cmd', 'cargo.exe', 'node.exe')) { Get-Command $tool -ErrorAction Stop | Out-Null }
    $daemon = Get-UpdateDaemon $paths
    if ($daemon) {
        $status = Invoke-UpdateApi 'runtime_status'
        if ($status.connected -isnot [bool] -or $status.acceptingWork -isnot [bool]) {
            throw 'The daemon returned an invalid runtime status.'
        }
        if ($status.connected) { Assert-NoQueuedOrBackgroundWork }
        Assert-NoTerminalPrograms $daemon
    }
    Write-Host 'Update: build prerequisites, drain without force, checkpoint terminals, close this repo''s app/daemon, rebuild and reopen.'
    Write-Host 'Save unsent drafts and terminal work first. Shell variables and running terminal programs do not survive the restart.'
    if ($Check) {
        Write-Host 'Check only: nothing was built, drained, stopped, or started.'
        return
    }

    $lock = $null
    Push-Location $paths.Root
    try {
        [IO.Directory]::CreateDirectory((Join-Path $paths.Root 'target')) | Out-Null
        $lock = [IO.File]::Open((Join-Path $paths.Root 'target\desktop-update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
        # Catch compilation/dependency failures while the existing app is still alive.
        Invoke-UpdateBuild 'npm.cmd' @('run', 'build')
        Invoke-UpdateBuild 'cargo.exe' @('build', '-p', 'copilot-sessionsd', '--release')
        Assert-SameUpdateProcess $daemon (Get-UpdateDaemon $paths)
        if ($daemon) {
            $status = Invoke-UpdateApi 'runtime_status'
            if ($status.connected -isnot [bool] -or $status.acceptingWork -isnot [bool]) {
                throw 'The daemon returned an invalid runtime status.'
            }
            if ($status.connected) {
                Assert-NoQueuedOrBackgroundWork
                Assert-NoTerminalPrograms $daemon
                try {
                    $prepared = Invoke-UpdateApi 'prepare_restart' @{ timeoutSeconds = $DrainSeconds; force = $false } ([Math]::Max(120, $DrainSeconds + 60))
                } catch {
                    throw "Restart preparation failed; no app/daemon processes were stopped. If new work remains paused, use Cancel drain in Runtime maintenance. $($_.Exception.Message)"
                }
                if ($prepared.drain.complete -isnot [bool] -or -not $prepared.drain.complete) {
                    if ($prepared.drain.complete -is [bool] -and -not $prepared.drain.complete) {
                        Invoke-UpdateApi 'cancel_drain' | Out-Null
                    }
                    throw 'Work did not drain or preparation was invalid. No app/daemon processes were stopped; try again later.'
                }
                Write-Host "Checkpointed $($prepared.checkpointedTerminals) terminal session(s)."
            } else {
                # prepare_restart cannot checkpoint terminals after a separate
                # disconnect. Do not kill potentially live, uncheckpointed shells.
                $children = @(Get-UpdateProcesses | Where-Object {
                    $_.ParentProcessId -eq $daemon.ProcessId -and $_.Name -notin @('conhost.exe', 'copilot.exe')
                })
                if ($children.Count) {
                    throw 'The runtime is disconnected but terminal processes remain. Reconnect, then use Prepare daemon restart before updating.'
                }
            }
            Assert-SameUpdateProcess $daemon (Get-UpdateDaemon $paths)
            $status = Invoke-UpdateApi 'runtime_status'
            if ($status.connected -isnot [bool] -or $status.acceptingWork -isnot [bool] -or
                $status.connected -or $status.acceptingWork) {
                throw 'The runtime reconnected or accepted work during preparation. No processes were stopped.'
            }
        }
        foreach ($app in Get-UpdateProcesses | Where-Object { $_.ExecutablePath -in $paths.Apps }) {
            Stop-UpdateProcess $app
        }
        if ($daemon) { Stop-UpdateProcess $daemon }
        Invoke-UpdateBuild 'npm.cmd' @('run', 'desktop:build')
        if (-not (Test-Path $paths.App) -or -not (Test-Path $paths.Daemon)) {
            throw 'Build completed without the expected desktop/daemon artifacts.'
        }
        if (Get-UpdateDaemon $paths) { throw 'A daemon restarted during the build. No second daemon was launched.' }
        $app = Start-UpdatedDesktop $paths
        Wait-UpdatedDesktop $paths $app
        Write-Host 'Copilot Sessions is updated and ready at http://127.0.0.1:3847.'
    } finally {
        if ($lock) { $lock.Dispose() }
        Pop-Location
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-DesktopUpdate -Root (Split-Path $PSScriptRoot -Parent) `
        -DrainSeconds $DrainTimeoutSeconds -Check:$CheckOnly
}
