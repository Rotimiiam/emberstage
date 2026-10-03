#requires -Version 5.1
# Native Windows acceptance: test the shipped EXE, never substitute installed scripts.
param([Parameter(Mandatory=$true)][string]$SetupExe,
      [Parameter(Mandatory=$true)][string]$ExpectedSha256,
      [switch]$AllowHeadlessTestAccount)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
}
function Hash([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Snapshot([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return '<absent>' }
    $rows = @(Get-ChildItem -LiteralPath $path -File -Recurse -Force | Sort-Object FullName | ForEach-Object {
        $_.FullName.Substring($path.Length) + '=' + (Hash $_.FullName)
    })
    return ($rows -join "`n")
}
function Json($value) { ConvertTo-Json -InputObject $value -Depth 100 -Compress }

Assert ($env:OS -eq 'Windows_NT') 'Run this acceptance test on native Windows.'
$SetupExe = (Resolve-Path -LiteralPath $SetupExe).Path
Assert ((Hash $SetupExe) -eq $ExpectedSha256.ToLowerInvariant()) 'EXE hash mismatch.'
Assert (@(Get-Process -Name obs64,obs32,obs -ErrorAction SilentlyContinue).Count -eq 0) 'Close OBS first.'
$regKeys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Emberstage_is1',
    'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Emberstage_is1')
foreach ($key in $regKeys) { Assert (-not (Test-Path $key)) 'Existing Emberstage registration; use a clean test Windows account.' }
Assert (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'Emberstage'))) 'Existing default Emberstage installation; use a clean account.'
$realObs = Join-Path $env:APPDATA 'obs-studio'
$realBefore = Snapshot $realObs
$desktopUser = (Get-CimInstance Win32_ComputerSystem).UserName
if ([string]::IsNullOrWhiteSpace($desktopUser)) {
    Assert $AllowHeadlessTestAccount 'Interactive user required unless explicitly testing an isolated headless account.'
    $desktopObs = $realObs
} else {
    $desktopSid = ([Security.Principal.NTAccount]$desktopUser).Translate([Security.Principal.SecurityIdentifier]).Value
    $desktopProfile = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $desktopSid })
    Assert ($desktopProfile.Count -eq 1) 'Cannot resolve unique desktop profile.'
    $desktopObs = Join-Path $desktopProfile[0].LocalPath 'AppData\Roaming\obs-studio'
}
$desktopBefore = Snapshot $desktopObs
$sandbox = Join-Path $env:TEMP ('emberstage-acceptance-' + [Guid]::NewGuid().ToString('N'))
Assert (-not (Test-Path -LiteralPath $sandbox)) 'Sandbox unexpectedly exists.'
$appData = Join-Path $sandbox 'APPDATA'
$localData = Join-Path $sandbox 'LOCALAPPDATA'
$tempData = Join-Path $sandbox 'TEMP'
$appRoot = Join-Path $sandbox 'app-root'
$config = Join-Path $appData 'obs-studio'
$scenePath = Join-Path $config 'basic\scenes\Fixture.json'
$wsPath = Join-Path $config 'plugin_config\obs-websocket\config.json'
$browserPath = Join-Path $config 'plugin_config\obs-browser\fixture.dat'
foreach ($directory in @($appData,$localData,$tempData,(Split-Path $scenePath),(Split-Path $wsPath),(Split-Path $browserPath))) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
Write-Output "EVIDENCE: $sandbox"
$iniPath = Join-Path $config 'user.ini'
$ini = "[Basic]`r`nSceneCollectionFile=Fixture`r`n[BasicWindow]`r`nDockState=fixture-layout`r`nExtraBrowserDocks=[{`"title`":`"Operator dock`",`"url`":`"https://example.invalid/editor`",`"uuid`":`"operator-owned`"}]`r`n[Other]`r`nKeep=true`r`n"
[IO.File]::WriteAllText($iniPath,$ini)
$originalScene = '{"name":"Fixture","current_scene":"Existing","sources":[{"name":"Existing","id":"scene","settings":{"items":[],"id_counter":1000}}],"modules":{"other":{"keep":true},"scripts-tool":[{"path":"D:/Operator/existing.lua","settings":{"enabled":true}}]},"keep":[1,true]}'
[IO.File]::WriteAllText($scenePath,$originalScene)
[IO.File]::WriteAllText($wsPath,'{"server_enabled":false,"fixture":"unchanged"}')
[IO.File]::WriteAllText($browserPath,'synthetic-browser-storage')
$wsBefore = Hash $wsPath
$browserBefore = Hash $browserPath
$originalIniHash = Hash $iniPath
$originalSceneHash = Hash $scenePath

