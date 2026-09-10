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
if (-not (Test-Path -LiteralPath $tempParent -PathType Container)) { throw 'Temp parent must exist.' }
$suiteRoot = Join-Path $tempParent ('media-deck-install-contract-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($suiteRoot)
$fakeRepo = Join-Path $suiteRoot 'Checkout with spaces # &'
[void][IO.Directory]::CreateDirectory((Join-Path $fakeRepo 'scripts'))
$fixtureInstaller = Join-Path $fakeRepo 'scripts/install-media-deck.ps1'
[IO.File]::Copy($installer, $fixtureInstaller)
foreach ($file in @('control_panel.html', 'browser_source.html', 'media_dock.html', 'camera_dock.html', 'video_mixer.html', 'picture_picker.html', 'media_setup.html', 'media_output.html', 'camera_output.html', 'streaming_dock.html', 'scripts/media-deck-hotkeys.lua')) {
    [IO.File]::WriteAllText((Join-Path $fakeRepo $file), 'fixture only - not executable app content', $utf8)
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
    Assert ($Path.StartsWith($suiteRoot + '\', [StringComparison]::OrdinalIgnoreCase)) 'Attempt to write outside isolated fixture root.'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    [IO.File]::WriteAllText($Path, $Text, $utf8)
}
function Read-Fixture([string]$Path) {
    Assert ($Path.StartsWith($suiteRoot + '\', [StringComparison]::OrdinalIgnoreCase)) 'Attempt to read real config instead of fixture.'
    return [IO.File]::ReadAllText($Path)
}
function New-Fixture {
    $parent = Join-Path $suiteRoot ([guid]::NewGuid().ToString('N'))
    $config = Join-Path $parent 'obs config'
    $iniPath = Join-Path $config 'user.ini'
    $collection = Join-Path $config 'basic/scenes/Selected collection.json'
    $ws = Join-Path $config 'plugin_config/obs-websocket/config.json'
    # Sanitized fixture of the current user.ini format, inspected read-only:
    # raw JSON quotes, INI-doubled JSON backslashes, CRLF, existing DockState.
    # No test reads APPDATA or any live OBS configuration.
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
    $ini = $ini.Replace("`r`n", "`n").Replace("`n", "`r`n") + "`r`n"
    Write-Fixture $iniPath $ini
    Write-Fixture $collection '{"name":"Operator selected collection","current_scene":"Existing scene","sources":[{"name":"Keep exactly","id":"image_source","settings":{"file":"D:/Pictures/image.png"}}],"scene_order":[{"name":"Existing scene"}],"modules":{"unrelated":{"nested":[1,false,{"keep":"yes"}]},"scripts-tool":[{"path":"D:/Operator Tools/existing.lua","settings":{"custom":"keep","bindings":[{"key":"OBS_KEY_F19"}]}}]},"unknown":{"keep":true}}'
    Write-Fixture $ws '{"server_enabled":false,"auth_required":false,"server_password":"fixture-only-password","server_port":4457,"unknown":{"keep":true}}'
    return [pscustomobject]@{ Parent = $parent; Config = $config; Ini = $iniPath; Collection = $collection; WebSocket = $ws }
}
function Snapshot($Fixture) {
    $result = @{}
    foreach ($path in @($Fixture.Ini, $Fixture.Collection, $Fixture.WebSocket)) {
        $result[$path] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
    }
    return $result
}
function Assert-Unchanged($Before) {
    foreach ($path in $Before.Keys) {
        Assert ([IO.File]::Exists($path)) "Fixture disappeared: $path"
        Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -ceq $Before[$path]) "Fixture changed unexpectedly: $path"
    }
}
function Run-Installer($Fixture, [switch]$Apply, [switch]$EnableWebSocket) {
    Assert ($Fixture.Config.StartsWith($suiteRoot + '\', [StringComparison]::OrdinalIgnoreCase)) 'Never install into real APPDATA during tests.'
    return (& $fixtureInstaller -ObsConfigPath $Fixture.Config -Apply:$Apply -EnableWebSocket:$EnableWebSocket *>&1 | Out-String)
}
function Expect-Failure([scriptblock]$Body, [string]$Pattern) {
    $failed = $false
    try { & $Body | Out-Null }
    catch {
        $failed = $true
        Assert ($_.Exception.Message -match $Pattern) "Unexpected failure: $($_.Exception.Message)"
    }
    Assert $failed "Expected failure matching: $Pattern"
}
function Read-Docks($Fixture) {
    $text = Read-Fixture $Fixture.Ini
    $raw = [regex]::Match($text, '(?m)^ExtraBrowserDocks=([^\r\n]*)').Groups[1].Value
    # Independent INI reader: walk the escape stream instead of installer regex.
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
            $node.GetCommandName() -in @('Start-Process', 'Stop-Process', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Install-Module', 'Set-NetFirewallProfile', 'New-NetFirewallRule')
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
        $required = Join-Path $fakeRepo 'browser_source.html'
        [IO.File]::Move($required, $required + '.hold')
        try { Expect-Failure { Run-Installer $f } 'Required app file missing' }
        finally { [IO.File]::Move($required + '.hold', $required) }
        Assert-Unchanged $before
    }

    $running = @(Get-Process -Name obs64, obs32 -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        Test-Case 'real OBS process causes apply refusal without stopping it' {
            $f = New-Fixture; $before = Snapshot $f
            Expect-Failure { Run-Installer $f -Apply } 'OBS is running'
            Assert-Unchanged $before
        }
        $skipped = 8
        Write-Output 'SKIP 8 apply scenarios: an actual OBS process is running. It was not stopped.'
    } else {
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
            Assert ((Json $current.sources) -ceq (Json $oldCollection.sources)) 'Scene sources changed.'
            Assert ((Json $current.scene_order) -ceq (Json $oldCollection.scene_order)) 'Scene order changed.'
            Assert ((Json $current.modules.unrelated) -ceq (Json $oldCollection.modules.unrelated)) 'Other modules changed.'
            Assert ((Json $current.modules.'scripts-tool'[0]) -ceq (Json $oldCollection.modules.'scripts-tool'[0])) 'Existing Lua settings changed.'
            Assert ($current.modules.'scripts-tool'.Count -eq 2) 'Lua script missing or duplicated.'
            $lua = $current.modules.'scripts-tool'[1]
            Assert ($lua.settings.output_scene -ceq '' -and -not $lua.settings.enabled -and -not $lua.settings.exclusive_video -and -not $lua.settings.exclusive_picture) 'Unsafe initial Lua defaults.'
            Assert ($lua.settings.PSObject.Properties.Name.Count -eq 4) 'Unexpected Lua settings/default bindings.'
            Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($f.WebSocket)) -ceq $before[$f.WebSocket]) 'WebSocket changed without opt-in.'
            $backups = @([IO.Directory]::GetDirectories($f.Parent, 'media-deck-backup-*'))
            Assert ($backups.Count -eq 1 -and $output.Contains($backups[0])) 'Backup path was not reported.'
            $manifest = ConvertFrom-Json (Read-Fixture (Join-Path $backups[0] 'manifest.json'))
            Assert ($manifest.files.Count -eq 2) 'Backup includes unexpected configs.'
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
                Assert ($dock.url.StartsWith('file:///') -and $dock.url.Contains('%20') -and $dock.url.Contains('%23')) 'File URL did not escape spaces/hash.'
                Assert (([uri]$dock.url).LocalPath.StartsWith($fakeRepo)) 'URL is not checkout-relative.'
            }
            Assert (@($ours | Where-Object { $_.url.EndsWith('control_panel.html') -and $_.title -ceq 'Emberstage - Text' }).Count -eq 1) 'Text dock URL missing.'
            Assert (@($ours | Where-Object { $_.url.EndsWith('media_dock.html') -and $_.title -ceq 'Emberstage - Media' }).Count -eq 1) 'Media dock URL missing.'
            Assert (@($ours | Where-Object { $_.url.EndsWith('camera_dock.html') -and $_.title -ceq 'Emberstage - Cameras' }).Count -eq 1) 'Cameras dock URL missing.'
            Assert (@($ours | Where-Object { $_.url.EndsWith('streaming_dock.html') -and $_.title -ceq 'Emberstage – Streaming' }).Count -eq 1) 'Streaming dock URL missing.'
        }
        Test-Case 'upgrade removes only owned Setup dock and preserves customer namesakes' {
            $f = New-Fixture
            $namesake = [pscustomobject]@{ uuid = 'customer-setup'; title = 'Emberstage - Setup'; url = 'https://example.test/setup' }
            $docks = @((Read-Docks $f)) + @($namesake, [pscustomobject]@{ uuid = '4d4445434b534554555000000000000005'; title = 'Renamed old setup'; url = 'file:///old/media_setup.html' })
            $newLine = 'ExtraBrowserDocks=' + (Json $docks)
            $newIni = [regex]::Replace((Read-Fixture $f.Ini), '(?m)^ExtraBrowserDocks=[^\r\n]*', $newLine)
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
            Assert (([IO.Path]::GetFullPath($updatedLua.path.Replace('/', '\'))) -ceq ([IO.Path]::GetFullPath((Join-Path $fakeRepo 'scripts/media-deck-hotkeys.lua')))) 'Lua path was not migrated to this installation.'
            Assert ($updatedLua.settings.output_scene -ceq 'Keep this scene' -and $updatedLua.settings.enabled -eq $true -and $updatedLua.settings.custom -ceq 'keep this value') 'Lua migration changed existing settings.'
        }
        Test-Case 'updates only app-owned dock title/URL, preserving same-title operator docks and unknown fields' {
            $f = New-Fixture; [void](Run-Installer $f -Apply)
            $docks = Read-Docks $f
            $docks[0].title = 'Emberstage - Text'
            $docks[1].title = 'Old app label'
            $docks[1].url = 'file:///D:/Moved%20checkout/control_panel.html'
            $docks[1] | Add-Member NoteProperty custom 'keep app dock metadata'
            $encoded = (Json $docks).Replace('\', '\\')
            $ini = [regex]::Replace((Read-Fixture $f.Ini), '(?m)^ExtraBrowserDocks=[^\r\n]*', [Text.RegularExpressions.MatchEvaluator]{ param($m) 'ExtraBrowserDocks=' + $encoded })
            Write-Fixture $f.Ini $ini
            $collectionBefore = Read-Fixture $f.Collection
            [void](Run-Installer $f -Apply)
            $after = Read-Docks $f
            Assert ($after.Count -eq 6 -and (Json $after[0]) -ceq (Json $docks[0])) 'Same-title unrelated dock was changed or removed.'
            Assert ($after[1].uuid -ceq $docks[1].uuid -and $after[1].title -ceq 'Emberstage - Text') 'Stable app UUID was not updated.'
            Assert (([uri]$after[1].url).LocalPath.StartsWith($fakeRepo) -and $after[1].custom -ceq 'keep app dock metadata') 'App dock URL/metadata not preserved correctly.'
            Assert ((Read-Fixture $f.Collection) -ceq $collectionBefore) 'Dock update rewrote Lua configuration.'
        }
        Test-Case 'WebSocket opt-in preserves password/unknown keys and never prints credentials' {
            $f = New-Fixture
            $output = Run-Installer $f -Apply -EnableWebSocket
            $ws = ConvertFrom-Json (Read-Fixture $f.WebSocket)
            Assert ($ws.server_enabled -eq $true -and $ws.auth_required -eq $true) 'WebSocket is not authenticated.'
            Assert ($ws.server_password -ceq 'fixture-only-password' -and $ws.server_port -eq 4457 -and $ws.unknown.keep) 'Existing WebSocket config was not preserved.'
            Assert (-not $output.Contains($ws.server_password)) 'Password leaked in output.'
            Assert ($output -match 'Keep the OBS WebSocket service private') 'Privacy warning missing.'
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
        Test-Case 'non-opted malformed WebSocket bytes are untouched' {
            $f = New-Fixture; Write-Fixture $f.WebSocket 'not-json; never parse without opt-in'
            $before = [IO.File]::ReadAllBytes($f.WebSocket)
            [void](Run-Installer $f -Apply)
            Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($f.WebSocket)) -ceq [Convert]::ToBase64String($before)) 'Non-opted WebSocket file changed.'
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
                        name = 'Emberstage Text Output'
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
            Assert ($dryRunOutput -match 'Repoint existing sources \(Emberstage Text Output, Emberstage Media Output, Emberstage Camera Output\) to stable installed files\.') 'Dry run output should include the planning message.'
            Assert-Unchanged $before
            
            $applyOutput = Run-Installer $f -Apply
            Assert ($applyOutput -match 'APPLY') 'Apply should print APPLY.'
            
            $updatedCollection = ConvertFrom-Json (Read-Fixture $f.Collection)
            Assert ($updatedCollection.sources.Count -eq 5) 'Sources count should be 5.'
            
            $textOutput = $updatedCollection.sources[0]
            Assert ($textOutput.name -eq 'Emberstage Text Output') 'Source name mismatch.'
            Assert ($textOutput.id -eq 'browser_source') 'Source id mismatch.'
            Assert ($textOutput.settings.is_local_file -eq $false) 'is_local_file must be false.'
            Assert ($textOutput.settings.local_file -eq '') 'local_file must be empty.'
            Assert ($textOutput.settings.url -match '^file:///.*browser_source\.html$') 'url must point to browser_source.html as a file URI.'
            Assert ($textOutput.settings.custom_key -eq 'preserve-me') 'unrelated settings in mutated source must be preserved.'
            
            $mediaOutput = $updatedCollection.sources[1]
            Assert ($mediaOutput.name -eq 'Emberstage Media Output') 'Source name mismatch.'
            Assert ($mediaOutput.id -eq 'browser_source') 'Source id mismatch.'
            Assert ($mediaOutput.settings.is_local_file -eq $false) 'is_local_file must be false.'
            Assert ($mediaOutput.settings.local_file -eq '') 'local_file must be empty.'
            Assert ($mediaOutput.settings.url -match '^file:///.*media_output\.html$') 'url must point to media_output.html as a file URI.'
            
            $cameraOutput = $updatedCollection.sources[2]
            Assert ($cameraOutput.name -eq 'Emberstage Camera Output') 'Source name mismatch.'
            Assert ($cameraOutput.id -eq 'browser_source') 'Source id mismatch.'
            Assert ($cameraOutput.settings.is_local_file -eq $false) 'is_local_file must be false.'
            Assert ($cameraOutput.settings.local_file -eq '') 'local_file must be empty.'
            Assert ($cameraOutput.settings.url -match '^file:///.*camera_output\.html$') 'url must point to camera_output.html as a file URI.'
            
            $unrelatedIdOutput = $updatedCollection.sources[3]
            Assert ($unrelatedIdOutput.name -eq 'Emberstage Text Output' -and $unrelatedIdOutput.id -eq 'image_source') 'Wrong source affected.'
            Assert ($unrelatedIdOutput.settings.file -eq 'D:/Pictures/image.png') 'Unmutated source settings modified.'
            
            $unrelatedNameOutput = $updatedCollection.sources[4]
            Assert ($unrelatedNameOutput.name -eq 'Some Other Source' -and $unrelatedNameOutput.id -eq 'browser_source') 'Wrong source affected.'
            Assert ($unrelatedNameOutput.settings.url -eq 'https://other.com') 'Unmutated source settings modified.'
            
            $beforeSecond = Snapshot $f
            $secondOutput = Run-Installer $f -Apply
            Assert-Unchanged $beforeSecond
            Assert ($secondOutput -match 'No changes needed') 'Second apply should be no-op.'
        }
        Test-Case 'write failure rolls back earlier writes from exact backup' {
            $f = New-Fixture; $before = Snapshot $f
            # Read-sharing allows backup; withholding write/delete sharing rejects
            # the second atomic replacement, after user.ini has been replaced.
            $lock = [IO.File]::Open($f.Collection, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try { Expect-Failure { Run-Installer $f -Apply } 'Installation failed; all installer-written configs were restored' }
            finally { $lock.Dispose() }
            Assert-Unchanged $before
            Assert ([IO.Directory]::GetDirectories($f.Parent, 'media-deck-backup-*').Length -eq 1) 'Rollback backup missing.'
            Assert ([IO.Directory]::GetFiles($f.Config, '*.tmp', [IO.SearchOption]::AllDirectories).Length -eq 0) 'Temporary write files leaked.'
        }
        Write-Output 'SKIP real process-running refusal branch: OBS is not running; no process was launched for this test.'
    }
    Write-Output "$passed installer contract tests passed; $skipped apply scenarios skipped. Temporary fixtures only; no native OBS integration."
} finally {
    # This exact GUID-owned temporary root is the only recursive deletion target.
    if ($suiteRoot.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($suiteRoot)) {
        [IO.Directory]::Delete($suiteRoot, $true)
    }
}
