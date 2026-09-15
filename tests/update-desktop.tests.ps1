param([Parameter(Mandatory)][string]$UpdaterPath, [Parameter(Mandatory)][string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
[Management.Automation.Language.Parser]::ParseFile($UpdaterPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
. $UpdaterPath

function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Expect-Failure([scriptblock]$Action, [string]$Pattern) {
    $failed = $false
    try { & $Action }
    catch {
        $failed = $true
        Assert ($_.Exception.Message -match $Pattern) "Unexpected error: $($_.Exception.Message)"
    }
    Assert $failed "Expected failure matching $Pattern"
}

$paths = Get-UpdatePaths $FixtureRoot
[IO.Directory]::CreateDirectory((Split-Path $paths.Daemon -Parent)) | Out-Null
[IO.File]::WriteAllText($paths.App, 'fixture')
[IO.File]::WriteAllText($paths.Daemon, 'fixture')
$script:daemon = [pscustomobject]@{
    ProcessId = 910001; ParentProcessId = 910002; Name = 'copilot-sessionsd.exe'
    ExecutablePath = $paths.Daemon; CreationDate = [datetime]'2026-01-01'
}
$script:app = [pscustomobject]@{
    ProcessId = 910002; ParentProcessId = 0; Name = 'copilot-sessions.exe'
    ExecutablePath = $paths.App; CreationDate = [datetime]'2026-01-01'
}
$script:caller = [pscustomobject]@{
    ProcessId = $PID; ParentProcessId = 0; Name = 'pwsh.exe'
    ExecutablePath = 'C:\external\pwsh.exe'; CreationDate = [datetime]'2026-01-02'
}

# No test below can reach a real service, executable, or process stop.
function Invoke-RestMethod { throw 'Unexpected real HTTP call in updater test' }
function Start-Process { throw 'Unexpected real process launch in updater test' }
function Stop-Process { throw 'Unexpected real process stop in updater test' }
function Get-NetTCPConnection { @([pscustomobject]@{ LocalPort = 3847; OwningProcess = 910001 }) }
function Get-CimInstance { $script:cimProcess }
$script:cimProcess = $daemon
Assert ((Get-UpdateDaemon $paths).ProcessId -eq 910001) 'Expected recognized daemon'
$script:cimProcess = [pscustomobject]@{ ProcessId = 910001; ExecutablePath = 'C:\other\daemon.exe' }
Expect-Failure { Get-UpdateDaemon $paths } 'not owned'
$script:cimProcess = $daemon

$ownedCaller = [pscustomobject]@{
    ProcessId = $PID; ParentProcessId = 910001; Name = 'pwsh.exe'
    ExecutablePath = 'C:\external\pwsh.exe'; CreationDate = [datetime]'2026-01-02'
}
Expect-Failure { Assert-ExternalUpdater $paths @($ownedCaller, $daemon, $app) } 'separate Windows Terminal'
Assert-ExternalUpdater $paths @($caller, $daemon, $app)
$reused = [pscustomobject]@{
    ProcessId = $daemon.ProcessId; CreationDate = [datetime]'2026-01-03'; ExecutablePath = $daemon.ExecutablePath
}
Expect-Failure { Assert-SameUpdateProcess $daemon $reused } 'changed'

function Get-UpdateProcesses { @($script:caller, $script:daemon, $script:app) + $script:extraProcesses }
function Get-UpdateDaemon {
    if ($script:listenerGone) { return $null }
    if ($script:replaceDaemon -and $script:builds -gt 0) { return $reused }
    return $script:daemon
}
function Invoke-UpdateApi($Command, $Body, $TimeoutSeconds) {
    $script:actions.Add("api:$Command")
    switch ($Command) {
        'runtime_status' {
            if ($script:badStatus) { return @{ connected = 'true'; acceptingWork = 'true' } }
            return @{ connected = -not $script:drained; acceptingWork = -not $script:drained }
        }
        'list_sessions' { return @(@{ sessionId = 'fixture-session'; isActive = $true }) }
        'queue_items' { return @{ items = @($script:queue); steeringMessages = @() } }
        'reference_section' { return @{ tasks = @($script:tasks) } }
        'prepare_restart' {
            Assert ($Body.force -eq $false) 'Updater must never force'
            if ($script:prepareError) { throw 'Preparation transport failed' }
            if ($script:prepared) { $script:drained = $true }
            return @{ drain = @{ complete = $script:prepared }; checkpointedTerminals = 2 }
        }
        'cancel_drain' { return @{} }
        default { throw "Unexpected endpoint $Command" }
    }
}
function Invoke-UpdateBuild($Program, $Arguments) {
    $script:builds++
    $script:actions.Add("build:$Program $($Arguments -join ' ')")
    if ($script:failBuild -eq $script:builds) { throw 'Fixture build failed' }
}
function Stop-UpdateProcess($Expected) {
    $script:actions.Add("stop:$($Expected.ProcessId)")
    if ($Expected.ProcessId -eq $script:daemon.ProcessId) { $script:listenerGone = $true }
}
function Start-UpdatedDesktop {
    $script:actions.Add('start')
    return @{ HasExited = $false }
}
function Wait-UpdatedDesktop { $script:actions.Add('ready') }
function Reset-Scenario {
    $script:actions = [Collections.Generic.List[string]]::new()
    $script:drained = $false
    $script:listenerGone = $false
    $script:replaceDaemon = $false
    $script:badStatus = $false
    $script:builds = 0
    $script:failBuild = 0
    $script:queue = @()
    $script:tasks = @()
    $script:extraProcesses = @()
    $script:prepared = $true
    $script:prepareError = $false
}
function Assert-NoStops { Assert (-not @($script:actions | Where-Object { $_ -match '^(stop:|start)' }).Count) 'Unexpected process mutation' }

Reset-Scenario
Invoke-DesktopUpdate $FixtureRoot -Check
Assert ($script:builds -eq 0) 'Check-only must not build'
Assert (-not $script:actions.Contains('api:prepare_restart')) 'Check-only must not drain'
Assert-NoStops

Reset-Scenario
$script:queue = @(@{ id = 'queued' })
Expect-Failure { Invoke-DesktopUpdate $FixtureRoot } 'queued messages'
Assert-NoStops
Assert ($script:builds -eq 0) 'Queued work should be detected before build'

Reset-Scenario
$script:tasks = @(@{ id = 'agent'; status = 'running' })
Expect-Failure { Invoke-DesktopUpdate $FixtureRoot } 'background tasks'
Assert-NoStops

Reset-Scenario
$script:extraProcesses = @(
    [pscustomobject]@{ ProcessId = 910010; ParentProcessId = 910001; Name = 'pwsh.exe' }
    [pscustomobject]@{ ProcessId = 910011; ParentProcessId = 910010; Name = 'long-build.exe' }
)
Expect-Failure { Invoke-DesktopUpdate $FixtureRoot } 'child program'
Assert-NoStops

Reset-Scenario
$script:failBuild = 1
Expect-Failure { Invoke-DesktopUpdate $FixtureRoot } 'build failed'
Assert-NoStops
Assert (-not $script:actions.Contains('api:prepare_restart')) 'Failed prebuild must leave runtime alone'

Reset-Scenario
$script:prepared = $false
Expect-Failure { Invoke-DesktopUpdate $FixtureRoot } 'did not drain'
Assert $script:actions.Contains('api:cancel_drain') 'Blocked drain must be cancelled'
Assert-NoStops

Reset-Scenario
$script:prepareError = $true
Expect-Failure { Invoke-DesktopUpdate $FixtureRoot } 'no app/daemon processes were stopped'
Assert-NoStops

Reset-Scenario
$script:replaceDaemon = $true
Expect-Failure { Invoke-DesktopUpdate $FixtureRoot } 'changed'
Assert-NoStops

Reset-Scenario
$script:badStatus = $true
Expect-Failure { Invoke-DesktopUpdate $FixtureRoot } 'invalid runtime status'
Assert-NoStops

Reset-Scenario
$script:failBuild = 3
Expect-Failure { Invoke-DesktopUpdate $FixtureRoot } 'build failed'
Assert (-not $script:actions.Contains('start')) 'Never launch a failed desktop build'

Reset-Scenario
Invoke-DesktopUpdate $FixtureRoot
Assert ($script:builds -eq 3) 'Expected prebuilds and one desktop bundle build'
Assert ($script:actions.IndexOf('api:prepare_restart') -lt $script:actions.IndexOf('stop:910002')) 'Drain before closing UI'
Assert ($script:actions.IndexOf('stop:910001') -lt $script:actions.IndexOf('build:npm.cmd run desktop:build')) 'Stop old daemon before bundling'
Assert ($script:actions[-1] -eq 'ready') 'Verify new runtime readiness'

Reset-Scenario
$script:listenerGone = $true
Invoke-DesktopUpdate $FixtureRoot
Assert (-not $script:actions.Contains('api:prepare_restart')) 'No daemon should require no drain'
Assert ($script:actions[-1] -eq 'ready') 'Cold update should launch successfully'

'Updater safety scenarios passed; no real processes or services were modified.'
