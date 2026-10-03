; Build with Inno Setup 6.7.3+: ISCC scripts\windows\emberstage.iss
; Unsigned preview. The transactional PowerShell installer owns app assets;
; Inno owns only its separate installer directory, shortcuts and uninstall entry.
#define Repo "..\.."

[Setup]
AppId=Emberstage
AppName=Emberstage
AppVersion=0.1.0-preview
AppPublisher=Emberstage
AppPublisherURL=https://emberstage.pages.dev
DefaultDirName={localappdata}\Emberstage
DefaultGroupName=Emberstage
DisableProgramGroupPage=yes
DisableDirPage=yes
UsePreviousAppDir=no
OutputDir={#Repo}\dist
OutputBaseFilename=Emberstage-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
MinVersion=10.0
UninstallFilesDir={app}\installer
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Files]
Source: "{#Repo}\LICENSE"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "{#Repo}\THIRD_PARTY_NOTICES.md"; DestDir: "{app}\installer"; Flags: ignoreversion
; Explicit offline payload, staged in temp before any application/config change.
Source: "{#Repo}\control_panel.html"; DestDir: "{tmp}\payload"; Flags: dontcopy
Source: "{#Repo}\browser_source.html"; DestDir: "{tmp}\payload"; Flags: dontcopy
Source: "{#Repo}\media_dock.html"; DestDir: "{tmp}\payload"; Flags: dontcopy
Source: "{#Repo}\camera_dock.html"; DestDir: "{tmp}\payload"; Flags: dontcopy
Source: "{#Repo}\media_setup.html"; DestDir: "{tmp}\payload"; Flags: dontcopy
Source: "{#Repo}\picture_picker.html"; DestDir: "{tmp}\payload"; Flags: dontcopy
Source: "{#Repo}\video_mixer.html"; DestDir: "{tmp}\payload"; Flags: dontcopy
Source: "{#Repo}\media_output.html"; DestDir: "{tmp}\payload"; Flags: dontcopy
Source: "{#Repo}\camera_output.html"; DestDir: "{tmp}\payload"; Flags: dontcopy
Source: "{#Repo}\emberstage_output.html"; DestDir: "{tmp}\payload"; Flags: dontcopy
Source: "{#Repo}\streaming_dock.html"; DestDir: "{tmp}\payload"; Flags: dontcopy
Source: "{#Repo}\assets\*"; DestDir: "{tmp}\payload\assets"; Excludes: ".DS_Store,*.tmp"; Flags: dontcopy recursesubdirs
Source: "{#Repo}\scripts\install-media-deck.ps1"; DestDir: "{tmp}\payload\scripts"; Flags: dontcopy
Source: "{#Repo}\scripts\media-deck-hotkeys.lua"; DestDir: "{tmp}\payload\scripts"; Flags: dontcopy
Source: "{#Repo}\scripts\start-obs-camera-mode-windows.cmd"; DestDir: "{tmp}\payload\scripts"; Flags: dontcopy
; Keep cleanup tooling outside the app directory it may replace/uninstall.
Source: "{#Repo}\scripts\install-media-deck.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion

[Icons]
Name: "{group}\Repair Emberstage"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\app\scripts\install-media-deck.ps1"" -Apply -Repair -AppInstallPath ""{app}\app"""; Comment: "Close OBS first; repairs docks without resetting media or settings"

[Code]
function PowerShell: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function ObsIsClosed: Boolean;
var
  Code: Integer;
begin
  Result := Exec(PowerShell,
    '-NoProfile -NonInteractive -Command "if (Get-Process -Name obs64,obs32,obs -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
  if Result then Result := Code = 0;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Params: String;
begin
  Result := '';
  if not ObsIsClosed then begin
    Result := 'Close OBS Studio completely, then retry. No OBS process will be stopped automatically. PowerShell must also be available.';
    exit;
  end;
  ExtractTemporaryFiles('{tmp}\payload\*');
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\payload\scripts\install-media-deck.ps1') +
    '" -Apply -AppInstallPath "' + ExpandConstant('{app}\app') + '"';
  WizardForm.StatusLabel.Caption := 'Backing up and installing Emberstage docks...';
  if not Exec(PowerShell, Params, '', SW_SHOW, ewWaitUntilTerminated, Code) then
    Result := 'Could not start PowerShell. Installation has not completed.'
  else if Code <> 0 then
    Result := 'Emberstage integration failed. Close OBS and ensure it has been opened once to create its configuration. No successful installation is being reported. See the PowerShell message and installer backup for details.';
end;

function InitializeUninstall: Boolean;
var
  Code: Integer;
  Params: String;
begin
  Result := False;
  if not ObsIsClosed then begin
    SuppressibleMsgBox('Close OBS Studio completely before uninstalling Emberstage. Nothing has been removed.', mbError, MB_OK, IDOK);
    exit;
  end;
  if SuppressibleMsgBox('Remove Emberstage docks and unchanged installed program files? Your media, browser data, settings, scenes, and backups will be kept.', mbConfirmation, MB_YESNO, IDYES) <> IDYES then exit;
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\installer\install-media-deck.ps1') +
    '" -Uninstall -Apply -AppInstallPath "' + ExpandConstant('{app}\app') + '"';
  if Exec(PowerShell, Params, '', SW_SHOW, ewWaitUntilTerminated, Code) then Result := Code = 0;
  if not Result then
    SuppressibleMsgBox('Emberstage cleanup failed. The uninstaller has stopped without removing its files. Inspect the PowerShell error and backup before retrying.', mbError, MB_OK, IDOK);
end;
