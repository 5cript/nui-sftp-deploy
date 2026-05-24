; -----------------------------------------------------------------------------
; nui-sftp Inno Setup installer
;
; Build locally with scripts/build_installer.sh (see README.md). CI calls the
; same script from .github/workflows/windows.yml. Do not invoke ISCC directly
; against this file unless you know what you're doing -- the script sets up
; SourceDir/IconFile/OutputDir/MyAppVersion via /D flags.
;
; AppId MUST stay stable across releases. Same GUID = Inno Setup recognises an
; existing install and does an in-place upgrade. Regenerating the GUID would
; orphan every prior install.
; -----------------------------------------------------------------------------

; MyAppVersion is rewritten by scripts/update_scripts/innosetup.mjs on every
; `prepare_release.mjs --version X.Y.Z` invocation. Do not edit by hand; bump
; via prepare_release.mjs so it stays in lockstep with PKGBUILD/flatpak/appimage.
#ifndef MyAppVersion
  #define MyAppVersion "1.1.1"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\nui-sftp\build\install"
#endif
#ifndef OutputDir
  #define OutputDir "..\build"
#endif
#ifndef IconFile
  #define IconFile SourceDir + "\assets\icons\nui-sftp.ico"
#endif

#define MyAppName       "nui-sftp"
#define MyAppPublisher  "Tim Ebbeke"
#define MyAppURL        "https://github.com/5cript/nui-sftp"
#define MyAppExeName    "nui-sftp.exe"

[Setup]
AppId={{980375E8-DDF7-443B-8557-8F649B062FE3}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}
VersionInfoCompany={#MyAppPublisher}

DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=no

PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern

SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\bin\{#MyAppExeName}
UninstallDisplayName={#MyAppName} {#MyAppVersion}

OutputDir={#OutputDir}
OutputBaseFilename=nui-sftp-windows-x86_64_{#MyAppVersion}-setup

CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked
Name: "modifypath"; Description: "Add nui-sftp to the system PATH"; GroupDescription: "System integration:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; Shortcuts intentionally omit IconFilename so Windows picks up the icon
; resource embedded in nui-sftp.exe (added by the main repo's CMake .rc step).
Name: "{group}\{#MyAppName}"; Filename: "{app}\bin\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\bin\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\bin\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

#define ModPathName 'modifypath'
#define ModPathType 'system'

[Code]
function ModPathDir(): TArrayOfString;
begin
    SetArrayLength(Result, 1);
    Result[0] := ExpandConstant('{app}\bin');
end;

#include "modpath.iss"
