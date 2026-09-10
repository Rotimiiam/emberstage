#requires -Version 5.1
<#
Dry-run by default. Close OBS yourself before -Apply. No OBS launch, source edits,
browser credentials, network requests, firewall changes, or automatic restart.
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$ObsConfigPath = (Join-Path $env:APPDATA 'obs-studio'),
    [switch]$EnableWebSocket
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configRoot = [IO.Path]::GetFullPath($ObsConfigPath)
if ($configRoot -eq [IO.Path]::GetPathRoot($configRoot)) {
    throw 'Choose the OBS config directory, not a drive or share root.'
}
$configRoot = $configRoot.TrimEnd('\', '/')
$plans = New-Object 'System.Collections.Generic.List[object]'
$originalFiles = @{}

function Assert-ObsClosed {
    if (@(Get-Process -Name obs64, obs32 -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Apply refused: OBS is running (obs64/obs32). Close every OBS instance yourself, then retry.'
    }
}

function Read-ConfigText([string]$Path) {
    # Reject unsupported encodings rather than damaging unrelated INI lines.
    $bytes = [IO.File]::ReadAllBytes($Path)
    $originalFiles[$Path] = $bytes
    $text = $utf8.GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    if ($text.IndexOf([char]0) -ge 0) { throw "Unsupported config encoding: $Path (expected UTF-8)." }
    return $text
}

function Get-IniRecord([string]$Text, [string]$Section, [string]$Key) {
    $inside = $false
    $sections = 0
    $entry = $null
    $insert = -1
    foreach ($line in [regex]::Matches($Text, '[^\r\n]+(?:\r\n|\n|\r|$)|(?:\r\n|\n|\r)')) {
        $content = $line.Value.TrimEnd("`r", "`n")
        if ($content -match '^\s*\[([^\]]+)\]\s*(?:[;#].*)?$') {
            $inside = $Matches[1] -eq $Section
            if ($inside) {
                $sections++
                if ($sections -gt 1) { throw "Ambiguous INI: repeated [$Section] section." }
                $insert = $line.Index + $line.Length
            }
        } elseif ($inside) {
            $match = [regex]::Match($content, '^\s*' + [regex]::Escape($Key) + '\s*=(.*)$', 'IgnoreCase')
            if ($match.Success) {
                if ($null -ne $entry) { throw "Ambiguous INI: repeated [$Section] $Key." }
                $entry = [pscustomobject]@{
                    Value = $match.Groups[1].Value
                    Index = $line.Index + $match.Groups[1].Index
                    Length = $match.Groups[1].Length
                }
            }
        }
    }
    return [pscustomobject]@{ Entry = $entry; Insert = $insert }
}

function Set-IniValue([string]$Text, [string]$Section, [string]$Key, [string]$Value) {
    $record = Get-IniRecord $Text $Section $Key
    if ($null -ne $record.Entry) {
        return $Text.Remove($record.Entry.Index, $record.Entry.Length).Insert($record.Entry.Index, $Value)
    }
    $newline = "`r`n"
    $firstEnding = [regex]::Match($Text, '\r\n|\n|\r')
    if ($firstEnding.Success) { $newline = $firstEnding.Value }
    if ($record.Insert -ge 0) {
        $prefix = ''
        if ($record.Insert -gt 0 -and $Text[$record.Insert - 1] -notin @([char]10, [char]13)) { $prefix = $newline }
        return $Text.Insert($record.Insert, $prefix + $Key + '=' + $Value + $newline)
    }
    $separator = ''
    if ($Text.Length -gt 0 -and $Text[$Text.Length - 1] -notin @([char]10, [char]13)) { $separator = $newline }
    return $Text + $separator + '[' + $Section + ']' + $newline + $Key + '=' + $Value + $newline
}

function Decode-IniString([string]$Value) {
    $valueText = $Value.Trim()
    # Accept both OBS's unquoted escaped JSON and Qt's outer-quoted form.
    if ($valueText.StartsWith('"') -and $valueText.EndsWith('"')) {
        $valueText = $valueText.Substring(1, $valueText.Length - 2)
    }
    return [regex]::Replace($valueText, '\\([\\"nrt])', {
        param($match)
        switch ($match.Groups[1].Value) {
            '\' { return '\' }
            '"' { return '"' }
            'n' { return "`n" }
            'r' { return "`r" }
            't' { return "`t" }
        }
    })
}

function Encode-IniString([string]$Value) {
    return $Value.Replace('\', '\\').Replace("`n", '\n').Replace("`r", '\r').Replace("`t", '\t')
}

function Read-JsonObject([string]$Text, [string]$Label) {
    try { $value = ConvertFrom-Json -InputObject $Text -ErrorAction Stop }
    catch { throw "Invalid JSON in $Label. No configuration was changed." }
    if ($null -eq $value -or $value -isnot [pscustomobject]) { throw "Expected a JSON object in $Label." }
    Assert-JsonDepth $value 0
    return $value
}

function Assert-JsonDepth($Value, [int]$Depth) {
    if ($Depth -gt 80) { throw 'Config nesting exceeds the safe JSON serialization limit.' }
    if ($Value -is [pscustomobject]) {
        foreach ($property in $Value.PSObject.Properties) { Assert-JsonDepth $property.Value ($Depth + 1) }
    } elseif ($Value -is [array]) {
        foreach ($item in $Value) { Assert-JsonDepth $item ($Depth + 1) }
    }
}

function Has-Key($Object, [string]$Key) { return $null -ne $Object.PSObject.Properties[$Key] }

function Set-Key($Object, [string]$Key, $Value) {
    if (Has-Key $Object $Key) { $Object.PSObject.Properties[$Key].Value = $Value }
    else { $Object | Add-Member -MemberType NoteProperty -Name $Key -Value $Value }
}

function To-Json($Value) { return ConvertTo-Json -InputObject $Value -Depth 100 -Compress }

function Same-Bytes([byte[]]$Left, [byte[]]$Right) {
    return [Convert]::ToBase64String($Left) -ceq [Convert]::ToBase64String($Right)
}

function Add-Plan([string]$Path, [string]$Relative, [string]$Text, [string]$Description, [switch]$PreserveBom) {
    $exists = [IO.File]::Exists($Path)
    $original = [byte[]]@()
    if ($exists) {
        if (-not $originalFiles.ContainsKey($Path)) { throw "Missing planning snapshot: $Path" }
        $original = $originalFiles[$Path]
    }
    $bytes = $utf8.GetBytes($Text)
    if ($PreserveBom -and $original.Length -ge 3 -and $original[0] -eq 239 -and $original[1] -eq 187 -and $original[2] -eq 191) {
        $bytes = [byte[]](@(239, 187, 191) + $bytes)
    }
    if ($exists -and (Same-Bytes $original $bytes)) { return }
    $plans.Add([pscustomobject]@{
        Path = $Path; Relative = $Relative; Bytes = $bytes; Original = $original
        Existed = $exists; Description = $Description
    })
}

function Ensure-Directory([string]$Path, $Created) {
    if ([IO.Directory]::Exists($Path)) { return }
    $parent = [IO.Path]::GetDirectoryName($Path)
    if (-not $parent -or $parent -eq $Path) { throw "Cannot create directory: $Path" }
    Ensure-Directory $parent $Created
    [void][IO.Directory]::CreateDirectory($Path)
    $Created.Add($Path)
}

if ($Apply) { Assert-ObsClosed }
if (-not [IO.Directory]::Exists($configRoot)) {
    throw 'OBS config directory is missing. Start and configure OBS yourself once, then close it; or specify -ObsConfigPath.'
}
foreach ($file in @('control_panel.html', 'browser_source.html', 'media_dock.html', 'camera_dock.html', 'media_setup.html', 'media_output.html', 'camera_output.html', 'streaming_dock.html', 'scripts/media-deck-hotkeys.lua')) {
    if (-not [IO.File]::Exists((Join-Path $repoRoot $file))) { throw "Required app file missing: $file. Use a complete app checkout; nothing was installed." }
}
$iniPath = Join-Path $configRoot 'user.ini'
if (-not [IO.File]::Exists($iniPath)) { throw 'user.ini is missing. Select a scene collection in OBS yourself, close OBS, and retry.' }
$ini = Read-ConfigText $iniPath
$collectionRecord = Get-IniRecord $ini 'Basic' 'SceneCollectionFile'
if ($null -eq $collectionRecord.Entry) {
    throw 'Missing [Basic] SceneCollectionFile in user.ini. Select the intended collection in OBS, close OBS, and retry. No collection is guessed.'
}
$collectionName = Decode-IniString $collectionRecord.Entry.Value
if ([string]::IsNullOrWhiteSpace($collectionName) -or $collectionName -match '[\\/:*?"<>|\x00-\x1f]' -or
    $collectionName -in @('.', '..') -or $collectionName.EndsWith('.') -or $collectionName.EndsWith(' ') -or
    [IO.Path]::IsPathRooted($collectionName)) {
    throw 'Unsafe SceneCollectionFile: expected a filename only, not an absolute path or directory traversal.'
}
if (-not $collectionName.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase)) { $collectionName += '.json' }
$collectionRelative = 'basic/scenes/' + $collectionName
$collectionPath = Join-Path $configRoot $collectionRelative
if (-not [IO.File]::Exists($collectionPath)) {
    throw 'The selected scene collection file is missing. Select the intended collection in OBS, close OBS, and retry. No fallback collection is used.'
}
$collection = Read-JsonObject (Read-ConfigText $collectionPath) 'active scene collection'

# Stable, app-owned dock UUIDs. Never identify ownership by a customer's title/URL.
$dockSpecs = @(
    @{ uuid = '4d4445434b534352495054555245000001'; title = 'Emberstage - Text'; file = 'control_panel.html'; query = '' },
    @{ uuid = '4d4445434b534f4e475300000000000002'; title = 'Emberstage - Media'; file = 'media_dock.html'; query = '' },
    @{ uuid = '4d4445434b564944454f00000000000003'; title = 'Emberstage - Cameras'; file = 'camera_dock.html'; query = '' },
    @{ uuid = '4d4445434b53545245414d494e47000006'; title = 'Emberstage – Streaming'; file = 'streaming_dock.html'; query = '' }
)
$docksRecord = Get-IniRecord $ini 'BasicWindow' 'ExtraBrowserDocks'
$docks = New-Object 'System.Collections.Generic.List[object]'
if ($null -ne $docksRecord.Entry -and -not [string]::IsNullOrWhiteSpace($docksRecord.Entry.Value)) {
    $dockJson = Decode-IniString $docksRecord.Entry.Value
    $wrapper = Read-JsonObject ('{"items":' + $dockJson + '}') 'ExtraBrowserDocks'
    if ($wrapper.items -isnot [array]) { throw 'ExtraBrowserDocks must be a JSON array.' }
    foreach ($dock in $wrapper.items) {
        if ($dock -isnot [pscustomobject]) { throw 'ExtraBrowserDocks contains a non-object entry.' }
        $docks.Add($dock)
    }
}
$docksChanged = $false
# Retire only the exact app-owned Setup dock, never a customer's matching title.
for ($i = $docks.Count - 1; $i -ge 0; $i--) {
    if ((Has-Key $docks[$i] 'uuid') -and $docks[$i].uuid -eq '4d4445434b534554555000000000000005') {
        $docks.RemoveAt($i)
        $docksChanged = $true
    }
}
foreach ($spec in $dockSpecs) {
    $url = ([uri]([IO.Path]::GetFullPath((Join-Path $repoRoot $spec.file)))).AbsoluteUri + $spec.query
    if (-not $url.StartsWith('file:///')) { throw 'App files must resolve to local file:/// URLs, not a network share.' }
    $matchesOwned = @($docks | Where-Object { (Has-Key $_ 'uuid') -and $_.uuid -eq $spec.uuid })
    if ($matchesOwned.Count -gt 1) { throw 'Duplicate app-owned dock UUID found. Resolve the duplicate manually; nothing was changed.' }
    if ($matchesOwned.Count -eq 0) {
        $docks.Add([pscustomobject]@{ title = $spec.title; url = $url; uuid = $spec.uuid })
        $docksChanged = $true
    } else {
        $dock = $matchesOwned[0]
        if (-not (Has-Key $dock 'title') -or $dock.title -cne $spec.title) { Set-Key $dock 'title' $spec.title; $docksChanged = $true }
        if (-not (Has-Key $dock 'url') -or $dock.url -cne $url) { Set-Key $dock 'url' $url; $docksChanged = $true }
    }
}
if ($docksChanged) {
    $newIni = Set-IniValue $ini 'BasicWindow' 'ExtraBrowserDocks' (Encode-IniString (To-Json @($docks.ToArray())))
    Add-Plan $iniPath 'user.ini' $newIni 'Add/update four Emberstage browser docks; remove retired Setup dock; retain other docks and layout.' -PreserveBom
}

$collectionChanged = $false

# Safely repoint existing exact-named OBS browser sources if present.
$browserSourceUrl = ([uri]([IO.Path]::GetFullPath((Join-Path $repoRoot 'browser_source.html')))).AbsoluteUri
$mediaOutputUrl = ([uri]([IO.Path]::GetFullPath((Join-Path $repoRoot 'media_output.html')))).AbsoluteUri
$cameraOutputUrl = ([uri]([IO.Path]::GetFullPath((Join-Path $repoRoot 'camera_output.html')))).AbsoluteUri

$sourceMapping = @{
    'Emberstage Text Output' = @{ url = $browserSourceUrl }
    'Emberstage Media Output' = @{ url = $mediaOutputUrl }
    'Emberstage Camera Output' = @{ url = $cameraOutputUrl }
}

$repointedSources = New-Object 'System.Collections.Generic.List[string]'
if (Has-Key $collection 'sources') {
    if ($collection.sources -isnot [array]) { throw 'Scene collection sources must be an array.' }
    foreach ($source in $collection.sources) {
        if ($source -is [pscustomobject] -and (Has-Key $source 'name') -and (Has-Key $source 'id') -and ($source.id -eq 'browser_source')) {
            if ($sourceMapping.ContainsKey($source.name)) {
                $targetUrl = $sourceMapping[$source.name].url
                if (-not (Has-Key $source 'settings') -or $source.settings -isnot [pscustomobject]) {
                    Set-Key $source 'settings' ([pscustomobject]@{})
                }
                $settings = $source.settings
                
                $needsChange = $false
                if (-not (Has-Key $settings 'is_local_file') -or $settings.is_local_file -ne $false) { $needsChange = $true }
                if (-not (Has-Key $settings 'local_file') -or $settings.local_file -ne '') { $needsChange = $true }
                if (-not (Has-Key $settings 'url') -or $settings.url -ne $targetUrl) { $needsChange = $true }
                
                if ($needsChange) {
                    Set-Key $settings 'is_local_file' $false
                    Set-Key $settings 'local_file' ''
                    Set-Key $settings 'url' $targetUrl
                    $repointedSources.Add($source.name)
                    $collectionChanged = $true
                }
            }
        }
    }
}
if (-not (Has-Key $collection 'modules')) {
    Set-Key $collection 'modules' ([pscustomobject]@{}); $collectionChanged = $true
}
if ($collection.modules -isnot [pscustomobject]) { throw 'Scene collection modules must be a JSON object.' }
if (-not (Has-Key $collection.modules 'scripts-tool')) {
    Set-Key $collection.modules 'scripts-tool' @(); $collectionChanged = $true
}
$scripts = $collection.modules.PSObject.Properties['scripts-tool'].Value
if ($scripts -isnot [array]) { throw 'Scene collection modules/scripts-tool must be an array.' }
$luaPath = [IO.Path]::GetFullPath((Join-Path $repoRoot 'scripts/media-deck-hotkeys.lua'))
$existingLua = @()
foreach ($script in $scripts) {
    if ($script -isnot [pscustomobject] -or -not (Has-Key $script 'path') -or $script.path -isnot [string]) {
        throw 'Scene collection contains an invalid script entry; nothing was changed.'
    }
    # Existing unrelated entries, even relative or unavailable paths, are preserved.
    try { $normalized = [IO.Path]::GetFullPath($script.path.Replace('/', '\')) }
    catch { $normalized = '' }
    if ($normalized -eq $luaPath -or [IO.Path]::GetFileName($script.path.Replace('/', '\')) -eq 'media-deck-hotkeys.lua') {
        $existingLua += $script
    }
}
if ($existingLua.Count -gt 1) { throw 'The Media Deck Lua script is registered more than once. Resolve duplicate entries manually.' }
$luaMigrated = $false
if ($existingLua.Count -eq 1) {
    try { $registeredLuaPath = [IO.Path]::GetFullPath($existingLua[0].path.Replace('/', '\')) }
    catch { $registeredLuaPath = '' }
    if ($registeredLuaPath -ne $luaPath) {
        Set-Key $existingLua[0] 'path' $luaPath.Replace('\', '/')
        $collectionChanged = $true
        $luaMigrated = $true
    }
}
if ($existingLua.Count -eq 0) {
    $entry = [pscustomobject]@{
        path = $luaPath.Replace('\', '/')
        settings = [pscustomobject]@{ output_scene = ''; enabled = $false; exclusive_video = $false; exclusive_picture = $false }
    }
    Set-Key $collection.modules 'scripts-tool' @($scripts + @($entry))
    $collectionChanged = $true
}
if ($collectionChanged) {
    $collectionDescParts = New-Object 'System.Collections.Generic.List[string]'
    if ($existingLua.Count -eq 0) {
        $collectionDescParts.Add('Register native Lua in the active collection, initially disarmed with no target or keys.')
    }
    if ($luaMigrated) {
        $collectionDescParts.Add('Repoint the existing Emberstage Lua entry to this installation while preserving its settings.')
    }
    if ($repointedSources.Count -gt 0) {
        $sourcesList = $repointedSources -join ', '
        $collectionDescParts.Add("Repoint existing sources ($sourcesList) to stable installed files.")
    }
    $collectionDescription = $collectionDescParts -join ' '
    if ([string]::IsNullOrWhiteSpace($collectionDescription)) {
        $collectionDescription = 'Update active scene collection configuration.'
    }
    Add-Plan $collectionPath $collectionRelative (To-Json $collection) $collectionDescription
}

if ($EnableWebSocket) {
    $wsRelative = 'plugin_config/obs-websocket/config.json'
    $wsPath = Join-Path $configRoot $wsRelative
    $ws = [pscustomobject]@{}
    if ([IO.File]::Exists($wsPath)) { $ws = Read-JsonObject (Read-ConfigText $wsPath) 'WebSocket config' }
    $wsChanged = $false
    foreach ($key in @('server_enabled', 'auth_required')) {
        if (-not (Has-Key $ws $key) -or $ws.PSObject.Properties[$key].Value -isnot [bool] -or $ws.PSObject.Properties[$key].Value -ne $true) {
            Set-Key $ws $key $true; $wsChanged = $true
        }
    }
    if ((Has-Key $ws 'server_password') -and $null -ne $ws.server_password -and $ws.server_password -isnot [string]) {
        throw 'WebSocket server_password must be a string; existing settings were not changed.'
    }
    if (-not (Has-Key $ws 'server_password') -or [string]::IsNullOrWhiteSpace($ws.server_password)) {
        $password = 'GENERATED_ONLY_ON_APPLY'
        if ($Apply) {
            $random = [Security.Cryptography.RandomNumberGenerator]::Create()
            try {
                $secretBytes = New-Object byte[] 32
                $random.GetBytes($secretBytes)
                $password = [Convert]::ToBase64String($secretBytes)
            } finally { $random.Dispose() }
        }
        Set-Key $ws 'server_password' $password
        $wsChanged = $true
    }
    if ($wsChanged) { Add-Plan $wsPath $wsRelative (To-Json $ws) 'Enable WebSocket with authentication; preserve a nonempty password or generate one securely.' }
}

$mode = 'DRY RUN'
if ($Apply) { $mode = 'APPLY' }
Write-Output "$mode - config: $configRoot"
foreach ($plan in $plans) { Write-Output ("  {0}`n    {1}" -f $plan.Path, $plan.Description) }
if (-not $EnableWebSocket) { Write-Output 'WebSocket config is untouched (opt in with -EnableWebSocket).' }
else {
    Write-Output 'Keep the OBS WebSocket service private. No firewall or network settings are changed.'
    Write-Output 'After you start OBS yourself, find the password in Tools > WebSocket Server Settings. Passwords are never printed here.'
}
if ($plans.Count -eq 0) { Write-Output 'No changes needed.'; return }
if (-not $Apply) { Write-Output 'No files or backups written. Close OBS, inspect this plan, then repeat with -Apply.'; return }

Assert-ObsClosed
$configParent = [IO.Path]::GetDirectoryName($configRoot)
if (-not [IO.Directory]::Exists($configParent)) { throw 'The selected config parent directory must exist.' }
$backupRoot = Join-Path $configParent ('media-deck-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$written = New-Object 'System.Collections.Generic.List[object]'
$created = New-Object 'System.Collections.Generic.List[string]'
$temps = New-Object 'System.Collections.Generic.List[string]'
try {
    # Verify snapshots before any write. OBS must remain closed during installation.
    foreach ($plan in $plans) {
        if ([IO.File]::Exists($plan.Path) -ne $plan.Existed -or
            ($plan.Existed -and -not (Same-Bytes ([IO.File]::ReadAllBytes($plan.Path)) $plan.Original))) {
            throw 'A configuration changed during planning. Retry with OBS closed.'
        }
    }
    [void][IO.Directory]::CreateDirectory($backupRoot)
    $manifest = @()
    foreach ($plan in $plans) {
        $backupFile = Join-Path $backupRoot $plan.Relative
        if ($plan.Existed) {
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backupFile))
            [IO.File]::Copy($plan.Path, $backupFile, $false)
            if (-not (Same-Bytes ([IO.File]::ReadAllBytes($backupFile)) $plan.Original)) { throw 'Backup verification failed; no configuration was written.' }
        }
        $manifest += [pscustomobject]@{ relativePath = $plan.Relative; existed = $plan.Existed }
    }
    [IO.File]::WriteAllText((Join-Path $backupRoot 'manifest.json'), (To-Json ([pscustomobject]@{ configRoot = $configRoot; files = $manifest })), $utf8)
    Write-Output "Backup: $backupRoot"
    foreach ($plan in $plans) {
        Assert-ObsClosed
        if ([IO.File]::Exists($plan.Path) -ne $plan.Existed -or
            ($plan.Existed -and -not (Same-Bytes ([IO.File]::ReadAllBytes($plan.Path)) $plan.Original))) {
            throw 'A configuration changed before its write. Installation stopped.'
        }
        Ensure-Directory ([IO.Path]::GetDirectoryName($plan.Path)) $created
        $temporary = $plan.Path + '.media-deck-' + [guid]::NewGuid().ToString('N') + '.tmp'
        $temps.Add($temporary)
        [IO.File]::WriteAllBytes($temporary, $plan.Bytes)
        # Windows PowerShell converts $null to an empty string for this overload;
        # NullString supplies a real null backup filename (backup already copied).
        if ($plan.Existed) { [IO.File]::Replace($temporary, $plan.Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $plan.Path) }
        $written.Add($plan)
    }
} catch {
    $failure = $_.Exception.Message
    $restoreErrors = @()
    for ($i = $written.Count - 1; $i -ge 0; $i--) {
        $plan = $written[$i]
        try {
            if ($plan.Existed) { [IO.File]::Copy((Join-Path $backupRoot $plan.Relative), $plan.Path, $true) }
            elseif ([IO.File]::Exists($plan.Path)) { [IO.File]::Delete($plan.Path) }
        } catch { $restoreErrors += $plan.Path }
    }
    if ($restoreErrors.Count -gt 0) {
        throw "Installation failed; automatic restore could not finish for: $($restoreErrors -join ', '). Restore from $backupRoot. Cause: $failure"
    }
    throw "Installation failed; all installer-written configs were restored. Backup (if created): $backupRoot. Cause: $failure"
} finally {
    foreach ($temporary in $temps) {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
    # Remove only newly created empty directories, never pre-existing content.
    for ($i = $created.Count - 1; $i -ge 0; $i--) {
        if ([IO.Directory]::Exists($created[$i]) -and [IO.Directory]::GetFileSystemEntries($created[$i]).Length -eq 0) {
            [IO.Directory]::Delete($created[$i])
        }
    }
}
Write-Output 'Installed Emberstage docks. Start OBS yourself; arrange docks manually. No source, scene visibility, or stream was changed.'
Write-Output 'For a new Lua entry: choose Output scene manually to match the app, assign Settings > Hotkeys, then enable to arm.'
Write-Output "Rollback: close OBS; restore the relative files listed in $backupRoot\manifest.json (remove files marked existed=false)."
