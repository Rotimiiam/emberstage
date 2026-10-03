#requires -Version 5.1
<#
Dry-run by default. Close OBS yourself before -Apply. No OBS launch, source edits,
browser credentials, network requests, firewall changes, or automatic restart.
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$ObsConfigPath = (Join-Path $env:APPDATA 'obs-studio'),
    [switch]$EnableWebSocket,
    [string]$AppInstallPath = (Join-Path $env:LOCALAPPDATA 'Emberstage\app'),
    [switch]$Uninstall,
    [switch]$Repair
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$EnableWebSocket = $true # accepted compatibility but automatic default now
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configRoot = [IO.Path]::GetFullPath($ObsConfigPath)
if ($configRoot -eq [IO.Path]::GetPathRoot($configRoot)) {
    throw 'Choose the OBS config directory, not a drive or share root.'
}
$configRoot = $configRoot.TrimEnd('\', '/')

$APP_FILES = @(
    'control_panel.html',
    'browser_source.html',
    'media_dock.html',
    'camera_dock.html',
    'media_setup.html',
    'picture_picker.html',
    'video_mixer.html',
    'media_output.html',
    'camera_output.html',
    'emberstage_output.html',
    'streaming_dock.html'
)
$APP_DIRS = @('assets', 'scripts')

$plans = New-Object 'System.Collections.Generic.List[object]'
$originalFiles = @{}

function Assert-ObsClosed {
    if (@(Get-Process -Name obs64, obs32, obs -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Apply refused: OBS is running (obs64/obs32/obs). Close every OBS instance yourself, then retry.'
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

function Get-ProfileCanvasDimensions($configRoot, $ini) {
    $profileDir = 'Unti' + 'tled'
    $dirRecord = Get-IniRecord $ini 'Basic' 'ProfileDir'
    if ($null -ne $dirRecord.Entry -and -not [string]::IsNullOrWhiteSpace($dirRecord.Entry.Value)) {
        $profileDir = Decode-IniString $dirRecord.Entry.Value
    } else {
        $nameRecord = Get-IniRecord $ini 'Basic' 'Profile'
        if ($null -ne $nameRecord.Entry -and -not [string]::IsNullOrWhiteSpace($nameRecord.Entry.Value)) {
            $profileDir = Decode-IniString $nameRecord.Entry.Value
        }
    }
    
    $basicIniPath = Join-Path $configRoot "basic/profiles/$profileDir/basic.ini"
    if ([IO.File]::Exists($basicIniPath)) {
        try {
            $text = [IO.File]::ReadAllText($basicIniPath)
            $cxRec = Get-IniRecord $text 'Video' 'BaseCX'
            $cyRec = Get-IniRecord $text 'Video' 'BaseCY'
            if ($null -ne $cxRec.Entry -and $null -ne $cyRec.Entry) {
                $cx = [int]($cxRec.Entry.Value.Trim())
                $cy = [int]($cyRec.Entry.Value.Trim())
                return @($cx, $cy)
            }
        } catch {}
    }
    return $null
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
    if ($Left.Length -ne $Right.Length) { return $false }
    for ($i = 0; $i -lt $Left.Length; $i++) {
        if ($Left[$i] -ne $Right[$i]) { return $false }
    }
    return $true
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
        Existed = $exists; Description = $Description; PreserveBom = $PreserveBom
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

function Validate-AppInstallPath([string]$path, [string]$repo, [string]$config) {
    if ([string]::IsNullOrWhiteSpace($path)) {
        throw "AppInstallPath cannot be empty."
    }
    $full = [IO.Path]::GetFullPath($path)
    if ($full.Length -gt 1) { $full = $full.TrimEnd([IO.Path]::DirectorySeparatorChar) }
    $rootRaw = [IO.Path]::GetPathRoot($full)
    if ($null -eq $rootRaw) { $rootRaw = '' }
    $root = $rootRaw
    if ($root.Length -gt 1) { $root = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) }
    if ($full -eq $root -or [string]::IsNullOrEmpty($full) -or $full -eq '/' -or $full -eq '\') {
        throw "AppInstallPath cannot be the root directory: $path"
    }
    if ([IO.Directory]::Exists($full)) {
        $di = [IO.DirectoryInfo]::new($full)
        if (($di.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint) {
            throw "AppInstallPath cannot be a symlink or reparse point: $path"
        }
    }
    $normRepo = [IO.Path]::GetFullPath($repo).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $normConfig = [IO.Path]::GetFullPath($config).TrimEnd([IO.Path]::DirectorySeparatorChar)
    
    # Check overlap (equals or is parent/child) case-insensitively
    if (-not $Uninstall -and -not ($Repair -and $full -eq $normRepo) -and ($full -eq $normRepo -or $full.StartsWith($normRepo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $normRepo.StartsWith($full + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
        throw "AppInstallPath cannot overlap with repository root directory: $path"
    }
    if ($full -eq $normConfig -or $full.StartsWith($normConfig + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $normConfig.StartsWith($full + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "AppInstallPath cannot overlap with OBS config directory: $path"
    }
}

function Assert-NoReparse([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $entry = Get-Item -LiteralPath $current -Force
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point refused: $current" }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Set-FileSystemDacl([string]$Path, [System.Security.AccessControl.FileSystemSecurity]$Acl) {
    Assert-NoReparse $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer) {
        $accessOnly = New-Object System.Security.AccessControl.DirectorySecurity
    } else {
        $accessOnly = New-Object System.Security.AccessControl.FileSecurity
    }
    # Set-Acl can request audit/owner privileges under Windows PowerShell 5.1.
    # We change only access rules, never the owner, group, or auditing policy.
    $sections = [System.Security.AccessControl.AccessControlSections]::Access
    $accessOnly.SetSecurityDescriptorSddlForm($Acl.GetSecurityDescriptorSddlForm($sections), $sections)
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
        $item.SetAccessControl($accessOnly)
    } else {
        [System.IO.FileSystemAclExtensions]::SetAccessControl($item, $accessOnly)
    }
}

function Get-OwnedPath([string]$Root, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative.Contains('\') -or
        $Relative -match '[:*?"<>|\x00-\x1f]' -or
        @($Relative.Split('/') | Where-Object { $_ -in @('', '.', '..') -or $_.EndsWith('.') -or $_.EndsWith(' ') }).Count -gt 0 -or
        ($Relative -notin $APP_FILES -and $Relative -notmatch '^(assets|scripts)/')) {
        throw 'Invalid ownership manifest path.'
    }
    $result = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    Assert-NoReparse $result
    return $result
}

function Get-FileHashSha256([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return '' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [IO.File]::ReadAllBytes($Path)
        $hashBytes = $sha.ComputeHash($bytes)
        return [BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-NativeInstallJsContent([string]$collectionName, [string]$programUuid, [string]$cameraAUuid, [string]$cameraBUuid, [string]$graphicsUuid, [string]$connectionScript) {
    $escapedCol = ConvertTo-Json $collectionName
    $escapedScript = ConvertTo-Json $connectionScript
    return "window.EmberstageNativeInstall = {
  version: 1,
  collection: $escapedCol,
  connectionScript: $escapedScript,
  program: {
    name: 'Emberstage Program',
    uuid: '$programUuid'
  },
  slots: [
    {
      name: 'Emberstage Camera A',
      uuid: '$cameraAUuid'
    },
    {
      name: 'Emberstage Camera B',
      uuid: '$cameraBUuid'
    }
  ],
  graphics: {
    name: 'Emberstage Graphics',
    uuid: '$graphicsUuid'
  }
};
"
}

function Get-SourceFiles {
    $files = New-Object 'System.Collections.Generic.List[object]'
    foreach ($file in $APP_FILES) {
        $p = Join-Path $repoRoot $file
        if ([IO.File]::Exists($p)) {
            $files.Add([pscustomobject]@{ RelativePath = $file; FullPath = $p })
        }
    }
    foreach ($dir in $APP_DIRS) {
        $dirPath = Join-Path $repoRoot $dir
        if ([IO.Directory]::Exists($dirPath)) {
            $entries = @(Get-ChildItem -LiteralPath $dirPath -Recurse -Force -ErrorAction Stop)
            foreach ($entry in $entries) { Assert-NoReparse $entry.FullName }
            $foundFiles = @($entries | Where-Object { -not $_.PSIsContainer })
            foreach ($f in $foundFiles) {
                if ($f.FullName -match '__pycache__' -or $f.Extension -eq '.pyc') { continue }
                $fullFile = [IO.Path]::GetFullPath($f.FullName)
                $prefix = [IO.Path]::GetFullPath($repoRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
                if ($fullFile.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                    $rel = $fullFile.Substring($prefix.Length).Replace('\', '/')
                    $files.Add([pscustomobject]@{ RelativePath = $rel; FullPath = $fullFile })
                }
            }
        }
    }
    return $files
}

function Get-AppManifest([string]$root) {
    $manifestFiles = New-Object 'System.Collections.Generic.List[object]'
    foreach ($file in $APP_FILES) {
        $p = Join-Path $root $file
        if ([IO.File]::Exists($p)) {
            [void]$manifestFiles.Add([pscustomobject]@{
                path = $file
                sha256 = Get-FileHashSha256 $p
            })
        }
    }
    foreach ($dir in $APP_DIRS) {
        $dirPath = Join-Path $root $dir
        if ([IO.Directory]::Exists($dirPath)) {
            $foundFiles = Get-ChildItem -Path $dirPath -File -Recurse -ErrorAction Stop
            foreach ($f in $foundFiles) {
                if ($f.FullName -match '__pycache__' -or $f.Extension -eq '.pyc') { continue }
                $fullRoot = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
                $fullFile = [IO.Path]::GetFullPath($f.FullName)
                if ($fullFile.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
                    $rel = $fullFile.Substring($fullRoot.Length).Replace('\', '/')
                    [void]$manifestFiles.Add([pscustomobject]@{
                        path = $rel
                        sha256 = Get-FileHashSha256 $f.FullName
                    })
                }
            }
        }
    }
    $sortedFiles = $manifestFiles | Sort-Object { $_.path }
    return [pscustomobject]@{ files = @($sortedFiles) }
}

# Run validations
$AppInstallPath = [IO.Path]::GetFullPath($AppInstallPath)
Validate-AppInstallPath $AppInstallPath $repoRoot $configRoot
if ($Repair -and $Uninstall) { throw 'Choose Repair or Uninstall, not both.' }
Assert-NoReparse $AppInstallPath
Assert-NoReparse $configRoot

# Compute private sibling paths
$appParent = [IO.Path]::GetDirectoryName($AppInstallPath)
if ([IO.Path]::GetFileName($AppInstallPath) -eq 'app' -and [IO.Path]::GetFileName($appParent) -eq 'Emberstage') {
    $appParent = [IO.Path]::GetDirectoryName($appParent)
}
$privateDir = Join-Path $appParent 'Emberstage-private'
$privateScript = Join-Path $privateDir 'obs-connection.js'

if ($Apply) { Assert-ObsClosed }

if (-not $Uninstall) {
    foreach ($file in $APP_FILES) {
        if (-not [IO.File]::Exists((Join-Path $repoRoot $file))) {
            throw "Required app file missing: $file. Use a complete app checkout; nothing was installed."
        }
    }
    $luaRepoPath = Join-Path $repoRoot 'scripts/media-deck-hotkeys.lua'
    if (-not [IO.File]::Exists($luaRepoPath)) {
        throw "Required app file missing: scripts/media-deck-hotkeys.lua. Use a complete app checkout; nothing was installed."
    }
}

# Load existing manifest if present to detect user-added/modified files
$existingManifest = @{}
$manifestPath = Join-Path $AppInstallPath 'install-manifest.json'
if ([IO.File]::Exists($manifestPath)) {
    Assert-NoReparse $manifestPath
    $manifestObj = Read-JsonObject (Read-ConfigText $manifestPath) 'ownership manifest'
    if (-not (Has-Key $manifestObj 'files') -or $manifestObj.files -isnot [array]) { throw 'Invalid ownership manifest files.' }
    foreach ($f in $manifestObj.files) {
        if ($f -isnot [pscustomobject] -or -not (Has-Key $f 'path') -or -not (Has-Key $f 'sha256') -or
            $f.path -isnot [string] -or $f.sha256 -isnot [string] -or $f.sha256 -notmatch '^[a-f0-9]{64}$' -or
            $existingManifest.ContainsKey($f.path)) { throw 'Invalid or duplicate ownership manifest entry.' }
        [void](Get-OwnedPath $AppInstallPath $f.path)
        $existingManifest[$f.path] = $f.sha256
    }
}
if ($Repair -and -not [IO.File]::Exists($manifestPath)) { throw 'Repair requires an installed ownership manifest. Run Setup again.' }

$staticChanged = $false
if (-not $Uninstall) {
    $sourceFiles = @(Get-SourceFiles)
    foreach ($sf in $sourceFiles) {
        Assert-NoReparse $sf.FullPath
        [void](Get-OwnedPath $AppInstallPath $sf.RelativePath)
    }
    foreach ($sf in $sourceFiles) {
        $destPath = Join-Path $AppInstallPath $sf.RelativePath
        if (-not [IO.File]::Exists($destPath)) {
            $staticChanged = $true
            break
        } else {
            $currentHash = Get-FileHashSha256 $destPath
            $repoHash = Get-FileHashSha256 $sf.FullPath
            if ($currentHash -ne $repoHash) {
                $isUserModified = $false
                if ($existingManifest.ContainsKey($sf.RelativePath)) {
                    if ($currentHash -ne $existingManifest[$sf.RelativePath]) {
                        $isUserModified = $true
                    }
                } else {
                    $isUserModified = $true
                }
                
                if (-not $isUserModified) {
                    $staticChanged = $true
                    break
                }
            }
        }
    }
}
$appChanged = $staticChanged

$expectedJsContent = $null
$jsFilePath = $null
$skipConfigChanges = $false
if (-not [IO.Directory]::Exists($configRoot)) {
    if ($Uninstall) {
        $skipConfigChanges = $true
    } else {
        throw 'OBS config directory is missing. Start and configure OBS yourself once, then close it; or specify -ObsConfigPath.'
    }
}

$iniPath = Join-Path $configRoot 'user.ini'
if (-not [IO.File]::Exists($iniPath)) {
    if ($Uninstall) {
        $skipConfigChanges = $true
    } else {
        throw 'user.ini is missing. Select a scene collection in OBS yourself, close OBS, and retry.'
    }
}

if (-not $skipConfigChanges) {
    # Generate Config Change Plans
    if ($Uninstall) {
        # Config plans for Uninstall
        $ini = Read-ConfigText $iniPath
        $docksRecord = Get-IniRecord $ini 'BasicWindow' 'ExtraBrowserDocks'
        if ($null -ne $docksRecord.Entry -and -not [string]::IsNullOrWhiteSpace($docksRecord.Entry.Value)) {
            $dockJson = Decode-IniString $docksRecord.Entry.Value
            $wrapper = Read-JsonObject ('{"items":' + $dockJson + '}') 'ExtraBrowserDocks'
            if ($wrapper.items -is [array]) {
                $docks = New-Object 'System.Collections.Generic.List[object]'
                $docksChanged = $false
                $ownedUuids = @(
                    '4d4445434b534352495054555245000001',
                    '4d4445434b534f4e475300000000000002',
                    '4d4445434b564944454f00000000000003',
                    '4d4445434b53545245414d494e47000006',
                    '4d4445434b534554555000000000000005'
                )
                foreach ($dock in $wrapper.items) {
                    if ($dock -is [pscustomobject]) {
                        if ((Has-Key $dock 'uuid') -and ($dock.uuid -in $ownedUuids)) {
                            $docksChanged = $true
                        } else {
                            $docks.Add($dock)
                        }
                    }
                }
                if ($docksChanged) {
                    $newIni = Set-IniValue $ini 'BasicWindow' 'ExtraBrowserDocks' (Encode-IniString (To-Json @($docks.ToArray())))
                    Add-Plan $iniPath 'user.ini' $newIni 'Remove Emberstage browser docks.' -PreserveBom
                }
            }
        }

        # Scan all collections to remove script registration
        $scenesDir = Join-Path $configRoot 'basic/scenes'
        if ([IO.Directory]::Exists($scenesDir)) {
            $jsonFiles = Get-ChildItem -Path $scenesDir -Filter '*.json' -File -ErrorAction Stop
            foreach ($jf in $jsonFiles) {
                $colPath = $jf.FullName
                $colRel = 'basic/scenes/' + $jf.Name
                if ([IO.File]::Exists($colPath)) {
                    $colText = Read-ConfigText $colPath
                    $col = Read-JsonObject $colText $jf.Name
                    if ((Has-Key $col 'modules') -and $col.modules -is [pscustomobject] -and (Has-Key $col.modules 'scripts-tool')) {
                        $scripts = $col.modules.PSObject.Properties['scripts-tool'].Value
                        if ($scripts -is [array]) {
                            $newScripts = New-Object 'System.Collections.Generic.List[object]'
                            $scriptsChanged = $false
                            foreach ($script in $scripts) {
                                if ($script -is [pscustomobject] -and (Has-Key $script 'path') -and $script.path -is [string]) {
                                    $scriptName = [IO.Path]::GetFileName($script.path.Replace('\', '/'))
                                    if ($scriptName -eq 'media-deck-hotkeys.lua') {
                                        $scriptsChanged = $true
                                    } else {
                                        $newScripts.Add($script)
                                    }
                                } else {
                                    $newScripts.Add($script)
                                }
                            }
                            if ($scriptsChanged) {
                                Set-Key $col.modules 'scripts-tool' @($newScripts.ToArray())
                                Add-Plan $colPath $colRel (To-Json $col) "Remove Lua script from collection $($jf.Name)."
                            }
                        }
                    }
                }
            }
        }
    } else {
        # Config plans for Install / Repair
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

        $appInstallFullPath = [IO.Path]::GetFullPath($AppInstallPath)
        $dockSpecs = @(
            @{ uuid = '4d4445434b534352495054555245000001'; title = 'Em - Text'; file = 'control_panel.html'; query = '' },
            @{ uuid = '4d4445434b534f4e475300000000000002'; title = 'Em - Media'; file = 'media_dock.html'; query = '' },
            @{ uuid = '4d4445434b564944454f00000000000003'; title = 'Em - Cameras'; file = 'camera_dock.html'; query = '' },
            @{ uuid = '4d4445434b53545245414d494e47000006'; title = 'Em - Streaming'; file = 'streaming_dock.html'; query = '' }
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
        for ($i = $docks.Count - 1; $i -ge 0; $i--) {
            if ((Has-Key $docks[$i] 'uuid') -and $docks[$i].uuid -eq '4d4445434b534554555000000000000005') {
                $docks.RemoveAt($i)
                $docksChanged = $true
            }
        }
        foreach ($spec in $dockSpecs) {
            $url = [System.Uri]::new([IO.Path]::GetFullPath((Join-Path $appInstallFullPath $spec.file)), [UriKind]::Absolute).AbsoluteUri + $spec.query
            if (-not $url.StartsWith('file:///')) { throw "URL is '$url'. App files must resolve to local file:/// URLs, not a network share." }
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
        $addedSources = New-Object 'System.Collections.Generic.List[string]'
        $addedItems = New-Object 'System.Collections.Generic.List[string]'
        $repointedSources = New-Object 'System.Collections.Generic.List[string]'

        if (-not (Has-Key $collection 'sources')) { Set-Key $collection 'sources' @() }
        if ($collection.sources -isnot [array]) { throw 'Scene collection sources must be an array.' }
        $sources = New-Object 'System.Collections.Generic.List[object]'
        foreach ($s in $collection.sources) { $sources.Add($s) }

        # 1. Collision and UUID resolution
        $newSourcesData = @{
            'program' = @{ name = 'Emberstage Program'; id = 'scene'; role = 'program'; uuid = $null; source_obj = $null; is_new = $true }
            'camera-a' = @{ name = 'Emberstage Camera A'; id = 'scene'; role = 'camera-a'; uuid = $null; source_obj = $null; is_new = $true }
            'camera-b' = @{ name = 'Emberstage Camera B'; id = 'scene'; role = 'camera-b'; uuid = $null; source_obj = $null; is_new = $true }
            'graphics' = @{ name = 'Emberstage Graphics'; id = 'browser_source'; role = 'graphics'; uuid = $null; source_obj = $null; is_new = $true }
        }

        $expectedNames = @('Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B', 'Emberstage Graphics')
        $uuidRegex = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

        # Gather all UUIDs to check for uniqueness
        $allUuidsInCollection = @{}
        $roleUuids = @{}
        foreach ($src in $sources) {
            if ($src -isnot [pscustomobject]) { continue }
            $u = $null
            if (Has-Key $src 'uuid') { $u = $src.uuid }
            $name = $null
            if (Has-Key $src 'name') { $name = $src.name }

            if ($null -ne $u) {
                if ($u -isnot [string] -or $u -eq "") {
                    if ($name -in $expectedNames) {
                        throw "Collision/malformed: source '$name' has empty or invalid UUID. No changes were made."
                    }
                } else {
                    if (-not $allUuidsInCollection.ContainsKey($u)) {
                        $allUuidsInCollection[$u] = New-Object 'System.Collections.Generic.List[string]'
                    }
                    $allUuidsInCollection[$u].Add($name)
                    if ($name -in $expectedNames) {
                        $roleUuids[$name] = $u
                    }
                }
            } else {
                if ($name -in $expectedNames) {
                    throw "Collision/malformed: source '$name' has empty or invalid UUID. No changes were made."
                }
            }
        }

        # Check for duplicate UUIDs
        foreach ($u in $allUuidsInCollection.Keys) {
            $names = $allUuidsInCollection[$u]
            if ($names.Count -gt 1) {
                $hasExpected = $false
                foreach ($n in $names) { if ($n -in $expectedNames) { $hasExpected = $true; break } }
                if ($hasExpected) {
                    throw "Collision/malformed: duplicate UUID '$u' found for sources: $($names -join ', '). No changes were made."
                }
            }
        }

        # Verify source reference consistency in scene items
        foreach ($src in $sources) {
            if ($src -isnot [pscustomobject] -or -not (Has-Key $src 'id') -or $src.id -ne 'scene') { continue }
            if (-not (Has-Key $src 'settings') -or $src.settings -isnot [pscustomobject]) { continue }
            $settings = $src.settings
            if (-not (Has-Key $settings 'items') -or $settings.items -isnot [array]) { continue }
            foreach ($item in $settings.items) {
                if ($item -isnot [pscustomobject]) { continue }
                $itemName = $null
                if (Has-Key $item 'name') { $itemName = $item.name }
                $itemUuid = $null
                if (Has-Key $item 'source_uuid') { $itemUuid = $item.source_uuid }

                if ($itemName -in $expectedNames) {
                    if ($roleUuids.ContainsKey($itemName)) {
                        $expectedRoleU = $roleUuids[$itemName]
                        if ($itemUuid -ne $expectedRoleU) {
                            throw "Collision/malformed: reference mismatch in scene '$($src.name)' for item '$itemName'. Item references UUID '$itemUuid', but source UUID is '$expectedRoleU'. No changes were made."
                        }
                    }
                }

                foreach ($roleName in $roleUuids.Keys) {
                    $roleU = $roleUuids[$roleName]
                    if ($itemUuid -eq $roleU -and $itemName -ne $roleName) {
                        throw "Collision/malformed: reference mismatch in scene '$($src.name)' for item '$itemName'. Item references UUID '$itemUuid' belonging to '$roleName'. No changes were made."
                    }
                }
            }
        }

        $allSourceNames = @{}
        foreach ($src in $sources) {
            if ($src -is [pscustomobject] -and (Has-Key $src 'name') -and $src.name -is [string]) {
                if (-not $allSourceNames.ContainsKey($src.name)) {
                    $allSourceNames[$src.name] = New-Object 'System.Collections.Generic.List[object]'
                }
                $allSourceNames[$src.name].Add($src)
            }
        }

        foreach ($key in $newSourcesData.Keys) {
            $spec = $newSourcesData[$key]
            $name = $spec.name
            if ($allSourceNames.ContainsKey($name)) {
                $matches = $allSourceNames[$name]
                if ($matches.Count -gt 1) {
                    throw "Ambiguous collision: multiple sources found with name '$name'. No changes were made."
                }
                $src = $matches[0]
                if (-not (Has-Key $src 'id') -or $src.id -ne $spec.id) {
                    throw "Name collision: source '$name' exists but is of type '$($src.id)', expected '$($spec.id)'. No changes were made."
                }
                $hasPS = Has-Key $src 'private_settings'
                if (-not $hasPS) {
                    throw "Collision: source '$name' has invalid private_settings. No changes were made."
                }
                $private_settings = $src.private_settings
                if ($private_settings -isnot [pscustomobject]) {
                    throw "Collision: source '$name' has invalid private_settings. No changes were made."
                }
                $hasEN = Has-Key $private_settings 'emberstage_native'
                if (-not $hasEN) {
                    throw "Collision any same name/type/marker mismatch -> refuse before writes: source '$name' does not have a valid native marker. No changes were made."
                }
                $marker = $private_settings.emberstage_native
                if ($marker -isnot [pscustomobject]) {
                    throw "Collision any same name/type/marker mismatch -> refuse before writes: source '$name' does not have a valid native marker. No changes were made."
                }
                $hasVer = Has-Key $marker 'version'
                $hasRole = Has-Key $marker 'role'
                $versionOk = $false
                $roleOk = $false
                if ($hasVer -and $marker.version -eq 1) { $versionOk = $true }
                if ($hasRole -and $marker.role -eq $spec.role) { $roleOk = $true }
                if (-not $versionOk -or -not $roleOk) {
                    throw "Collision any same name/type/marker mismatch -> refuse before writes: source '$name' does not have a valid native marker. No changes were made."
                }

                $existingU = $src.uuid
                if ($existingU -isnot [string] -or $existingU -notmatch $uuidRegex) {
                    throw "Collision/malformed: source '$name' has empty or invalid UUID. No changes were made."
                }

                $spec.uuid = $existingU
                $spec.source_obj = $src
                $spec.is_new = $false
            }
        }

        foreach ($key in $newSourcesData.Keys) {
            $spec = $newSourcesData[$key]
            if ($null -eq $spec.uuid) {
                $spec.uuid = [guid]::NewGuid().ToString()
            }
        }

        # 2. Get video defaults
        $baseWidth = 1920
        $baseHeight = 1080
        $profileDims = Get-ProfileCanvasDimensions $configRoot $ini
        if ($null -ne $profileDims) {
            $baseWidth = $profileDims[0]
            $baseHeight = $profileDims[1]
        } else {
            if ((Has-Key $collection 'video') -and $collection.video -is [pscustomobject]) {
                $video = $collection.video
                if ((Has-Key $video 'base_width') -and (Has-Key $video 'base_height') -and 
                    ($video.base_width -is [int] -or $video.base_width -is [double] -or $video.base_width -is [long] -or $video.base_width -is [decimal]) -and
                    ($video.base_height -is [int] -or $video.base_height -is [double] -or $video.base_height -is [long] -or $video.base_height -is [decimal])) {
                    $baseWidth = [int]$video.base_width
                    $baseHeight = [int]$video.base_height
                }
            }
        }

        # 3. Create or update sources
        foreach ($key in @('program', 'camera-a', 'camera-b', 'graphics')) {
            $spec = $newSourcesData[$key]
            $name = $spec.name
            $sourceUuid = $spec.uuid
            $src = $spec.source_obj

            if ($null -eq $src) {
                $src = [pscustomobject]@{
                    name = $name
                    id = $spec.id
                    uuid = $sourceUuid
                    private_settings = [pscustomobject]@{
                        emberstage_native = [pscustomobject]@{
                            version = 1
                            role = $spec.role
                        }
                    }
                    settings = [pscustomobject]@{}
                }
                $sources.Add($src)
                $spec.source_obj = $src
                $collectionChanged = $true
                $addedSources.Add($name)
            } else {
                if (-not (Has-Key $src 'uuid') -or $src.uuid -ne $sourceUuid) {
                    Set-Key $src 'uuid' $sourceUuid
                    $collectionChanged = $true
                }
                if (-not (Has-Key $src 'private_settings') -or $src.private_settings -isnot [pscustomobject]) {
                    Set-Key $src 'private_settings' ([pscustomobject]@{})
                }
                $p_settings = $src.private_settings
                if (-not (Has-Key $p_settings 'emberstage_native') -or $p_settings.emberstage_native -isnot [pscustomobject] -or 
                    $p_settings.emberstage_native.version -ne 1 -or $p_settings.emberstage_native.role -ne $spec.role) {
                    Set-Key $p_settings 'emberstage_native' ([pscustomobject]@{ version = 1; role = $spec.role })
                    $collectionChanged = $true
                }
            }

            if ($spec.role -eq 'graphics') {
                $outputUrl = [System.Uri]::new([IO.Path]::GetFullPath((Join-Path $appInstallFullPath 'emberstage_output.html')), [UriKind]::Absolute).AbsoluteUri
                if (-not (Has-Key $src 'settings') -or $src.settings -isnot [pscustomobject]) {
                    Set-Key $src 'settings' ([pscustomobject]@{})
                }
                $settings = $src.settings
                $needsChange = $false
                if (-not (Has-Key $settings 'is_local_file') -or $settings.is_local_file -ne $false) { $needsChange = $true }
                if (-not (Has-Key $settings 'local_file') -or $settings.local_file -ne '') { $needsChange = $true }
                if (-not (Has-Key $settings 'url') -or $settings.url -ne $outputUrl) { $needsChange = $true }
                if (-not (Has-Key $settings 'width') -or $settings.width -ne $baseWidth) { $needsChange = $true }
                if (-not (Has-Key $settings 'height') -or $settings.height -ne $baseHeight) { $needsChange = $true }
                if (-not (Has-Key $settings 'shutdown') -or $settings.shutdown -ne $true) { $needsChange = $true }

                if ($needsChange) {
                    Set-Key $settings 'is_local_file' $false
                    Set-Key $settings 'local_file' ''
                    Set-Key $settings 'url' $outputUrl
                    Set-Key $settings 'width' $baseWidth
                    Set-Key $settings 'height' $baseHeight
                    Set-Key $settings 'shutdown' $true
                    $collectionChanged = $true
                    $repointedSources.Add($name)
                }
            } elseif ($spec.role -eq 'camera-a' -or $spec.role -eq 'camera-b') {
                if ($spec.is_new) {
                    if (-not (Has-Key $src 'settings') -or $src.settings -isnot [pscustomobject]) {
                        Set-Key $src 'settings' ([pscustomobject]@{})
                    }
                    $settings = $src.settings
                    Set-Key $settings 'items' @()
                    
                    # Setup Emberstage Opacity Filter
                    $expectedFilters = @(
                        [pscustomobject]@{
                            enabled = $true
                            id = 'color_filter_v2'
                            name = 'Emberstage Opacity'
                            settings = [pscustomobject]@{
                                opacity = [double]1.0
                            }
                        }
                    )
                    Set-Key $src 'filters' $expectedFilters
                    $collectionChanged = $true
                }
            } elseif ($spec.role -eq 'program') {
                if ($spec.is_new) {
                    if (-not (Has-Key $src 'settings') -or $src.settings -isnot [pscustomobject]) {
                        Set-Key $src 'settings' ([pscustomobject]@{})
                    }
                    $settings = $src.settings
                    $expectedItems = @(
                        [pscustomobject]@{
                            name = 'Emberstage Camera A'
                            id = 1
                            source_uuid = $newSourcesData['camera-a'].uuid
                            visible = $false
                            locked = $false
                            pos = [pscustomobject]@{ x = [double]0.0; y = [double]0.0 }
                            rot = [double]0.0
                            scale = [pscustomobject]@{ x = [double]1.0; y = [double]1.0 }
                            align = 5
                            bounds_type = 0
                            bounds_align = 5
                            bounds = [pscustomobject]@{ x = [double]0.0; y = [double]0.0 }
                            crop_left = 0
                            crop_right = 0
                            crop_top = 0
                            crop_bottom = 0
                        },
                        [pscustomobject]@{
                            name = 'Emberstage Camera B'
                            id = 2
                            source_uuid = $newSourcesData['camera-b'].uuid
                            visible = $false
                            locked = $false
                            pos = [pscustomobject]@{ x = [double]0.0; y = [double]0.0 }
                            rot = [double]0.0
                            scale = [pscustomobject]@{ x = [double]1.0; y = [double]1.0 }
                            align = 5
                            bounds_type = 0
                            bounds_align = 5
                            bounds = [pscustomobject]@{ x = [double]0.0; y = [double]0.0 }
                            crop_left = 0
                            crop_right = 0
                            crop_top = 0
                            crop_bottom = 0
                        },
                        [pscustomobject]@{
                            name = 'Emberstage Graphics'
                            id = 3
                            source_uuid = $newSourcesData['graphics'].uuid
                            visible = $true
                            locked = $false
                            pos = [pscustomobject]@{ x = [double]0.0; y = [double]0.0 }
                            rot = [double]0.0
                            scale = [pscustomobject]@{ x = [double]1.0; y = [double]1.0 }
                            align = 5
                            bounds_type = 0
                            bounds_align = 5
                            bounds = [pscustomobject]@{ x = [double]0.0; y = [double]0.0 }
                            crop_left = 0
                            crop_right = 0
                            crop_top = 0
                            crop_bottom = 0
                        }
                    )
                    Set-Key $settings 'items' $expectedItems
                    Set-Key $settings 'id_counter' 3
                    $collectionChanged = $true
                }
            }
        }
        Set-Key $collection 'sources' @($sources.ToArray())

        # 4. Handle scene_order
        if (-not (Has-Key $collection 'scene_order') -or $collection.scene_order -isnot [array]) {
            Set-Key $collection 'scene_order' @()
        }
        $sceneOrder = New-Object 'System.Collections.Generic.List[object]'
        foreach ($so in $collection.scene_order) { $sceneOrder.Add($so) }
        foreach ($scene_name in @('Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B')) {
            $hasScene = $false
            foreach ($so in $sceneOrder) {
                if ($so -is [pscustomobject] -and (Has-Key $so 'name') -and $so.name -eq $scene_name) {
                    $hasScene = $true
                    break
                }
            }
            if (-not $hasScene) {
                $sceneOrder.Add([pscustomobject]@{ name = $scene_name })
                $collectionChanged = $true
            }
        }
        Set-Key $collection 'scene_order' @($sceneOrder.ToArray())

        # 5. Resolve current_scene safely
        if (-not (Has-Key $collection 'current_scene') -or $collection.current_scene -isnot [string] -or [string]::IsNullOrEmpty($collection.current_scene)) {
            throw 'Missing or invalid current_scene name in scene collection. No changes were made.'
        }
        $currentSceneName = $collection.current_scene

        if ($currentSceneName -notin @('Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B')) {
            $sceneObjs = New-Object 'System.Collections.Generic.List[object]'
            foreach ($s in $sources) {
                if ($s -is [pscustomobject] -and (Has-Key $s 'id') -and $s.id -eq 'scene' -and (Has-Key $s 'name') -and $s.name -eq $currentSceneName) {
                    $sceneObjs.Add($s)
                }
            }
            if ($sceneObjs.Count -eq 0) {
                throw "Current scene '$currentSceneName' not found as a scene source object in the collection. No changes were made."
            }
            if ($sceneObjs.Count -gt 1) {
                throw "Ambiguity: multiple scene sources found with name '$currentSceneName'. No changes were made."
            }
            $currentSceneObj = $sceneObjs[0]
            if (-not (Has-Key $currentSceneObj 'settings') -or $currentSceneObj.settings -isnot [pscustomobject]) {
                throw 'Current scene source has invalid settings field. No changes were made.'
            }
            $sceneSettings = $currentSceneObj.settings
            if (-not (Has-Key $sceneSettings 'items')) {
                Set-Key $sceneSettings 'items' @()
            }
            if ($sceneSettings.items -isnot [array]) {
                throw 'Current scene settings/items is not a list. No changes were made.'
            }
            $sceneItems = New-Object 'System.Collections.Generic.List[object]'
            foreach ($item in $sceneSettings.items) { $sceneItems.Add($item) }

            [long]$idCounter = 0
            if (Has-Key $sceneSettings 'id_counter') {
                if (($sceneSettings.id_counter -isnot [int] -and $sceneSettings.id_counter -isnot [long]) -or $sceneSettings.id_counter -lt 0) {
                    throw 'Invalid current scene item counter; nothing was changed.'
                }
                $idCounter = $sceneSettings.id_counter
            }
            foreach ($item in $sceneItems) {
                if ($item -is [pscustomobject] -and (Has-Key $item 'id') -and ($item.id -is [int] -or $item.id -is [long])) {
                    $idCounter = [Math]::Max($idCounter, [long]$item.id)
                }
            }

            # 6. Add program scene to current scene items as a hidden nested scene item if not present
            $programUuid = $newSourcesData['program'].uuid
            $programName = $newSourcesData['program'].name

            $existingItem = $null
            foreach ($item in $sceneItems) {
                if ($item -is [pscustomobject] -and (((Has-Key $item 'name') -and $item.name -eq $programName) -or ((Has-Key $item 'source_uuid') -and $item.source_uuid -eq $programUuid))) {
                    if ((Has-Key $item 'source_uuid') -and $item.source_uuid -and $item.source_uuid -ne $programUuid) {
                        throw "Conflicting scene item source identity: $programName; nothing was changed."
                    }
                    $existingItem = $item
                    break
                }
            }

            if ($null -eq $existingItem) {
                $idCounter++
                $newItem = [pscustomobject]@{
                    name = $programName
                    id = $idCounter
                    source_uuid = $programUuid
                    visible = $false
                    locked = $false
                    pos = [pscustomobject]@{ x = [double]0.0; y = [double]0.0 }
                    rot = [double]0.0
                    scale = [pscustomobject]@{ x = [double]1.0; y = [double]1.0 }
                    align = 5
                    bounds_type = 0
                    bounds_align = 5
                    bounds = [pscustomobject]@{ x = [double]0.0; y = [double]0.0 }
                    crop_left = 0
                    crop_right = 0
                    crop_top = 0
                    crop_bottom = 0
                }
                $sceneItems.Add($newItem)
                $addedItems.Add($programName)
                $collectionChanged = $true
                Set-Key $sceneSettings 'id_counter' $idCounter
            }
            Set-Key $sceneSettings 'items' @($sceneItems.ToArray())
        }

        # 7. Setup Lua Script Registration
        if (-not (Has-Key $collection 'modules')) {
            Set-Key $collection 'modules' ([pscustomobject]@{}); $collectionChanged = $true
        }
        if ($collection.modules -isnot [pscustomobject]) { throw 'Scene collection modules must be a JSON object.' }
        if (-not (Has-Key $collection.modules 'scripts-tool')) {
            Set-Key $collection.modules 'scripts-tool' @(); $collectionChanged = $true
        }
        $scripts = $collection.modules.PSObject.Properties['scripts-tool'].Value
        if ($scripts -isnot [array]) { throw 'Scene collection modules/scripts-tool must be an array.' }
        $luaPath = [IO.Path]::GetFullPath((Join-Path $appInstallFullPath 'scripts/media-deck-hotkeys.lua'))
        $existingLua = @()
        foreach ($script in $scripts) {
            if ($script -isnot [pscustomobject] -or -not (Has-Key $script 'path') -or $script.path -isnot [string]) {
                throw 'Scene collection contains an invalid script entry; nothing was changed.'
            }
            try { $normalized = [IO.Path]::GetFullPath($script.path.Replace('\', '/')) }
            catch { $normalized = '' }
            if ($normalized -eq $luaPath -or [IO.Path]::GetFileName($script.path.Replace('\', '/')) -eq 'media-deck-hotkeys.lua') {
                $existingLua += $script
            }
        }
        if ($existingLua.Count -gt 1) { throw 'The Media Deck Lua script is registered more than once. Resolve duplicate entries manually.' }
        $luaMigrated = $false
        if ($existingLua.Count -eq 1) {
            try { $registeredLuaPath = [IO.Path]::GetFullPath($existingLua[0].path.Replace('\', '/')) }
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

        # 7.5. Process OBS WebSocket config and prepare private connection script
        # WebSocket is configured by default now (automatic default, compatibility accepted)
        $wsRelative = 'plugin_config/obs-websocket/config.json'
        $wsPath = Join-Path $configRoot $wsRelative
        $ws = [pscustomobject]@{}
        $wsBom = $false
        if ([IO.File]::Exists($wsPath)) {
            try {
                $ws = Read-JsonObject (Read-ConfigText $wsPath) 'WebSocket config'
            } catch {
                throw "WebSocket config is malformed: $_" # Malformed config fail closed
            }
        }
        
        $wsChanged = $false
        foreach ($key in @('server_enabled', 'auth_required')) {
            if (-not (Has-Key $ws $key) -or $ws.PSObject.Properties[$key].Value -isnot [bool] -or $ws.PSObject.Properties[$key].Value -ne $true) {
                Set-Key $ws $key $true; $wsChanged = $true
            }
        }

        # Validate/preserve server_port
        $wsPort = 4455
        if (Has-Key $ws 'server_port') {
            try {
                $val = $ws.server_port
                if ($val -match '^\d+$') {
                    $wsPort = [int]$val
                } else {
                    $wsPort = $val
                }
                if ($wsPort -lt 1 -or $wsPort -gt 65535) {
                    throw "Invalid WebSocket server_port"
                }
                Set-Key $ws 'server_port' $wsPort
            } catch {
                throw "Invalid WebSocket server_port. Malformed config fail closed."
            }
        } else {
            Set-Key $ws 'server_port' $wsPort
        }

        # Preserve binds (reject known explicit non-loopback incompatible bind, not wildcard binding)
        foreach ($key in @('server_ip', 'bind_ip', 'bind_addr', 'listen_ip', 'listen_addr')) {
            if (Has-Key $ws $key) {
                $ipVal = $ws.PSObject.Properties[$key].Value
                if ($null -ne $ipVal -and $ipVal -is [string] -and -not [string]::IsNullOrWhiteSpace($ipVal)) {
                    $ipClean = $ipVal.Trim().ToLower()
                    if ($ipClean -ne '' -and $ipClean -notin @('0.0.0.0', '::', '*', '127.0.0.1', '::1', 'localhost')) {
                        throw "Incompatible explicit non-loopback bind '$ipVal' is not supported."
                    }
                }
            }
        }

        # Manage server_password
        if ((Has-Key $ws 'server_password') -and $null -ne $ws.server_password -and $ws.server_password -isnot [string]) {
            throw 'WebSocket server_password must be a string; existing settings were not changed.'
        }
        $generatedPassword = $null
        if (-not (Has-Key $ws 'server_password') -or [string]::IsNullOrWhiteSpace($ws.server_password)) {
            $generatedPassword = 'GENERATED_ONLY_ON_APPLY'
            if ($Apply) {
                $random = [Security.Cryptography.RandomNumberGenerator]::Create()
                try {
                    $secretBytes = New-Object byte[] 32
                    $random.GetBytes($secretBytes)
                    $generatedPassword = [Convert]::ToBase64String($secretBytes)
                } finally { $random.Dispose() }
            }
            Set-Key $ws 'server_password' $generatedPassword; $wsChanged = $true
        }

        $wsPasswordForScript = $ws.server_password
        if ($wsPasswordForScript -eq 'GENERATED_ONLY_ON_APPLY' -and $null -ne $generatedPassword) {
            $wsPasswordForScript = $generatedPassword
        }

        if ($wsChanged) {
            Add-Plan $wsPath $wsRelative (To-Json $ws) 'Enable WebSocket with authentication; preserve a nonempty password or generate one securely.'
        }

        # Compute private sibling paths
        $privateScriptUri = [System.Uri]::new([IO.Path]::GetFullPath($privateScript), [UriKind]::Absolute).AbsoluteUri

        $escapedPassword = ConvertTo-Json $wsPasswordForScript
        $privateJsContent = "window.EmberstageNativeConnection = {
  version: 1,
  port: $wsPort,
  password: $escapedPassword
};
"

        # 8. Compute expected native-install.js and resolve appChanged
        # OBS identifies collections by their display name, not their filename.
        $obsCollectionName = $collection.name
        if ($obsCollectionName -isnot [string] -or [string]::IsNullOrWhiteSpace($obsCollectionName)) {
            throw 'Scene collection display name is missing or invalid.'
        }

        $expectedJsContent = Get-NativeInstallJsContent -collectionName $obsCollectionName -programUuid $newSourcesData['program'].uuid -cameraAUuid $newSourcesData['camera-a'].uuid -cameraBUuid $newSourcesData['camera-b'].uuid -graphicsUuid $newSourcesData['graphics'].uuid -connectionScript $privateScriptUri

        $jsFilePath = Join-Path $AppInstallPath 'assets/js/media/native-install.js'
        $jsMatches = $false
        if ([IO.File]::Exists($jsFilePath)) {
            try {
                $installedJs = [IO.File]::ReadAllText($jsFilePath, [System.Text.Encoding]::UTF8)
                if ($installedJs.Trim() -eq $expectedJsContent.Trim()) {
                    $jsMatches = $true
                }
            } catch {}
        }
        $appChanged = ($staticChanged -or -not $jsMatches)

        # 9. Register Scene Collection Plan
        if ($collectionChanged) {
            $collectionDescParts = New-Object 'System.Collections.Generic.List[string]'
            if ($existingLua.Count -eq 0) {
                $collectionDescParts.Add('Register native Lua in the active collection, initially disarmed with no target or keys.')
            }
            if ($luaMigrated) {
                $collectionDescParts.Add('Repoint the existing Emberstage Lua entry.')
            }
            if ($addedSources.Count -gt 0) {
                $addedList = $addedSources -join ', '
                $collectionDescParts.Add("Create native Emberstage program and camera scenes/sources ($addedList).")
            }
            if ($repointedSources.Count -gt 0) {
                $sourcesList = $repointedSources -join ', '
                $collectionDescParts.Add("Repoint native 'Emberstage Graphics' to stable installed files.")
            }
            if ($addedItems.Count -gt 0) {
                $itemsList = $addedItems -join ', '
                $collectionDescParts.Add("Attach native program scene to current scene '$currentSceneName' ($itemsList).")
            }
            $collectionDescription = $collectionDescParts -join ' '
            if ([string]::IsNullOrWhiteSpace($collectionDescription)) {
                $collectionDescription = 'Update scene collection configurations'
            }
            Add-Plan $collectionPath $collectionRelative (To-Json $collection) $collectionDescription
        }
    }
}

$privateCredentialNeedsRepair = $false
if (-not $Uninstall) {
    if (-not [IO.Directory]::Exists($privateDir)) {
        $privateCredentialNeedsRepair = $true
    } elseif ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        try {
            $dirAcl = Get-Acl $privateDir
            if ($dirAcl.AreAccessRulesProtected -ne $true) {
                $privateCredentialNeedsRepair = $true
            }
        } catch {
            $privateCredentialNeedsRepair = $true
        }
    }

    if (-not [IO.File]::Exists($privateScript)) {
        $privateCredentialNeedsRepair = $true
    } else {
        try {
            $existingContent = [IO.File]::ReadAllText($privateScript)
            $normExisting = $existingContent.Replace("`r`n", "`n").Trim()
            $normExpected = $privateJsContent.Replace("`r`n", "`n").Trim()
            if ($normExisting -ne $normExpected) {
                $privateCredentialNeedsRepair = $true
            }
        } catch {
            $privateCredentialNeedsRepair = $true
        }
        
        if (-not $privateCredentialNeedsRepair -and [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
            try {
                $finalAcl = Get-Acl $privateScript
                if ($finalAcl.AreAccessRulesProtected -ne $true) {
                    $privateCredentialNeedsRepair = $true
                }
            } catch {
                $privateCredentialNeedsRepair = $true
            }
        }
    }
}

$ownedPathsToRemove = @()
$modifiedOwnedPaths = @()
if ($Uninstall) {
    foreach ($relPath in $existingManifest.Keys) {
        $destPath = Join-Path $AppInstallPath $relPath
        if ([IO.File]::Exists($destPath)) {
            $currentHash = Get-FileHashSha256 $destPath
            if ($currentHash -eq $existingManifest[$relPath]) {
                $ownedPathsToRemove += [pscustomobject]@{ Path = $destPath; RelativePath = $relPath }
            } else {
                $modifiedOwnedPaths += [pscustomobject]@{ Path = $destPath; RelativePath = $relPath }
            }
        }
    }
    # Missing ownership evidence never authorizes deletion of app files.
}

# Dry Run Check
if (-not $Apply) {
    $mode = 'DRY RUN'
    Write-Output "$mode - config: $configRoot"
    
    if ($Uninstall) {
        Write-Output "Uninstall planned for AppInstallPath: $AppInstallPath"
        foreach ($item in $ownedPathsToRemove) {
            Write-Output "  [REPLACE-WITH-BACKUP] $($item.Path)"
        }
        foreach ($item in $modifiedOwnedPaths) {
            Write-Output "  [PRESERVE-MODIFIED] $($item.Path)"
        }
        if ([IO.File]::Exists($privateScript)) {
            Write-Output "  [REMOVE-PRIVATE] $privateScript"
        }
    } else {
        if ($appChanged) {
            Write-Output "Install/Upgrade app assets to: $AppInstallPath"
            foreach ($sf in $sourceFiles) {
                $destPath = Join-Path $AppInstallPath $sf.RelativePath
                if ([IO.File]::Exists($destPath)) {
                    $currentHash = Get-FileHashSha256 $destPath
                    if ($existingManifest.ContainsKey($sf.RelativePath) -and $currentHash -ne $existingManifest[$sf.RelativePath]) {
                        Write-Output "  [PRESERVE-MODIFIED] $destPath"
                        continue
                    }
                }
                Write-Output "  [COPY] $($sf.RelativePath)"
            }
        }
    }
    
    foreach ($plan in $plans) {
        Write-Output "  $($plan.Path)`n    $($plan.Description)"
    }
    
    if (-not $EnableWebSocket) {
        Write-Output 'WebSocket config is untouched (opt in with -EnableWebSocket).'
    } else {
        Write-Output 'Keep the OBS WebSocket service private. No firewall or network settings are changed.'
        Write-Output 'After you start OBS yourself, the app connection will configure automatically using the generated connection script. Passwords are never printed here.'
    }
    
    if ($plans.Count -eq 0 -and (-not $appChanged -or $Uninstall) -and -not $privateCredentialNeedsRepair) {
        if ($Uninstall) {
            if ($ownedPathsToRemove.Count -eq 0) {
                Write-Output 'Uninstall: No files or configurations need removal.'
                return
            }
        } else {
            Write-Output 'No changes needed.'
            return
        }
    }
    
    Write-Output 'No files or backups written. Close OBS, inspect this plan, then repeat with -Apply.'
    return
}

# Apply flow
Write-Output "APPLY - config: $configRoot"
if ($plans.Count -eq 0 -and -not $appChanged -and $ownedPathsToRemove.Count -eq 0 -and -not $privateCredentialNeedsRepair) {
    Write-Output 'No changes needed.'
    return
}
Assert-ObsClosed
$configParent = [IO.Path]::GetDirectoryName($configRoot)
if (-not [IO.Directory]::Exists($configParent)) { throw 'The selected config parent directory must exist.' }
$backupRoot = Join-Path $configParent ('media-deck-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))

$written = New-Object 'System.Collections.Generic.List[object]'
$created = New-Object 'System.Collections.Generic.List[string]'
$temps = New-Object 'System.Collections.Generic.List[string]'

$appDirTmp = $null
$previousAppBackupDir = Join-Path $backupRoot 'previous-app'
$appFilesReplaced = New-Object 'System.Collections.Generic.List[object]'
$introducedFiles = New-Object 'System.Collections.Generic.List[string]'
$manifestBackupPath = $null
$manifestWritten = $false
$privateScriptWritten = $false

$privateScriptExisted = [IO.File]::Exists($privateScript)
$privateScriptOriginalBytes = $null
$privateScriptOriginalAcl = $null
if ($privateScriptExisted) {
    $privateScriptOriginalBytes = [IO.File]::ReadAllBytes($privateScript)
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $privateScriptOriginalAcl = Get-Acl $privateScript
    }
}
$privateDirExisted = [IO.Directory]::Exists($privateDir)
$privateDirOriginalAcl = $null
if ($privateDirExisted -and [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $privateDirOriginalAcl = Get-Acl $privateDir
}

try {
    foreach ($plan in $plans) {
        Assert-NoReparse $plan.Path
        if ([IO.File]::Exists($plan.Path) -ne $plan.Existed -or
            ($plan.Existed -and -not (Same-Bytes ([IO.File]::ReadAllBytes($plan.Path)) $plan.Original))) {
            throw 'A configuration changed during planning. Retry with OBS closed.'
        }
    }
    # 1. Back up config files in plan
    [void][IO.Directory]::CreateDirectory($backupRoot)
    try {
        $acl = Get-Acl $backupRoot
        $acl.SetAccessRuleProtection($true, $false)
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($currentUser, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
        $acl.SetAccessRule($rule)
        Set-FileSystemDacl $backupRoot $acl
    } catch {}

    $manifestFiles = New-Object 'System.Collections.Generic.List[object]'
    foreach ($plan in $plans) {
        $existed = [IO.File]::Exists($plan.Path)
        if ($existed) {
            $backupFile = Join-Path $backupRoot $plan.Relative
            $parentDir = [IO.Path]::GetDirectoryName($backupFile)
            [void][IO.Directory]::CreateDirectory($parentDir)
            try {
                $acl = Get-Acl $parentDir
                $acl.SetAccessRuleProtection($true, $false)
                $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
                $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($currentUser, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
                $acl.SetAccessRule($rule)
                Set-FileSystemDacl $parentDir $acl
            } catch {}

            [IO.File]::Copy($plan.Path, $backupFile, $true)
            try {
                $acl = Get-Acl $backupFile
                $acl.SetAccessRuleProtection($true, $false)
                $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
                $fileRule = New-Object System.Security.AccessControl.FileSystemAccessRule($currentUser, "FullControl", "None", "None", "Allow")
                $acl.SetAccessRule($fileRule)
                Set-FileSystemDacl $backupFile $acl
            } catch {}

            if (-not (Same-Bytes ([IO.File]::ReadAllBytes($backupFile)) $plan.Original)) { throw 'Backup verification failed.' }
        }
        $manifestFiles.Add([pscustomobject]@{
            relativePath = $plan.Relative
            existed = $existed
        })
    }
    $manifestObj = [pscustomobject]@{
        configRoot = $configRoot
        files = @($manifestFiles.ToArray())
    }
    $mPath = Join-Path $backupRoot 'manifest.json'
    [IO.File]::WriteAllText($mPath, (To-Json $manifestObj), (New-Object System.Text.UTF8Encoding($false)))
    try {
        $acl = Get-Acl $mPath
        $acl.SetAccessRuleProtection($true, $false)
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $fileRule = New-Object System.Security.AccessControl.FileSystemAccessRule($currentUser, "FullControl", "None", "None", "Allow")
        $acl.SetAccessRule($fileRule)
        Set-FileSystemDacl $mPath $acl
    } catch {}

    Write-Output "Backup: $backupRoot"

    # 2. Back up owned app files
    [void][IO.Directory]::CreateDirectory($previousAppBackupDir)
    if ($Uninstall) {
        foreach ($item in $ownedPathsToRemove) {
            $backupDst = Join-Path $previousAppBackupDir $item.RelativePath
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backupDst))
            if ([IO.File]::Exists($item.Path)) {
                Assert-ObsClosed
                Assert-NoReparse $item.Path
                if ((Get-FileHashSha256 $item.Path) -ne $existingManifest[$item.RelativePath]) { throw 'An app file changed during uninstall planning.' }
                [IO.File]::Copy($item.Path, $backupDst, $false)
                if ((Get-FileHashSha256 $backupDst) -ne $existingManifest[$item.RelativePath]) { throw 'App backup verification failed.' }
                [IO.File]::Delete($item.Path)
                $appFilesReplaced.Add([pscustomobject]@{ Path = $item.Path; Backup = $backupDst })
            }
        }
        $manifestPath = Join-Path $AppInstallPath 'install-manifest.json'
        if ([IO.File]::Exists($manifestPath)) {
            $manifestBackupPath = Join-Path $previousAppBackupDir 'install-manifest.json'
            [IO.File]::Copy($manifestPath, $manifestBackupPath, $false)
            [IO.File]::Delete($manifestPath)
        }
        if ([IO.File]::Exists($privateScript)) {
            Assert-NoReparse $privateScript
            try {
                $head = [IO.File]::ReadAllText($privateScript)
                if ($head -like '*EmberstageNativeConnection*') {
                    [IO.File]::Delete($privateScript)
                    Write-Output "Removed private connection script: $privateScript"
                }
            } catch {
                Write-Output "Skipped removing private script: $_"
            }
        }
        if ([IO.Directory]::Exists($privateDir) -and [IO.Directory]::GetFileSystemEntries($privateDir).Length -eq 0) {
            Assert-NoReparse $privateDir
            [IO.Directory]::Delete($privateDir)
            Write-Output "Removed private sibling directory: $privateDir"
        }
    } else {
        if ($appChanged) {
            $appDirTmp = $AppInstallPath + '.tmp-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
            [void][IO.Directory]::CreateDirectory($appDirTmp)
            foreach ($sf in $sourceFiles) {
                $stagedDst = Join-Path $appDirTmp $sf.RelativePath
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($stagedDst))
                [IO.File]::Copy($sf.FullPath, $stagedDst, $true)
            }

            # Write generated native-install.js into staging directory
            if ($null -ne $expectedJsContent) {
                $stagedJsPath = Join-Path $appDirTmp 'assets/js/media/native-install.js'
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($stagedJsPath))
                [IO.File]::WriteAllText($stagedJsPath, $expectedJsContent, [System.Text.Encoding]::UTF8)
            }

            $stagedManifest = Get-AppManifest $appDirTmp
            foreach ($stf in $stagedManifest.files) {
                if ($stf.path -eq 'assets/js/media/native-install.js') { continue }
                $srcFile = Join-Path $repoRoot $stf.path
                $srcHash = Get-FileHashSha256 $srcFile
                if ($stf.sha256 -ne $srcHash) {
                    throw "Staged asset hash verification failed for: $($stf.path)"
                }
            }

            Assert-ObsClosed

            $manifestPath = Join-Path $AppInstallPath 'install-manifest.json'
            if ([IO.File]::Exists($manifestPath)) {
                $manifestBackupPath = Join-Path $previousAppBackupDir 'install-manifest.json'
                [IO.File]::Copy($manifestPath, $manifestBackupPath, $false)
                if (-not (Same-Bytes ([IO.File]::ReadAllBytes($manifestBackupPath)) $originalFiles[$manifestPath])) { throw 'Ownership manifest changed during planning.' }
            }

            Ensure-Directory $AppInstallPath $created
            $nextManifest = @{}
            foreach ($key in $existingManifest.Keys) { $nextManifest[$key] = $existingManifest[$key] }
            foreach ($stf in $stagedManifest.files) {
                $stagedSrc = Join-Path $appDirTmp $stf.path
                $dstFile = Get-OwnedPath $AppInstallPath $stf.path
                Assert-ObsClosed
                if ([IO.File]::Exists($dstFile)) {
                    if (-not $existingManifest.ContainsKey($stf.path) -or (Get-FileHashSha256 $dstFile) -ne $existingManifest[$stf.path]) { continue }
                    if ((Get-FileHashSha256 $dstFile) -eq $stf.sha256) { continue }
                    $backupDst = Join-Path $previousAppBackupDir $stf.path
                    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backupDst))
                    [IO.File]::Copy($dstFile, $backupDst, $false)
                    if ((Get-FileHashSha256 $backupDst) -ne $existingManifest[$stf.path]) { throw 'App backup verification failed.' }
                    [IO.File]::Replace($stagedSrc, $dstFile, [NullString]::Value)
                    $appFilesReplaced.Add([pscustomobject]@{ Path = $dstFile; Backup = $backupDst })
                } else {
                    Ensure-Directory ([IO.Path]::GetDirectoryName($dstFile)) $created
                    [IO.File]::Move($stagedSrc, $dstFile)
                    $introducedFiles.Add($dstFile)
                }
                if ((Get-FileHashSha256 $dstFile) -ne $stf.sha256) { throw 'Installed asset verification failed.' }
                $nextManifest[$stf.path] = $stf.sha256
            }

            $newManifestObj = [pscustomobject]@{ files = @($nextManifest.Keys | Sort-Object | ForEach-Object { [pscustomobject]@{ path = $_; sha256 = $nextManifest[$_] } }) }
            $manifestTemp = $manifestPath + '.tmp-' + [guid]::NewGuid().ToString('N')
            $temps.Add($manifestTemp)
            [IO.File]::WriteAllText($manifestTemp, (To-Json $newManifestObj), $utf8)
            if ([IO.File]::Exists($manifestPath)) { [IO.File]::Replace($manifestTemp, $manifestPath, [NullString]::Value) }
            else { [IO.File]::Move($manifestTemp, $manifestPath) }
            $manifestWritten = $true
        }

        # 2.5. Write private connection script
        # Check no reparse/symlinks on parent directories
        Assert-NoReparse $appParent
        if ([IO.Directory]::Exists($privateDir)) {
            Assert-NoReparse $privateDir
        } else {
            [void][IO.Directory]::CreateDirectory($privateDir)
        }
        
        # Apply user-only explicit DACL to privateDir BEFORE write
        if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
            $acl = New-Object System.Security.AccessControl.DirectorySecurity
            $acl.SetAccessRuleProtection($true, $false)
            $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($currentUser, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
            $acl.SetAccessRule($rule)
            Set-FileSystemDacl $privateDir $acl

            # Verification of directory ACL
            $dirAcl = Get-Acl $privateDir
            if ($dirAcl.AreAccessRulesProtected -ne $true) {
                throw "Verification failed: Private directory does not have inheritance disabled."
            }
            $rules = $dirAcl.GetAccessRules($true, $false, [System.Security.Principal.NTAccount])
            foreach ($r in $rules) {
                if ($r.IdentityReference.Value -ne $currentUser) {
                    throw "Verification failed: Private directory retains foreign grant for $($r.IdentityReference.Value)."
                }
            }
        }

        # Staging the write to a temporary file
        $privateTemp = $privateScript + '.tmp-' + [guid]::NewGuid().ToString('N')
        $temps.Add($privateTemp)
        [IO.File]::WriteAllText($privateTemp, $privateJsContent, [System.Text.Encoding]::UTF8)

        # Apply user-only explicit DACL to the temp file
        if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
            $fileAcl = New-Object System.Security.AccessControl.FileSecurity
            $fileAcl.SetAccessRuleProtection($true, $false)
            $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
            $fileRule = New-Object System.Security.AccessControl.FileSystemAccessRule($currentUser, "FullControl", "None", "None", "Allow")
            $fileAcl.SetAccessRule($fileRule)
            Set-FileSystemDacl $privateTemp $fileAcl
        }

        # Move staging file to final destination
        if ([IO.File]::Exists($privateScript)) {
            Assert-NoReparse $privateScript
            [IO.File]::Replace($privateTemp, $privateScript, [NullString]::Value)
        } else {
            [IO.File]::Move($privateTemp, $privateScript)
        }
        $privateScriptWritten = $true

        # Verify ACLs after final move
        if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
            $finalAcl = Get-Acl $privateScript
            if ($finalAcl.AreAccessRulesProtected -ne $true) {
                throw "Verification failed: Private script does not have inheritance disabled."
            }
            $rules = $finalAcl.GetAccessRules($true, $false, [System.Security.Principal.NTAccount])
            foreach ($r in $rules) {
                if ($r.IdentityReference.Value -ne $currentUser) {
                    throw "Verification failed: Private script retains foreign grant for $($r.IdentityReference.Value)."
                }
            }
        }
    }

    # 3. Atomically write config files
    foreach ($plan in $plans) {
        Assert-ObsClosed
        Assert-NoReparse $plan.Path
        if ([IO.File]::Exists($plan.Path) -ne $plan.Existed -or
            ($plan.Existed -and -not (Same-Bytes ([IO.File]::ReadAllBytes($plan.Path)) $plan.Original))) {
            throw 'A configuration changed before its write. Installation stopped.'
        }
        Ensure-Directory ([IO.Path]::GetDirectoryName($plan.Path)) $created
        $tempFile = $plan.Path + '.tmp-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        $temps.Add($tempFile)
        
        [IO.File]::WriteAllBytes($tempFile, $plan.Bytes)
        
        if ([IO.File]::Exists($plan.Path)) {
            $written.Add([pscustomobject]@{ Path = $plan.Path; Backup = (Join-Path $backupRoot $plan.Relative); Existed = $true })
        } else {
            $written.Add([pscustomobject]@{ Path = $plan.Path; Backup = $null; Existed = $false })
        }
        
        if ($plan.Existed) { [IO.File]::Replace($tempFile, $plan.Path, [NullString]::Value) }
        else { [IO.File]::Move($tempFile, $plan.Path) }
    }

    foreach ($tempFile in $temps) {
        if ([IO.File]::Exists($tempFile)) { [IO.File]::Delete($tempFile) }
    }

    if ($Uninstall) {
        foreach ($dir in $APP_DIRS) {
            $dirPath = Join-Path $AppInstallPath $dir
            if ([IO.Directory]::Exists($dirPath) -and [IO.Directory]::GetFileSystemEntries($dirPath).Length -eq 0) {
                [IO.Directory]::Delete($dirPath)
            }
        }
        if ([IO.Directory]::Exists($AppInstallPath) -and [IO.Directory]::GetFileSystemEntries($AppInstallPath).Length -eq 0) {
            [IO.Directory]::Delete($AppInstallPath)
            
            $parentDir = [IO.Path]::GetDirectoryName($AppInstallPath)
            if ([IO.Directory]::Exists($parentDir) -and [IO.Directory]::GetFileSystemEntries($parentDir).Length -eq 0) {
                [IO.Directory]::Delete($parentDir)
            }
        }
        Write-Output "Uninstall complete. Backup of uninstalled configuration and assets is stored under:"
        Write-Output "  $backupRoot"
    } else {
        Write-Output 'Installed Emberstage docks and output sources. New output items are hidden; existing item visibility and stream state are unchanged. Start OBS yourself.'
        Write-Output "Before enabling Emberstage Output, enable 'Shutdown source when not visible' on each legacy Text/Media/Camera output, then hide them everywhere they are used. Hiding alone may leave capture running. Keep old sources for rollback; never repoint them to the unified page."
        Write-Output 'Launch OBS normally. Add cameras as OBS Video Capture Device sources, then Em - Cameras will connect automatically. No browser camera flag is required.'
        Write-Output 'For a new Lua entry: choose Output scene manually to match the app, assign Settings > Hotkeys, then enable to arm.'
        Write-Output "Rollback: close OBS; restore the relative files listed in $backupRoot\manifest.json (remove files marked existed=false)."
    }
} catch {
    $failure = $_.Exception.Message
    $rollbackErrors = @()

    foreach ($item in $written) {
        try {
            if ($item.Existed) {
                [IO.File]::Copy($item.Backup, $item.Path, $true)
            } else {
                if ([IO.File]::Exists($item.Path)) { [IO.File]::Delete($item.Path) }
            }
        } catch {
            $rollbackErrors += "Failed to restore config $($item.Path): $($_.Exception.Message)"
        }
    }
    foreach ($item in $introducedFiles) {
        try {
            if ([IO.File]::Exists($item)) { [IO.File]::Delete($item) }
        } catch {
            $rollbackErrors += "Failed to remove introduced asset $($item): $($_.Exception.Message)"
        }
    }
    foreach ($swapped in $appFilesReplaced) {
        try {
            if ([IO.File]::Exists($swapped.Backup)) {
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($swapped.Path))
                [IO.File]::Copy($swapped.Backup, $swapped.Path, $true)
            }
        } catch {
            $rollbackErrors += "Failed to restore app file $($swapped.Path): $($_.Exception.Message)"
        }
    }
    if ($null -ne $manifestBackupPath -and [IO.File]::Exists($manifestBackupPath)) {
        try {
            $mPath = Join-Path $AppInstallPath 'install-manifest.json'
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($mPath))
            [IO.File]::Copy($manifestBackupPath, $mPath, $true)
        } catch {
            $rollbackErrors += "Failed to restore install-manifest.json: $($_.Exception.Message)"
        }
    }

    if ($manifestWritten -and $null -eq $manifestBackupPath -and [IO.File]::Exists($manifestPath)) {
        try { [IO.File]::Delete($manifestPath) } catch { $rollbackErrors += 'Failed to remove introduced ownership manifest.' }
    }

    try {
        if ($privateScriptExisted) {
            # Restore original private script
            if (-not [IO.Directory]::Exists($privateDir)) {
                [void][IO.Directory]::CreateDirectory($privateDir)
                if ($null -ne $privateDirOriginalAcl -and [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
                    Set-FileSystemDacl $privateDir $privateDirOriginalAcl
                }
            }
            [IO.File]::WriteAllBytes($privateScript, $privateScriptOriginalBytes)
            if ($null -ne $privateScriptOriginalAcl -and [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
                Set-FileSystemDacl $privateScript $privateScriptOriginalAcl
            }
        } else {
            # Clean up what we created if it was written
            if ($privateScriptWritten) {
                if ([IO.File]::Exists($privateScript)) { [IO.File]::Delete($privateScript) }
                if ([IO.Directory]::Exists($privateDir) -and [IO.Directory]::GetFileSystemEntries($privateDir).Length -eq 0) { [IO.Directory]::Delete($privateDir) }
            }
        }
        if ($privateDirExisted -and $null -ne $privateDirOriginalAcl -and [IO.Directory]::Exists($privateDir)) {
            Set-FileSystemDacl $privateDir $privateDirOriginalAcl
        }
    } catch {
        $rollbackErrors += "Failed to restore private credential state: $($_.Exception.Message)"
    }

    if ($rollbackErrors.Count -gt 0) {
        throw "Installation failed; rollback completed with errors: $($rollbackErrors -join '; '). Original failure: $failure"
    } else {
        if ($Uninstall) {
            throw "Uninstall failed; rollback completed. Cause: $failure"
        } else {
            throw "Installation failed; rollback completed. Cause: $failure"
        }
    }
} finally {
    foreach ($tempFile in $temps) {
        if ([IO.File]::Exists($tempFile)) { try { [IO.File]::Delete($tempFile) } catch {} }
    }
    if ($null -ne $appDirTmp -and [IO.Directory]::Exists($appDirTmp)) {
        try { Remove-Item -LiteralPath $appDirTmp -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }
    for ($i = $created.Count - 1; $i -ge 0; $i--) {
        if ([IO.Directory]::Exists($created[$i]) -and [IO.Directory]::GetFileSystemEntries($created[$i]).Length -eq 0) {
            [IO.Directory]::Delete($created[$i])
        }
    }
}
