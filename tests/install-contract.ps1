#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$installer = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/install-media-deck.ps1'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$passed = 0
$skipped = 0
$tempParent = [IO.Path]::GetTempPath()
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    if ($tempParent.StartsWith('/var/', [StringComparison]::OrdinalIgnoreCase)) {
        $tempParent = '/private' + $tempParent
    }
    elseif ($tempParent.StartsWith('/tmp/', [StringComparison]::OrdinalIgnoreCase)) {
        $tempParent = '/private' + $tempParent
    }
}
if (-not (Test-Path -LiteralPath $tempParent -PathType Container)) { throw 'Temp parent must exist.' }
$suiteRoot = Join-Path $tempParent ('media-deck-install-contract-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($suiteRoot)
$fakeRepo = Join-Path $suiteRoot 'Checkout with spaces # &'
[void][IO.Directory]::CreateDirectory((Join-Path $fakeRepo 'scripts'))
$fixtureInstaller = Join-Path $fakeRepo 'scripts/install-media-deck.ps1'
[IO.File]::Copy($installer, $fixtureInstaller)

$mockObsRunning = $false
function Get-Process {
    param([string[]]$Name, [switch]$ErrorAction)
    if ($mockObsRunning) {
        return @([pscustomobject]@{ Name = 'obs' })
    }
    return @()
}

$APP_FILES_LIST = @(
    'control_panel.html', 'browser_source.html', 'media_dock.html', 'camera_dock.html',
    'video_mixer.html', 'picture_picker.html', 'media_setup.html', 'media_output.html',
    'camera_output.html', 'streaming_dock.html', 'emberstage_output.html', 'scripts/media-deck-hotkeys.lua'
)

foreach ($file in $APP_FILES_LIST) {
    $p = Join-Path $fakeRepo $file
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p))
    [IO.File]::WriteAllText($p, 'fixture only - not executable app content', $utf8)
}

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Test-Case([string]$Name, [scriptblock]$Body) {
    & $Body
    $script:passed++
    Write-Output "PASS $Name"
}
function Write-Fixture([string]$Path, [string]$Text) {
    Assert ($Path -like ($suiteRoot + [IO.Path]::DirectorySeparatorChar + '*')) 'Attempt to write outside isolated fixture root.'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    [IO.File]::WriteAllText($Path, $Text, $utf8)
}
function Read-Fixture([string]$Path) {
    Assert ($Path -like ($suiteRoot + [IO.Path]::DirectorySeparatorChar + '*')) 'Attempt to read real config instead of fixture.'
    return [IO.File]::ReadAllText($Path)
}
function New-Fixture([switch]$WithCollision) {
    $parent = Join-Path $suiteRoot ([guid]::NewGuid().ToString('N'))
    $config = Join-Path $parent 'obs config'
    $iniPath = Join-Path $config 'user.ini'
    $collection = Join-Path $config 'basic/scenes/Selected collection.json'
    $ws = Join-Path $config 'plugin_config/obs-websocket/config.json'
    
    $ini = @'
[General]
FirstRun=true
HotkeyFocusType=NeverDisableHotkeys

[BasicWindow]
PreviewProgramMode=true
DockState=AAAA/wAAAAD9AAAAAg==
ExtraBrowserDocks=[{"title": "Existing operator dock", "url": "C:\\\\Operator Files\\\\panel.html", "uuid": "11111111111111111111111111111111", "unknown": {"keep": [1, true, "verbatim"]}}]
AlwaysOnTop=false

[Basic]
SceneCollection=Operator selected collection
SceneCollectionFile=Selected collection.json

[UnknownPlugin]
Opaque=a\\b\nkeep=this ; comment
'@
    # Normalize newline to CRLF for user.ini
    $ini = $ini.Replace("`r`n", "`n").Replace("`n", "`r`n") + "`r`n"
    Write-Fixture $iniPath $ini
    
    $imgSourceName = if ($WithCollision) { "Emberstage Graphics" } else { "Some Nonbrowser Name" }
    $colJson = '{"name":"Operator selected collection","current_scene":"Existing scene","sources":[{"name":"Keep exactly","id":"image_source","settings":{"file":"D:/Pictures/image.png"}},{"name":"Emberstage Text Output","id":"browser_source","settings":{"url":"http://127.0.0.1:4173/browser_source.html"},"uuid":"uuid-text-1234"},{"name":"Emberstage Media Output","id":"browser_source","settings":{"url":"http://127.0.0.1:4173/media_output.html"},"uuid":"uuid-media-1234"},{"name":"Emberstage Camera Output","id":"browser_source","settings":{"url":"http://127.0.0.1:4173/camera_output.html"},"uuid":"uuid-camera-1234"},{"name":"' + $imgSourceName + '","id":"image_source","settings":{"file":"keep.png"}},{"name":"Existing scene","id":"scene","settings":{"items":[]}}],"scene_order":[{"name":"Existing scene"}],"modules":{"unrelated":{"nested":[1,false,{"keep":"yes"}]},"scripts-tool":[{"path":"D:/Operator Tools/existing.lua","settings":{"custom":"keep","bindings":[{"key":"OBS_KEY_F19"}]}}]},"unknown":{"keep":true}}'
    
    # Create profile and basic.ini
    $profileDir = Join-Path $config 'basic/profiles/Untitled'
    [void][IO.Directory]::CreateDirectory($profileDir)
    $basicIniPath = Join-Path $profileDir 'basic.ini'
    $basicIniContent = "[Video]`r`nBaseCX=2560`r`nBaseCY=1440`r`n"
    Write-Fixture $basicIniPath $basicIniContent

    Write-Fixture $collection $colJson
    Write-Fixture $ws '{"server_enabled":false,"auth_required":false,"server_password":"fixture-only-password","server_port":4457,"unknown":{"keep":true}}'
    return [pscustomobject]@{ Parent = $parent; Config = $config; Ini = $iniPath; Collection = $collection; WebSocket = $ws }
}
function Snapshot($Fixture) {
    $result = @{}
    foreach ($path in @($Fixture.Ini, $Fixture.Collection, $Fixture.WebSocket)) {
        if ([IO.File]::Exists($path)) {
            $result[$path] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
        }
    }
    return $result
}
function Assert-Unchanged($Before) {
    foreach ($path in $Before.Keys) {
        Assert ([IO.File]::Exists($path)) "Fixture disappeared: $path"
        Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -ceq $Before[$path]) "Fixture changed unexpectedly: $path"
    }
}
function Run-Installer($Fixture, [switch]$Apply, [switch]$EnableWebSocket, [string]$AppInstallPath = $null, [switch]$Uninstall, [switch]$Repair) {
    Assert ($Fixture.Config -like ($suiteRoot + [IO.Path]::DirectorySeparatorChar + '*')) 'Never install into real APPDATA during tests.'
    $targetPath = $AppInstallPath
    if ([string]::IsNullOrEmpty($targetPath)) {
        $targetPath = Join-Path $Fixture.Parent 'Emberstage with spaces # &'
    }
    return (& $fixtureInstaller -ObsConfigPath $Fixture.Config -Apply:$Apply -EnableWebSocket:$EnableWebSocket -AppInstallPath $targetPath -Uninstall:$Uninstall -Repair:$Repair *>&1 | Out-String)
}
function Expect-Failure([scriptblock]$Body, [string]$Pattern) {
    $failed = $false
    try { & $Body | Out-Null }
    catch {
        $failed = $true
        Assert ($_.Exception.Message -match $Pattern) "Unexpected failure message: $($_.Exception.Message). Expected: $Pattern"
    }
    Assert $failed "Expected failure matching: $Pattern"
}
function Read-Docks($Fixture) {
    $text = Read-Fixture $Fixture.Ini
    $raw = [regex]::Match($text, '(?m)^ExtraBrowserDocks=([^\r\n]*)').Groups[1].Value
    if ($raw.StartsWith('"')) { $raw = $raw.Substring(1, $raw.Length - 2) }
    $decoded = New-Object Text.StringBuilder
    for ($i = 0; $i -lt $raw.Length; $i++) {
        $char = $raw[$i]
        if ($char -eq '\' -and $i + 1 -lt $raw.Length) {
            $i++
            switch ($raw[$i]) {
                'n' { $char = "`n" }
                'r' { $char = "`r" }
                't' { $char = "`t" }
                default { $char = $raw[$i] }
            }
        }
        [void]$decoded.Append($char)
    }
    $wrapper = ConvertFrom-Json ('{"items":' + $decoded.ToString() + '}')
    return ,$wrapper.items
}
function Json($Value) { return ConvertTo-Json -InputObject $Value -Depth 100 -Compress }

