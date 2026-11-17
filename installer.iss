; Windows installer for Semantic Model Optimizer (Inno Setup 6).
; Built by build-installer.js; it passes the version and the folder that holds SemanticModelOptimizer.exe.
;   ISCC.exe /DAppVersion=1.2.3 /DSourceDir=dist installer.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "dist"
#endif
#define AppName "Semantic Model Optimizer"
#define AppExe "SemanticModelOptimizer.exe"

[Setup]
AppId={{8F3E6C1A-5B2D-4C7E-9A1F-2D6B8E4C0A57}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=janpaulatmatso
AppPublisherURL=https://github.com/janpaulatmatso/semantic-model-optimizer
AppSupportURL=https://github.com/janpaulatmatso/semantic-model-optimizer/issues
AppUpdatesURL=https://github.com/janpaulatmatso/semantic-model-optimizer/releases
; for this user by default (no administrator needed); the dialog lets you install for everyone instead
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
LicenseFile=LICENSE
OutputDir={#SourceDir}
OutputBaseFilename=SemanticModelOptimizer-Setup
SetupIconFile={#SourceDir}\smo.ico
UninstallDisplayIcon={app}\smo.ico
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; the tool may be running in the background: let Setup close it
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "dutch"; MessagesFile: "compiler:Languages\Dutch.isl"

[CustomMessages]
english.TaskDesktop=Create a desktop shortcut
dutch.TaskDesktop=Snelkoppeling op het bureaublad maken
english.TaskPbi=Add a button to Power BI Desktop (External Tools)
dutch.TaskPbi=Knop toevoegen aan Power BI Desktop (Externe hulpprogramma's)
english.TaskPbiNote=Only when installing for all users (needs administrator rights)
dutch.TaskPbiNote=Alleen bij installeren voor alle gebruikers (vraagt beheerdersrechten)
english.Stop=Stop {#AppName}
dutch.Stop={#AppName} stoppen
english.Launch=Start {#AppName}
dutch.Launch={#AppName} starten

[Tasks]
Name: "desktopicon"; Description: "{cm:TaskDesktop}"; Flags: unchecked
Name: "pbitool"; Description: "{cm:TaskPbi}"; GroupDescription: "{cm:TaskPbiNote}"; Check: IsAdminInstallMode

[Files]
Source: "{#SourceDir}\app\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\smo.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\smo.ico"; Comment: "Unused measures and columns, lineage and checks for Power BI models"
Name: "{group}\{cm:Stop}"; Filename: "{app}\{#AppExe}"; Parameters: "stop"; IconFilename: "{app}\smo.ico"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\smo.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Parameters: "install-tool"; Flags: runhidden waituntilterminated; Tasks: pbitool; StatusMsg: "{cm:TaskPbi}"
Filename: "{app}\{#AppExe}"; Description: "{cm:Launch}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\{#AppExe}"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopTool"
Filename: "{app}\{#AppExe}"; Parameters: "install-tool --remove"; Flags: runhidden waituntilterminated; Tasks: pbitool; RunOnceId: "RemoveButton"

[UninstallDelete]
Type: files; Name: "{app}\SemanticModelOptimizer.pbitool.json"

[Code]
// stop a running copy first, so its file is not in use during an update
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Exe: String;
begin
  Exe := ExpandConstant('{app}\{#AppExe}');
  if FileExists(Exe) then
    Exec(Exe, 'stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;