function Run-Isolated([string]$file, [string]$arguments, [string]$label) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $file
    $psi.Arguments = $arguments
    $psi.UseShellExecute = $false
    $psi.EnvironmentVariables['APPDATA'] = $appData
    $psi.EnvironmentVariables['LOCALAPPDATA'] = $localData
    $psi.EnvironmentVariables['TEMP'] = $tempData
    $psi.EnvironmentVariables['TMP'] = $tempData
    $process = [Diagnostics.Process]::Start($psi)
    if (-not $process.WaitForExit(180000)) {
        # Terminate only this test's exact process tree; a timeout is ALWAYS failure.
        & taskkill.exe /PID $process.Id /T /F | Out-Null
        throw "$label timed out; evidence retained. No fallback cleanup was attempted."
    }
    Assert ($process.ExitCode -eq 0) "$label failed with exit $($process.ExitCode); evidence retained."
    Write-Output "PASS $label exit 0"
}

try {
    $installLog = Join-Path $sandbox 'install.log'
    Run-Isolated $SetupExe "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /DIR=`"$appRoot`" /GROUP=`"Emberstage acceptance`" /NOICONS /LOG=`"$installLog`"" 'real EXE install'
    $app = Join-Path $appRoot 'app'
    $manifestPath = Join-Path $app 'install-manifest.json'
    Assert (Test-Path $manifestPath) 'Missing ownership manifest.'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($entry in $manifest.files) {
        Assert ((Hash (Join-Path $app $entry.path)) -eq $entry.sha256) "Installed payload mismatch: $($entry.path)"
    }
    Assert ((Hash (Join-Path $appRoot 'installer\install-media-deck.ps1')) -eq (Hash (Join-Path $app 'scripts\install-media-deck.ps1'))) 'Cleanup script differs from packaged installer.'
    $installedIni = [IO.File]::ReadAllText($iniPath)
    foreach ($title in @('Em - Text','Em - Media','Em - Cameras','Em - Streaming','Operator dock','DockState=fixture-layout')) {
        Assert ($installedIni.Contains($title)) "Missing dock or preserved layout: $title"
    }
    $scene = Get-Content -LiteralPath $scenePath -Raw | ConvertFrom-Json
    Assert (@($scene.modules.'scripts-tool').Count -eq 2) 'Missing Lua registration or unrelated script lost.'
    Assert ($scene.modules.'scripts-tool'[1].settings.enabled -eq $false) 'New Lua entry must be disarmed.'
    Assert ($scene.current_scene -eq 'Existing') 'Active scene changed.'
    Assert (@($scene.sources).Count -eq 5) 'Expected existing scene plus Program, two camera helpers and graphics.'
    $items = @($scene.sources | Where-Object { $_.name -eq 'Existing' })[0].settings.items
    Assert (@($scene.sources | Where-Object { $_.name -eq 'Existing' })[0].settings.id_counter -eq 1001) 'Scene allocation counter not preserved/advanced.'
    Assert (@($items).Count -eq 1) 'Expected one hidden scene item.'
    foreach ($name in @('Emberstage Program','Emberstage Camera A','Emberstage Camera B')) {
        $source = @($scene.sources | Where-Object { $_.name -eq $name })
        Assert ($source.Count -eq 1 -and $source[0].id -eq 'scene') "Missing unique native scene: $name"
    }
    $program = @($scene.sources | Where-Object { $_.name -eq 'Emberstage Program' })[0]
    Assert ($items[0].name -eq $program.name -and $items[0].source_uuid -eq $program.uuid -and -not $items[0].visible -and $items[0].id -gt 1000) 'Program must be attached hidden with a valid identity.'
    Assert (@($program.settings.items).Count -eq 3) 'Program must compose camera A, camera B and graphics.'
    $graphics = @($scene.sources | Where-Object { $_.name -eq 'Emberstage Graphics' })[0]
    Assert ($graphics.id -eq 'browser_source' -and $graphics.settings.shutdown -eq $true) 'Graphics must shut down when hidden.'
    $expectedGraphicsUrl = [Uri]::new((Join-Path $app 'emberstage_output.html')).AbsoluteUri
    Assert ($graphics.settings.url -eq $expectedGraphicsUrl -and -not $graphics.settings.is_local_file) "Wrong graphics URL/origin mode. Expected=$expectedGraphicsUrl Actual=$($graphics.settings.url) Local=$($graphics.settings.is_local_file)"
    $ws = Get-Content -LiteralPath $wsPath -Raw | ConvertFrom-Json
    Assert ($ws.server_enabled -and $ws.auth_required -and $ws.server_password.Length -ge 32) 'Automatic authenticated WebSocket not provisioned.'
    $wsAfterInstall = Hash $wsPath
    $privateScript = Join-Path $appRoot 'Emberstage-private\obs-connection.js'
    Assert (Test-Path $privateScript) 'Private connection script missing.'
    Assert ([IO.File]::ReadAllText($privateScript).Contains($ws.server_password)) 'Private connection script and OBS password differ.'
    Assert (-not [IO.File]::ReadAllText((Join-Path $app 'assets\js\media\native-install.js')).Contains($ws.server_password)) 'Password leaked into public payload.'
    $privateBeforeRepair = Hash $privateScript
    $privateAcl = Get-Acl $privateScript
    Assert ($privateAcl.AreAccessRulesProtected) 'Private credential ACL inherits access.'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert (@($privateAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -ne $sid }).Count -eq 0) 'Private credential ACL has foreign grants.'
    $sourcesBeforeUninstall = Json $scene.sources
    $backups = @(Get-ChildItem -LiteralPath $appData -Directory -Filter 'media-deck-backup-*')
    Assert ($backups.Count -eq 1) 'Expected exactly one install backup.'
    Assert ((Hash (Join-Path $backups[0].FullName 'user.ini')) -eq $originalIniHash) 'INI backup not exact.'
    Assert ((Hash (Join-Path $backups[0].FullName 'basic\scenes\Fixture.json')) -eq $originalSceneHash) 'Scene backup not exact.'
    Write-Output 'PASS payload hashes, native composition, automatic authentication, user-only ACLs and exact backups'

    # Reproduce Repair shortcut parameters exactly, using only packaged tooling.
    $configBeforeRepair = Snapshot $config
    $appBeforeRepair = Snapshot $app
    $repair = Join-Path $app 'scripts\install-media-deck.ps1'
    Run-Isolated 'powershell.exe' "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$repair`" -Apply -Repair -AppInstallPath `"$app`"" 'packaged repair'
    Assert ((Snapshot $config) -eq $configBeforeRepair) 'Repair changed existing configuration.'
    Assert ((Snapshot $app) -eq $appBeforeRepair) 'Repair changed unchanged payload.'
    Assert ((Hash $privateScript) -eq $privateBeforeRepair) 'Repair changed unchanged credentials.'
    Write-Output 'PASS repair idempotence'

    # Simulated operator files/edits must survive the REAL compiled uninstaller.
    $userFile = Join-Path $app 'assets\operator-fixture.txt'
    $modifiedFile = Join-Path $app 'camera_dock.html'
    [IO.File]::WriteAllText($userFile,'operator-added-fixture')
    [IO.File]::AppendAllText($modifiedFile,"`n<!-- operator edit fixture -->")
    $modifiedHash = Hash $modifiedFile
    $uninstaller = Join-Path $appRoot 'installer\unins000.exe'
    $uninstallLog = Join-Path $sandbox 'uninstall.log'
    Run-Isolated $uninstaller "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=`"$uninstallLog`"" 'real EXE uninstall'
    Assert ([IO.File]::ReadAllText($userFile) -eq 'operator-added-fixture') 'Operator file was not preserved.'
    Assert ((Hash $modifiedFile) -eq $modifiedHash) 'Modified program file was not preserved.'
    Assert (-not (Test-Path (Join-Path $app 'control_panel.html'))) 'Unchanged owned file was not removed.'
    foreach ($key in $regKeys) { Assert (-not (Test-Path $key)) 'Uninstall registration remains.' }
    Assert ([IO.File]::ReadAllText($iniPath) -eq $ini) 'Uninstall failed to restore unrelated INI configuration.'
    $afterUninstall = Get-Content -LiteralPath $scenePath -Raw | ConvertFrom-Json
    Assert ((Json $afterUninstall.sources) -eq $sourcesBeforeUninstall) 'Uninstall removed or changed scene/source data.'
    # Source definitions are operator scene data after installation, not removable app files.
    $expectedScene = $originalScene | ConvertFrom-Json
    $expectedScene.sources = $scene.sources
    $expectedScene | Add-Member -NotePropertyName scene_order -NotePropertyValue @(
        [pscustomobject]@{name='Emberstage Program'},
        [pscustomobject]@{name='Emberstage Camera A'},
        [pscustomobject]@{name='Emberstage Camera B'}
    )
    Assert ((Json $afterUninstall) -eq (Json $expectedScene)) 'Uninstall changed unrelated scene/script data.'
    Assert ((Hash $wsPath) -eq $wsAfterInstall) 'Uninstall changed shared OBS WebSocket settings.'
    Assert (-not (Test-Path $privateScript)) 'Uninstall retained the private connection script.'
    Assert ((Hash $browserPath) -eq $browserBefore) 'Browser storage changed.'
    Assert (Test-Path $backups[0].FullName) 'Original backup removed.'
    Assert ((Hash $SetupExe) -eq $ExpectedSha256.ToLowerInvariant()) 'Tested EXE changed.'
    Write-Output 'PASS real uninstall: ownership, modified/user files, registry, config, browser data and backups'
    Write-Output "PASS Windows EXE acceptance SHA256=$ExpectedSha256"
} finally {
    Assert ((Snapshot $realObs) -eq $realBefore) 'Real OBS configuration changed! Preserve evidence and investigate.'
    Assert ((Snapshot $desktopObs) -eq $desktopBefore) 'Desktop user OBS configuration changed! Preserve evidence and investigate.'
    Write-Output 'PASS real OBS configuration unchanged; isolated evidence retained'
}