try {
    Test-Case 'PowerShell AST and safe script-relative paths' {
        $tokens = $null; $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
        Assert ($parseErrors.Count -eq 0) ('Installer AST errors: ' + ($parseErrors | Out-String))
        $source = [IO.File]::ReadAllText($installer)
        Assert ($source.Contains('$PSScriptRoot')) 'Repository path is not script-relative.'
        Assert ($source -notmatch 'C:\\Users\\|camera1|Bib2|Untitled') 'Hardcoded machine/customer/default names found.'
        $forbidden = $ast.FindAll({ param($node)
            $node -is [Management.Automation.Language.CommandAst] -and
            $node.GetCommandName() -in @('Stop-Process', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Install-Module', 'Set-NetFirewallProfile', 'New-NetFirewallRule')
        }, $true)
        Assert ($forbidden.Count -eq 0) 'Installer may launch/stop processes or touch network/dependencies.'
        $testTokens = $null; $testErrors = $null
        [void][Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$testTokens, [ref]$testErrors)
        Assert ($testErrors.Count -eq 0) 'Test AST errors.'
    }
    Test-Case 'default dry run leaves all fixture bytes and backup directories unchanged' {
        $f = New-Fixture; $before = Snapshot $f
        $output = Run-Installer $f
        Assert ($output -match 'DRY RUN' -and $output -match 'No files or backups written') 'Dry-run plan missing.'
        Assert-Unchanged $before
        Assert ([IO.Directory]::GetDirectories($f.Parent).Length -eq 1) 'Dry run created a backup.'
    }
    Test-Case 'current-style escaped INI fixture decodes existing Windows file path' {
        $f = New-Fixture
        $docks = Read-Docks $f
        Assert ($docks.Count -eq 1 -and $docks[0].url -ceq 'C:\Operator Files\panel.html') 'Current INI escape fixture does not roundtrip.'
    }
    Test-Case 'malformed JSON/INI, unsafe or missing collection, and incomplete checkout refuse untouched' {
        foreach ($kind in @('docks', 'collection', 'websocket', 'duplicate-ini', 'traversal', 'absolute', 'missing-selection', 'missing-file', 'bad-modules')) {
            $f = New-Fixture
            switch ($kind) {
                'docks' { Write-Fixture $f.Ini ((Read-Fixture $f.Ini).Replace('ExtraBrowserDocks=[', 'ExtraBrowserDocks=[BROKEN')) }
                'collection' { Write-Fixture $f.Collection '{not-json' }
                'websocket' { Write-Fixture $f.WebSocket '{not-json' }
                'duplicate-ini' { Write-Fixture $f.Ini ((Read-Fixture $f.Ini) + "[Basic]`r`nSceneCollectionFile=elsewhere`r`n") }
                'traversal' { Write-Fixture $f.Ini ((Read-Fixture $f.Ini).Replace('Selected collection.json', '../elsewhere.json')) }
                'absolute' { Write-Fixture $f.Ini ((Read-Fixture $f.Ini).Replace('Selected collection.json', 'C:/elsewhere.json')) }
                'missing-selection' { Write-Fixture $f.Ini ((Read-Fixture $f.Ini).Replace('SceneCollectionFile=', 'UnrelatedKey=')) }
                'missing-file' { Write-Fixture $f.Ini ((Read-Fixture $f.Ini).Replace('Selected collection.json', 'Absent.json')) }
                'bad-modules' { Write-Fixture $f.Collection '{"modules":[]}' }
            }
            $before = Snapshot $f
            Expect-Failure { Run-Installer $f -EnableWebSocket } 'Invalid JSON|Ambiguous INI|Unsafe SceneCollectionFile|Missing \[Basic\]|missing|must be a JSON object'
            Assert-Unchanged $before
            Assert ([IO.Directory]::GetDirectories($f.Parent).Length -eq 1) 'Failed parse made a backup.'
        }
        $f = New-Fixture; $before = Snapshot $f
        $required = Join-Path $fakeRepo 'emberstage_output.html'
        [IO.File]::Move($required, $required + '.hold')
        try { Expect-Failure { Run-Installer $f } 'Required app file missing' }
        finally { [IO.File]::Move($required + '.hold', $required) }
        Assert-Unchanged $before
    }

    Test-Case 'real OBS process causes apply refusal without stopping it' {
        $mockObsRunning = $true
        $f = New-Fixture; $before = Snapshot $f
        Expect-Failure { Run-Installer $f -Apply } 'OBS is running'
        Assert-Unchanged $before
        $mockObsRunning = $false
    }

    Test-Case 'apply adds four Emberstage docks and Lua while preserving unrelated config and exact backup bytes' {
            $f = New-Fixture; $before = Snapshot $f
            $oldIni = Read-Fixture $f.Ini
            $oldCollection = ConvertFrom-Json (Read-Fixture $f.Collection)
            $oldDock = (Read-Docks $f)[0]
            $output = Run-Installer $f -Apply
            $docks = Read-Docks $f
            Assert ($docks.Count -eq 5) 'Expected one existing and four app docks.'
            Assert ((Json $docks[0]) -ceq (Json $oldDock)) 'Existing dock content changed.'
            $oldRest = [regex]::Replace($oldIni, '(?m)^ExtraBrowserDocks=[^\r\n]*', 'ExtraBrowserDocks=<ignored>')
            $newRest = [regex]::Replace((Read-Fixture $f.Ini), '(?m)^ExtraBrowserDocks=[^\r\n]*', 'ExtraBrowserDocks=<ignored>')
            Assert ($oldRest -ceq $newRest) 'Unrelated INI lines/layout changed.'
            $current = ConvertFrom-Json (Read-Fixture $f.Collection)
            $graphics = @($current.sources | Where-Object { $_.name -eq 'Emberstage Graphics' })[0]
            $graphicsPath = ([uri]$graphics.settings.url).LocalPath
            Assert ([IO.File]::Exists($graphicsPath)) 'Graphics URL points to a missing installed output page.'
            foreach ($file in $APP_FILES_LIST) {
                $installed = Join-Path (Join-Path $f.Parent 'Emberstage with spaces # &') $file
                Assert ([IO.File]::Exists($installed)) "Installed payload missing: $file"
                Assert ((Read-Fixture $installed) -ceq (Read-Fixture (Join-Path $fakeRepo $file))) "Installed payload differs: $file"
            }
            Assert ($current.scene_order.Count -eq ($oldCollection.scene_order.Count + 3)) 'Expected new scenes to be added to scene_order.'
            $addedSceneNames = $current.scene_order | ForEach-Object { $_.name }
            Assert ('Emberstage Program' -in $addedSceneNames) 'Emberstage Program missing in scene_order.'
            Assert ('Emberstage Camera A' -in $addedSceneNames) 'Emberstage Camera A missing in scene_order.'
            Assert ('Emberstage Camera B' -in $addedSceneNames) 'Emberstage Camera B missing in scene_order.'
            Assert ((Json $current.modules.unrelated) -ceq (Json $oldCollection.modules.unrelated)) 'Other modules changed.'
            Assert ((Json $current.modules.'scripts-tool'[0]) -ceq (Json $oldCollection.modules.'scripts-tool'[0])) 'Existing Lua settings changed.'
            Assert ($current.modules.'scripts-tool'.Count -eq 2) 'Lua script missing or duplicated.'
            $lua = $current.modules.'scripts-tool'[1]
            Assert ($lua.settings.output_scene -ceq '' -and -not $lua.settings.enabled -and -not $lua.settings.exclusive_video -and -not $lua.settings.exclusive_picture) 'Unsafe initial Lua defaults.'
            Assert ($lua.settings.PSObject.Properties.Name.Count -eq 4) 'Unexpected Lua settings/default bindings.'
            $automaticWs = ConvertFrom-Json (Read-Fixture $f.WebSocket)
            Assert ($automaticWs.server_enabled -and $automaticWs.auth_required -and $automaticWs.server_password -ceq 'fixture-only-password') 'Default install must provision authenticated automatic access without rotating the password.'
            $backups = @([IO.Directory]::GetDirectories($f.Parent, 'media-deck-backup-*'))
            Assert ($backups.Count -eq 1 -and $output.Contains($backups[0])) 'Backup path was not reported.'
            $manifest = ConvertFrom-Json (Read-Fixture (Join-Path $backups[0] 'manifest.json'))
            Assert ($manifest.files.Count -eq 3) 'Expected backups for docks, collection and WebSocket config.'
            foreach ($entry in $manifest.files) {
                Assert $entry.existed 'Existing config not marked in manifest.'
                $originalPath = Join-Path $f.Config $entry.relativePath
                Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $backups[0] $entry.relativePath))) -ceq $before[$originalPath]) 'Backup differs from exact original bytes.'
            }
            $bytes = [IO.File]::ReadAllBytes($f.Collection)
            Assert ($bytes[0] -eq 123) 'Collection JSON is not UTF-8 without BOM.'
            $ours = @($docks | Where-Object { $_.uuid -ne $oldDock.uuid })
            Assert (@($ours.uuid | Select-Object -Unique).Count -eq 4) 'Dock UUIDs are not distinct.'
            foreach ($dock in $ours) {
                Assert ($dock.url.StartsWith('file:///') -and $dock.url.Contains('%20') -and $dock.url.Contains('%23')) "File URL is '$($dock.url)'. File URL did not escape spaces/hash."
                Assert ([IO.Path]::GetFullPath(([uri]$dock.url).LocalPath).StartsWith([IO.Path]::GetFullPath((Join-Path $f.Parent 'Emberstage with spaces # &')))) 'URL is not checkout-relative.'
            }
            Assert (@($ours | Where-Object { $_.url.EndsWith('control_panel.html') -and $_.title -ceq 'Em - Text' }).Count -eq 1) 'Text dock URL missing.'
            Assert (@($ours | Where-Object { $_.url.EndsWith('media_dock.html') -and $_.title -ceq 'Em - Media' }).Count -eq 1) 'Media dock URL missing.'
            Assert (@($ours | Where-Object { $_.url.EndsWith('camera_dock.html') -and $_.title -ceq 'Em - Cameras' }).Count -eq 1) 'Cameras dock URL missing.'
            Assert (@($ours | Where-Object { $_.url.EndsWith('streaming_dock.html') -and $_.title -ceq 'Em - Streaming' }).Count -eq 1) 'Streaming dock URL missing.'
        }
        Test-Case 'upgrade removes only owned Setup dock and preserves customer namesakes' {
            $f = New-Fixture
            $namesake = [pscustomobject]@{ uuid = 'customer-setup'; title = 'Emberstage - Setup'; url = 'https://example.test/setup' }
            $docks = @((Read-Docks $f)) + @($namesake, [pscustomobject]@{ uuid = '4d4445434b534554555000000000000005'; title = 'Renamed old setup'; url = 'file:///old/media_setup.html' })
            $newLine = 'ExtraBrowserDocks=' + (Json $docks).Replace('\', '\\')
            $newIni = [regex]::Replace((Read-Fixture $f.Ini), '(?m)^ExtraBrowserDocks=[^\r\n]*', [Text.RegularExpressions.MatchEvaluator]{ param($m) $newLine })
            Write-Fixture $f.Ini $newIni
            [void](Run-Installer $f -Apply)
            $updated = Read-Docks $f
            Assert (@($updated | Where-Object { $_.uuid -eq '4d4445434b534554555000000000000005' }).Count -eq 0) 'Retired Setup dock remains.'
            Assert ((Json ($updated | Where-Object { $_.uuid -eq 'customer-setup' })) -ceq (Json $namesake)) 'Customer namesake changed.'
            Assert ($updated.Count -eq 6) 'Expected two customer docks and four app docks.'
            $before = Snapshot $f
            [void](Run-Installer $f -Apply)
            Assert-Unchanged $before
        }
        Test-Case 'second apply is byte-idempotent and retains customized Lua settings' {
            $f = New-Fixture; [void](Run-Installer $f -Apply)
            $before = Snapshot $f
            $output = Run-Installer $f -Apply
            Assert-Unchanged $before
            Assert ($output -match 'No changes needed') 'Second apply not a no-op.'
            Assert ([IO.Directory]::GetDirectories($f.Parent, 'media-deck-backup-*').Length -eq 1) 'No-op created another backup.'
            $data = ConvertFrom-Json (Read-Fixture $f.Collection)
            $data.modules.'scripts-tool'[1].settings.output_scene = 'Operator choice'
            $data.modules.'scripts-tool'[1].settings.enabled = $true
            $data.modules.'scripts-tool'[1].settings | Add-Member NoteProperty custom 'preserved'
            Write-Fixture $f.Collection (Json $data)
            $before = Snapshot $f; [void](Run-Installer $f -Apply); Assert-Unchanged $before
        }
        Test-Case 'migrates one existing Emberstage Lua path and preserves its settings' {
            $f = New-Fixture; [void](Run-Installer $f -Apply)
            $data = ConvertFrom-Json (Read-Fixture $f.Collection)
            $lua = $data.modules.'scripts-tool'[1]
            $lua.path = '/Users/operator/Library/Application Support/Emberstage/scripts/media-deck-hotkeys.lua'
            $lua.settings.output_scene = 'Keep this scene'
            $lua.settings.enabled = $true
            $lua.settings | Add-Member NoteProperty custom 'keep this value'
            Write-Fixture $f.Collection (Json $data)
            $before = Snapshot $f
            $dryRunOutput = Run-Installer $f
            Assert ($dryRunOutput -match 'Repoint the existing Emberstage Lua entry') 'Lua migration was not included in the dry-run plan.'
            Assert-Unchanged $before
            [void](Run-Installer $f -Apply)
            $updated = ConvertFrom-Json (Read-Fixture $f.Collection)
            Assert ($updated.modules.'scripts-tool'.Count -eq 2) 'Lua migration duplicated or removed a script entry.'
            $updatedLua = $updated.modules.'scripts-tool'[1]
            Assert (([IO.Path]::GetFullPath($updatedLua.path.Replace('/', [IO.Path]::DirectorySeparatorChar))) -eq ([IO.Path]::GetFullPath((Join-Path $f.Parent 'Emberstage with spaces # &/scripts/media-deck-hotkeys.lua')))) 'Lua path was not migrated to this installation.'
            Assert ($updatedLua.settings.output_scene -ceq 'Keep this scene' -and $updatedLua.settings.enabled -eq $true -and $updatedLua.settings.custom -ceq 'keep this value') 'Lua migration changed existing settings.'
        }
        Test-Case 'updates only app-owned dock title/URL, preserving same-title operator docks and unknown fields' {
            $f = New-Fixture; [void](Run-Installer $f -Apply)
            $docks = Read-Docks $f
            $docks[0].title = 'Em - Text'
            $docks[1].title = 'Emberstage - Text'
            $docks[1].url = 'file:///D:/Moved%20checkout/control_panel.html'
            $docks[1] | Add-Member NoteProperty custom 'keep app dock metadata'
            $encoded = (Json $docks).Replace('\', '\\')
            $ini = [regex]::Replace((Read-Fixture $f.Ini), '(?m)^ExtraBrowserDocks=[^\r\n]*', [Text.RegularExpressions.MatchEvaluator]{ param($m) 'ExtraBrowserDocks=' + $encoded })
            Write-Fixture $f.Ini $ini
            $collectionBefore = Read-Fixture $f.Collection
            [void](Run-Installer $f -Apply)
            $after = Read-Docks $f
            Assert ($after.Count -eq 5 -and (Json $after[0]) -ceq (Json $docks[0])) 'Same-title unrelated dock was changed or removed.'
            Assert ($after[1].uuid -ceq $docks[1].uuid -and $after[1].title -ceq 'Em - Text') 'Stable app UUID was not updated.'
            Assert ([IO.Path]::GetFullPath(([uri]$after[1].url).LocalPath).StartsWith([IO.Path]::GetFullPath((Join-Path $f.Parent 'Emberstage with spaces # &'))) -and $after[1].custom -ceq 'keep app dock metadata') 'App dock URL/metadata not preserved correctly.'
            Assert ((Read-Fixture $f.Collection) -ceq $collectionBefore) 'Dock update rewrote Lua configuration.'
        }
        Test-Case 'automatic WebSocket setup preserves password/unknown keys and never prints credentials' {
            $f = New-Fixture
            $output = Run-Installer $f -Apply -EnableWebSocket
            $ws = ConvertFrom-Json (Read-Fixture $f.WebSocket)
            Assert ($ws.server_enabled -eq $true -and $ws.auth_required -eq $true) 'WebSocket is not authenticated.'
            Assert ($ws.server_password -ceq 'fixture-only-password' -and $ws.server_port -eq 4457 -and $ws.unknown.keep) 'Existing WebSocket config was not preserved.'
            Assert (-not $output.Contains($ws.server_password)) 'Password leaked in output.'
            $before = Snapshot $f; [void](Run-Installer $f -Apply -EnableWebSocket); Assert-Unchanged $before
        }
        Test-Case 'empty/new WebSocket password is generated only on apply and never printed' {
            $f = New-Fixture
            [IO.File]::Delete($f.WebSocket)
            $output = Run-Installer $f -EnableWebSocket
            Assert (-not [IO.File]::Exists($f.WebSocket)) 'Dry run created WebSocket config.'
            $output += Run-Installer $f -Apply -EnableWebSocket
            $ws = ConvertFrom-Json (Read-Fixture $f.WebSocket)
            Assert ([Convert]::FromBase64String($ws.server_password).Length -eq 32) 'New password is not 256 random bits.'
            Assert (-not $output.Contains($ws.server_password)) 'Generated password leaked.'
            Assert ([IO.File]::ReadAllBytes($f.WebSocket)[0] -eq 123) 'WebSocket JSON has BOM.'
            $backup = [IO.Directory]::GetDirectories($f.Parent, 'media-deck-backup-*')[0]
            $manifest = ConvertFrom-Json (Read-Fixture (Join-Path $backup 'manifest.json'))
            Assert (@($manifest.files | Where-Object { $_.relativePath -eq 'plugin_config/obs-websocket/config.json' -and -not $_.existed }).Count -eq 1) 'New WebSocket config missing rollback removal marker.'
            $f = New-Fixture
            Write-Fixture $f.WebSocket '{"server_password":"","server_port":4461,"custom":"keep"}'
            $output = Run-Installer $f -Apply -EnableWebSocket
            $ws = ConvertFrom-Json (Read-Fixture $f.WebSocket)
            Assert ([Convert]::FromBase64String($ws.server_password).Length -eq 32 -and $ws.server_port -eq 4461 -and $ws.custom -ceq 'keep') 'Empty-password update lost unknown fields or did not generate a password.'
            Assert (-not $output.Contains($ws.server_password)) 'Password generated for empty setting leaked.'
        }
        Test-Case 'malformed WebSocket config fails closed' {
            $f = New-Fixture; Write-Fixture $f.WebSocket 'not-json'
            Expect-Failure { Run-Installer $f -Apply } 'Invalid JSON|WebSocket config is malformed'
        }
        Test-Case 'private connection script generation, file:// injection, secure permissions, and uninstall' {
            $f = New-Fixture
            $appDirMock = Join-Path $f.Parent 'Emberstage'
            [void][IO.Directory]::CreateDirectory($appDirMock)
            
            # Run the installer with apply
            [void](Run-Installer $f -Apply -AppInstallPath $appDirMock)
            
            $appParent = $f.Parent
            $privateDir = Join-Path $appParent 'Emberstage-private'
            $privateScript = Join-Path $privateDir 'obs-connection.js'
            
            # 1. Assert they exist
            Assert (Test-Path -LiteralPath $privateDir -PathType Container) "Private sibling directory was not created."
            Assert (Test-Path -LiteralPath $privateScript -PathType Leaf) "Private connection script was not created."
            
            # 2. Verify permissions/DACL on Windows
            if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
                $acl = Get-Acl $privateScript
                Assert ($acl.AreAccessRulesProtected -eq $true) "Private script should have inheritance disabled."
                $dirAcl = Get-Acl $privateDir
                Assert ($dirAcl.AreAccessRulesProtected -eq $true) "Private directory should have inheritance disabled."
            }
            
            # 3. Verify content of private script
            $content = [IO.File]::ReadAllText($privateScript)
            Assert ($content -like '*window.EmberstageNativeConnection*') "Private script lacks window.EmberstageNativeConnection definition"
            Assert ($content -like '*fixture-only-password*') "Private script lacks correct password"
            Assert ($content -like '*4457*') "Private script lacks correct port"
            
            # 4. Verify generated native-install.js has correct file:// URI
            $jsFile = Join-Path $appDirMock 'assets/js/media/native-install.js'
            Assert (Test-Path -LiteralPath $jsFile -PathType Leaf) "native-install.js should be written"
            $jsContent = [IO.File]::ReadAllText($jsFile)
            Assert ($jsContent -like '*connectionScript*') "native-install.js lacks connectionScript key"
            
            $privateScriptUri = [System.Uri]::new([IO.Path]::GetFullPath($privateScript), [UriKind]::Absolute).AbsoluteUri
            Assert ($jsContent -like "*$($privateScriptUri.Replace('\', '\\'))*") "native-install.js has incorrect connectionScript URI"
            
            # 5. Verify uninstall removes them!
            [void](Run-Installer $f -Uninstall -Apply -AppInstallPath $appDirMock)
            Assert (-not (Test-Path -LiteralPath $privateScript)) "Private script was not removed on uninstall."
            Assert (-not (Test-Path -LiteralPath $privateDir)) "Private directory was not removed on uninstall."
        }
        Test-Case 'outer-quoted Qt JSON and extensionless collection name roundtrip' {
            $f = New-Fixture
            $ini = Read-Fixture $f.Ini
            $json = Json @((Read-Docks $f))
            $qtValue = '"' + $json.Replace('\', '\\').Replace('"', '\"') + '"'
            $ini = [regex]::Replace($ini, '(?m)^ExtraBrowserDocks=[^\r\n]*', [Text.RegularExpressions.MatchEvaluator]{ param($m) 'ExtraBrowserDocks=' + $qtValue })
            $ini = $ini.Replace('SceneCollectionFile=Selected collection.json', 'SceneCollectionFile=Selected collection')
            Write-Fixture $f.Ini $ini
            $before = (Read-Docks $f)[0]
            [void](Run-Installer $f -Apply)
            Assert ((Json (Read-Docks $f)[0]) -ceq (Json $before)) 'Qt-escaped existing dock changed.'
        }
        Test-Case 'repoints exact-named browser sources safely and preserves others' {
            $f = New-Fixture
            $customCollection = [pscustomobject]@{
                name = 'Operator selected collection'
                current_scene = 'Existing scene'
                sources = @(
                    [pscustomobject]@{
                        name = 'Emberstage Text Output'
                        id = 'browser_source'
                        settings = [pscustomobject]@{
                            is_local_file = $false
                            url = 'https://example.com'
                            custom_key = 'preserve-me'
                        }
                    },
                    [pscustomobject]@{
                        name = 'Emberstage Media Output'
                        id = 'browser_source'
                        settings = [pscustomobject]@{
                            is_local_file = $false
                            url = 'https://example.com'
                        }
                    },
                    [pscustomobject]@{
                        name = 'Emberstage Camera Output'
                        id = 'browser_source'
                    },
                    [pscustomobject]@{
                        name = 'Some Other Text Output'
                        id = 'image_source'
                        settings = [pscustomobject]@{
                            file = 'D:/Pictures/image.png'
                        }
                    },
                    [pscustomobject]@{
                        name = 'Some Other Source'
                        id = 'browser_source'
                        settings = [pscustomobject]@{
                            url = 'https://other.com'
                        }
                    },
                    [pscustomobject]@{
                        name = 'Existing scene'
                        id = 'scene'
                        settings = [pscustomobject]@{
                            items = @()
                        }
                    }
                )
                scene_order = @(
                    [pscustomobject]@{ name = 'Existing scene' }
                )
                modules = [pscustomobject]@{
                    unrelated = [pscustomobject]@{ nested = @(1, $false, [pscustomobject]@{ keep = 'yes' }) }
                    'scripts-tool' = @(
                        [pscustomobject]@{
                            path = 'D:/Operator Tools/existing.lua'
                            settings = [pscustomobject]@{
                                custom = 'keep'
                                bindings = @(
                                    [pscustomobject]@{ key = 'OBS_KEY_F19' }
                                )
                            }
                        }
                    )
                }
                unknown = $true
            }
            Write-Fixture $f.Collection (Json $customCollection)
            
            $before = Snapshot $f
            $dryRunOutput = Run-Installer $f
            Assert ($dryRunOutput -match 'DRY RUN') 'Dry run should print DRY RUN.'
            Assert ($dryRunOutput -match 'Create native Emberstage program') 'Dry run output should include the planning message.'
            Assert-Unchanged $before
            
            $applyOutput = Run-Installer $f -Apply
            Assert ($applyOutput -match 'APPLY') 'Apply should print APPLY.'
            
            $updatedCollection = ConvertFrom-Json (Read-Fixture $f.Collection)
            
            # Legacy sources must be retained byte-unchanged:
            $textOutput = @($updatedCollection.sources | Where-Object { $_.name -eq 'Emberstage Text Output' })[0]
            Assert ($textOutput.settings.url -eq 'https://example.com') 'Legacy url modified'
            
            $mediaOutput = @($updatedCollection.sources | Where-Object { $_.name -eq 'Emberstage Media Output' })[0]
            Assert ($mediaOutput.settings.url -eq 'https://example.com') 'Legacy url modified'
            
            $unrelatedIdOutput = @($updatedCollection.sources | Where-Object { $_.name -eq 'Some Other Text Output' })[0]
            Assert ($unrelatedIdOutput.id -eq 'image_source') 'Wrong source affected.'
            Assert ($unrelatedIdOutput.settings.file -eq 'D:/Pictures/image.png') 'Unmutated source settings modified.'
            
            $unrelatedNameOutput = @($updatedCollection.sources | Where-Object { $_.name -eq 'Some Other Source' })[0]
            Assert ($unrelatedNameOutput.id -eq 'browser_source') 'Wrong source affected.'
            Assert ($unrelatedNameOutput.settings.url -eq 'https://other.com') 'Unmutated source settings modified.'
            
            $beforeSecond = Snapshot $f
            $secondOutput = Run-Installer $f -Apply
            Assert-Unchanged $beforeSecond
            Assert ($secondOutput -match 'No changes needed') 'Second apply should be no-op.'
        }
        Test-Case 'uninstall removes owned docks and script registration from all known collections' {
            $f = New-Fixture
            # Register Lua script in an additional inactive collection
            $otherCollection = Join-Path $f.Config 'basic/scenes/Other collection.json'
            Write-Fixture $otherCollection '{"name":"Other collection","modules":{"scripts-tool":[{"path":"D:/Emberstage/scripts/media-deck-hotkeys.lua","settings":{}},{"path":"D:/Operator Tools/existing.lua","settings":{}}]}}'
            
            # First, install
            [void](Run-Installer $f -Apply)
            
            # Update additional collection to point to the correct install path for test
            $appDirMock = Join-Path $f.Parent 'Emberstage with spaces # &'
            $correctScriptPath = (Join-Path $appDirMock 'scripts/media-deck-hotkeys.lua').Replace('\', '/')
            Write-Fixture $otherCollection "{`"name`":`"Other collection`",`"modules`":{`"scripts-tool`":[{`"path`":`"$correctScriptPath`",`"settings`":{}},{`"path`":`"D:/Operator Tools/existing.lua`",`"settings`":{}}]}}"
            
            # Dry run uninstall
            $dryOutput = Run-Installer $f -Uninstall
            Assert ($dryOutput -match 'Uninstall planned') 'Dry run uninstall should display plan.'
            
            # Execute actual uninstall
            $output = Run-Installer $f -Uninstall -Apply
            Assert ($output -match 'Uninstall complete') 'Uninstall should succeed.'
            
            # Verify active collection docks & scripts removed
            $docks = Read-Docks $f
            Assert ($docks.Count -eq 1 -and $docks[0].title -eq 'Existing operator dock') 'Docks not cleaned up correctly.'
            $col1 = ConvertFrom-Json (Read-Fixture $f.Collection)
            Assert ($col1.modules.'scripts-tool'.Count -eq 1) 'Active collection Lua script was not removed.'
            
            # Verify other (inactive) collection Lua script removed!
            $col2 = ConvertFrom-Json (Read-Fixture $otherCollection)
            Assert ($col2.modules.'scripts-tool'.Count -eq 1) 'Other collection Lua script was not removed.'
            Assert ($col2.modules.'scripts-tool'[0].path -eq 'D:/Operator Tools/existing.lua') 'Other script corrupted.'
        }
        Test-Case 'uninstall rollback works on config write failure and keeps owned files' {
            if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { $script:skipped++; Write-Output 'SKIP Windows file-lock rollback scenario on non-Windows host'; return }
            $f = New-Fixture
            [void](Run-Installer $f -Apply)
            $appDirMock = Join-Path $f.Parent 'Emberstage with spaces # &'
            Assert ([IO.File]::Exists((Join-Path $appDirMock 'control_panel.html'))) 'Installed app file missing.'
            
            $before = Snapshot $f
            # Lock active collection to trigger failure during uninstall write phase
            $lock = [IO.File]::Open($f.Collection, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                Expect-Failure { Run-Installer $f -Uninstall -Apply } 'failed; rollback'
            } finally {
                $lock.Dispose()
            }
            # Verify config rollback
            Assert-Unchanged $before
            # Verify owned files are restored from previous-app backup
            Assert ([IO.File]::Exists((Join-Path $appDirMock 'control_panel.html'))) 'Owned files were not restored during rollback.'
        }
        Test-Case 'AppInstallPath validation prevents root, overlapping, and symlink targets' {
            $f = New-Fixture
            # Overlap with repo root
            Expect-Failure { Run-Installer $f -AppInstallPath $fakeRepo -Apply } 'cannot overlap'
            # Overlap with config root
            Expect-Failure { Run-Installer $f -AppInstallPath $f.Config -Apply } 'cannot overlap'
            # Root directory
            $root = [IO.Path]::GetPathRoot($f.Parent)
            Expect-Failure { Run-Installer $f -AppInstallPath $root -Apply } 'cannot be the root'
        }
        Test-Case 'unowned nested files and user-modified files are completely preserved' {
            $f = New-Fixture
            $appDirMock = Join-Path $f.Parent 'Emberstage with spaces # &'
            [void](Run-Installer $f -Apply)
            
            # 1. Place an unowned user nested file
            $userFile = Join-Path $appDirMock 'assets/user_picture.png'
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($userFile))
            [IO.File]::WriteAllText($userFile, 'my custom image')
            
            # 2. Modify an owned file
            $ownedModified = Join-Path $appDirMock 'media_dock.html'
            [IO.File]::WriteAllText($ownedModified, 'user modified content')
            
            # 3. Upgrade/repair - should preserve userFile and user-modified file
            [void](Run-Installer $f -Repair -Apply)
            Assert ([IO.File]::Exists($userFile) -and (Read-Fixture $userFile) -eq 'my custom image') 'Unowned nested file was deleted or changed during upgrade/repair.'
            
            # 4. Uninstall - should preserve both userFile and the modified owned file!
            [void](Run-Installer $f -Uninstall -Apply)
            Assert ([IO.File]::Exists($userFile) -and (Read-Fixture $userFile) -eq 'my custom image') 'Unowned nested file was deleted during uninstall.'
            Assert ([IO.File]::Exists($ownedModified) -and (Read-Fixture $ownedModified) -eq 'user modified content') 'User modified owned file was deleted during uninstall.'
            
            # Clean up of unmodified files should still happen
            Assert (-not [IO.File]::Exists((Join-Path $appDirMock 'control_panel.html'))) 'Unmodified owned file was not uninstalled.'
        }
        Test-Case 'creates missing browser sources and hidden scene items' {
            $f = New-Fixture
            $collection = ConvertFrom-Json (Read-Fixture $f.Collection)
            # Remove existing native sources to force creation
            $sourcesList = New-Object 'System.Collections.Generic.List[object]'
            foreach ($s in $collection.sources) {
                if ($s.name -notin @('Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B', 'Emberstage Graphics')) {
                    $sourcesList.Add($s)
                }
            }
            $collection.sources = @($sourcesList.ToArray())
            $fixtureScene = @($collection.sources | Where-Object { $_.id -eq 'scene' })[0]
            $fixtureScene.settings | Add-Member -NotePropertyName id_counter -NotePropertyValue 1000 -Force
            Write-Fixture $f.Collection (Json $collection)
            
            [void](Run-Installer $f -Apply)
            
            $collection = ConvertFrom-Json (Read-Fixture $f.Collection)
            $sourcesMap = @{}
            foreach ($s in $collection.sources) {
                if ($s.name -in @('Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B', 'Emberstage Graphics')) {
                    $sourcesMap[$s.name] = $s
                }
            }
            Assert ($sourcesMap.Count -eq 4) 'Expected 4 native sources created.'
            
            $graphics = $sourcesMap['Emberstage Graphics']
            Assert ($graphics.settings.shutdown -eq $true) 'Browser graphics must shut down.'
            Assert ($graphics.id -eq 'browser_source') 'Must be browser_source'
            Assert ($graphics.settings.width -eq 2560) 'width 2560'
            Assert ($graphics.settings.height -eq 1440) 'height 1440'
            
            $cameraA = $sourcesMap['Emberstage Camera A']
            Assert ($cameraA.settings.items.Count -eq 0) 'Camera A must start empty.'

            $program = $sourcesMap['Emberstage Program']
            $pItems = $program.settings.items
            Assert ($pItems.Count -eq 3) 'Expected 3 items inside program.'
            Assert ($pItems[0].name -eq 'Emberstage Camera A') 'Bottom item must be Camera A'
            Assert ($pItems[1].name -eq 'Emberstage Camera B') 'Middle item must be Camera B'
            Assert ($pItems[2].name -eq 'Emberstage Graphics') 'Top item must be Graphics'
            
            $sceneObjs = @($collection.sources | Where-Object { $_.id -eq 'scene' -and $_.name -eq "Existing scene" })
            Assert ($sceneObjs.Count -eq 1) 'Exactly one scene object'
            $sceneItems = $sceneObjs[0].settings.items
            Assert ($sceneObjs[0].settings.id_counter -eq 1001) 'Scene counter must advance from saved value'
            Assert ($null -eq $collection.PSObject.Properties['id_counter']) 'Do not create collection-level counter'
            
            $itemMap = @{}
            foreach ($item in $sceneItems) {
                if ($item.name -eq 'Emberstage Program') {
                    $itemMap[$item.name] = $item
                }
            }
            Assert ($itemMap.Count -eq 1) 'Emberstage Program added to scene items'
            $item = $itemMap['Emberstage Program']
            Assert ($item.visible -eq $false) "Emberstage Program item must be hidden"
            
            # Repair must preserve existing item metadata/visibility
            $sceneItems[0].visible = $true
            Write-Fixture $f.Collection (Json $collection)
            $beforeRepair = Read-Fixture $f.Collection
            [void](Run-Installer $f -Apply)
            Assert ((Read-Fixture $f.Collection) -ceq $beforeRepair) 'Repair modified existing scene items'
        }

        Test-Case 'fails closed on name collisions or ambiguity' {
            # 1. Non-browser collision
            $f = New-Fixture -WithCollision
            Expect-Failure { Run-Installer $f -Apply } 'Name collision|Ambiguous collision|Collision'
            
            # 2. Ambiguity
            $f2 = New-Fixture
            $collection = ConvertFrom-Json (Read-Fixture $f2.Collection)
            $newSources = New-Object 'System.Collections.Generic.List[object]'
            foreach ($s in $collection.sources) { $newSources.Add($s) }
            $newSources.Add([pscustomobject]@{
                name = 'Emberstage Graphics'
                id = 'browser_source'
                settings = [pscustomobject]@{ url = 'http://other' }
            })
            $collection.sources = @($newSources.ToArray())
            Write-Fixture $f2.Collection (Json $collection)
            Expect-Failure { Run-Installer $f2 -Apply } 'Ambiguous collision|Collision|Name collision'
        }
        Test-Case 'write failure rolls back earlier writes from exact backup' {
            if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { $script:skipped++; Write-Output 'SKIP Windows file-lock rollback scenario on non-Windows host'; return }
            $f = New-Fixture; $before = Snapshot $f
            $lock = [IO.File]::Open($f.Collection, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try { Expect-Failure { Run-Installer $f -Apply } 'Installation failed; rollback' }
            finally { $lock.Dispose() }
            Assert-Unchanged $before
            Assert ([IO.Directory]::GetDirectories($f.Parent, 'media-deck-backup-*').Length -eq 1) 'Rollback backup missing.'
            Assert ([IO.Directory]::GetFiles($f.Config, '*.tmp', [IO.SearchOption]::AllDirectories).Length -eq 0) 'Temporary write files leaked.'
        }
        Test-Case 'reinstall preserves customizations and visibility' {
            $f = New-Fixture
            [void](Run-Installer $f -Apply)
            
            $collection = ConvertFrom-Json (Read-Fixture $f.Collection)
            # Find and customize Camera A helper
            $cameraA = @($collection.sources | Where-Object { $_.name -eq 'Emberstage Camera A' })[0]
            # Add user customized items & filters
            $userItems = @(
                [pscustomobject]@{ name = 'Webcam Device'; id = 100; source_uuid = 'some-camera-uuid'; visible = $true }
            )
            $cameraA.settings.items = $userItems
            $cameraA.filters[0].settings.opacity = 0.5
            $customFilters = @($cameraA.filters) + @([pscustomobject]@{ enabled = $true; id = 'gain_filter'; name = 'My custom filter'; settings = [pscustomobject]@{} })
            $cameraA.filters = $customFilters
            
            # Show program item in the current scene
            $opScene = @($collection.sources | Where-Object { $_.name -eq 'Existing scene' })[0]
            $programItem = @($opScene.settings.items | Where-Object { $_.name -eq 'Emberstage Program' })[0]
            $programItem.visible = $true
            
            Write-Fixture $f.Collection (Json $collection)
            
            # Run installer again (Upgrade/Reinstall)
            [void](Run-Installer $f -Apply)
            
            # Verify customizations are preserved exactly!
            $collectionAfter = ConvertFrom-Json (Read-Fixture $f.Collection)
            $cameraAAfter = @($collectionAfter.sources | Where-Object { $_.name -eq 'Emberstage Camera A' })[0]
            Assert ($cameraAAfter.settings.items.Count -eq 1) 'User items in helper scene were reset!'
            Assert ($cameraAAfter.settings.items[0].name -eq 'Webcam Device') 'User items in helper scene were reset!'
            Assert ($cameraAAfter.filters[0].settings.opacity -eq 0.5) 'Custom filter opacity was reset!'
            Assert ($cameraAAfter.filters.Count -eq 2) 'User filters were reset!'
            
            $opSceneAfter = @($collectionAfter.sources | Where-Object { $_.name -eq 'Existing scene' })[0]
            $programItemAfter = @($opSceneAfter.settings.items | Where-Object { $_.name -eq 'Emberstage Program' })[0]
            Assert ($programItemAfter.visible -eq $true) 'Program item visibility was reset!'
        }
        Test-Case 'mismatched or missing UUID references fail closed' {
            $f = New-Fixture
            [void](Run-Installer $f -Apply)
            
            $collection = ConvertFrom-Json (Read-Fixture $f.Collection)
            $opScene = @($collection.sources | Where-Object { $_.name -eq 'Existing scene' })[0]
            $programItem = @($opScene.settings.items | Where-Object { $_.name -eq 'Emberstage Program' })[0]
            $programItem.source_uuid = 'mismatched-uuid-123'
            
            Write-Fixture $f.Collection (Json $collection)
            Expect-Failure { Run-Installer $f -Apply } 'Collision/malformed|reference mismatch'
        }
        Test-Case 'existing private credential rollback on failure' {
            if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { $script:skipped++; Write-Output 'SKIP Windows file-lock rollback scenario on non-Windows host'; return }
            $f = New-Fixture
            $appDirMock = Join-Path $f.Parent 'Emberstage'
            [void][IO.Directory]::CreateDirectory($appDirMock)
            
            # Pre-write a custom private credential
            $appParent = $f.Parent
            $privateDir = Join-Path $appParent 'Emberstage-private'
            [void][IO.Directory]::CreateDirectory($privateDir)
            $privateScript = Join-Path $privateDir 'obs-connection.js'
            $originalSecret = "window.EmberstageNativeConnection = { version: 1, port: 4457, password: 'original-secret-to-be-preserved' };"
            [IO.File]::WriteAllText($privateScript, $originalSecret, $utf8)
            $aclSignature = {
                param($Path)
                $descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $Path).Sddl)
                # Windows may add AI after recalculating identical inherited ACEs.
                # Preserve every ACE, owner/group, protection flag and other flag.
                $descriptor.SetFlags($descriptor.ControlFlags -band (-bnot [System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited))
                $descriptor.GetSddlForm([System.Security.AccessControl.AccessControlSections]::All)
            }
            $originalFileAcl = & $aclSignature $privateScript
            $originalDirAcl = & $aclSignature $privateDir

            # Lock the actual scene file: reads work, replacement fails after the private write.
            $lock = [IO.File]::Open($f.Collection, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                Expect-Failure { Run-Installer $f -Apply -AppInstallPath $appDirMock } 'failed; rollback'
            } finally { $lock.Dispose() }
            
            Assert (Test-Path -LiteralPath $privateScript -PathType Leaf) 'Private script was deleted on rollback instead of restored.'
            Assert ([IO.File]::ReadAllText($privateScript) -eq $originalSecret) 'Private script contents were modified or not restored on rollback.'
            Assert ((& $aclSignature $privateScript) -eq $originalFileAcl) 'Private file ACL was not restored on rollback.'
            Assert ((& $aclSignature $privateDir) -eq $originalDirAcl) 'Private directory ACL was not restored on rollback.'
        }
        Test-Case 'missing or corrupted private credential repair under no-change conditions' {
            $f = New-Fixture
            $appDirMock = Join-Path $f.Parent 'Emberstage'
            [void][IO.Directory]::CreateDirectory($appDirMock)
            
            # First write everything normally
            [void](Run-Installer $f -Apply -AppInstallPath $appDirMock)
            
            $appParent = $f.Parent
            $privateDir = Join-Path $appParent 'Emberstage-private'
            $privateScript = Join-Path $privateDir 'obs-connection.js'
            
            # Now delete the private connection script
            [IO.File]::Delete($privateScript)
            
            # Run again with -Apply. Since config files didn't change, normally this is a "no-change" return,
            # but our repair logic should detect the missing private script and repair/write it!
            [void](Run-Installer $f -Apply -AppInstallPath $appDirMock)
            
            Assert (Test-Path -LiteralPath $privateScript -PathType Leaf) 'Missing private script was not repaired under no-change conditions.'
        }
        Test-Case 'PS null variable prevention' {
            $f = New-Fixture
            $appDirMock = Join-Path $f.Parent 'Emberstage'
            [void][IO.Directory]::CreateDirectory($appDirMock)
            
            # Run the installer
            $output = Run-Installer $f -Apply -AppInstallPath $appDirMock
            
            $appParent = $f.Parent
            $privateDir = Join-Path $appParent 'Emberstage-private'
            $privateScript = Join-Path $privateDir 'obs-connection.js'
            
            # If $privateScript or $privateDir had been nulled out, the script would have failed or written to wrong paths.
            Assert (Test-Path -LiteralPath $privateScript -PathType Leaf) 'Private script path was incorrect or nulled out.'
            Assert ($privateScript -like '*Emberstage-private*') 'Private script path was incorrect or nulled out.'
        }
        Test-Case 'ACL failure on Windows' {
            if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
                $script:skipped++
                Write-Output 'SKIP Windows ACL failure test scenario on non-Windows host'
                return
            }
            $f = New-Fixture
            $appDirMock = Join-Path $f.Parent 'Emberstage'
            [void][IO.Directory]::CreateDirectory($appDirMock)
            
            $appParent = $f.Parent
            $privateDir = Join-Path $appParent 'Emberstage-private'
            [void][IO.Directory]::CreateDirectory($privateDir)
            
            # Inject at the DACL writer boundary in the isolated fixture only.
            $originalInstaller = [IO.File]::ReadAllText($fixtureInstaller)
            $needle = '    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop'
            Assert ($originalInstaller.Contains($needle)) 'DACL failure injection point not found.'
            $injection = '    if ($Path -eq ''' + $privateDir.Replace("'", "''") + ''') { throw ''Injected private ACL failure'' }'
            Write-Fixture $fixtureInstaller ($originalInstaller.Replace($needle, $injection + "`n" + $needle))
            try {
                Expect-Failure { Run-Installer $f -Apply -AppInstallPath $appDirMock } 'failed; rollback'
                Assert (-not [IO.File]::Exists((Join-Path $privateDir 'obs-connection.js'))) 'Credential bytes were written after ACL protection failed.'
            } finally { Write-Fixture $fixtureInstaller $originalInstaller }
        }
    Write-Output "$passed installer contract tests passed; $skipped apply scenarios skipped. Temporary fixtures only; no native OBS integration."
} finally {
    if (($suiteRoot -like ($tempParent + '*')) -and [IO.Directory]::Exists($suiteRoot)) {
        [IO.Directory]::Delete($suiteRoot, $true)
    }
}
