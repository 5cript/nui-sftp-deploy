(*
  modpath.iss - minimal PATH editor for Inno Setup.

  This file is #included from inside a [Code] section of the host .iss,
  so the file-level documentation must use Pascal-style block comments
  rather than ';' section comments.

  Host .iss must define:
    ModPathName   - the [Tasks] name guarding PATH modification (e.g. 'modifypath')
    ModPathType   - 'system' (HKLM, machine-wide) or 'user' (HKCU)
  and implement:
    function ModPathDir(): TArrayOfString;   - directories to add/remove

  On install: appends each ModPathDir() entry that isn't already on PATH.
  On uninstall: removes each ModPathDir() entry from PATH.
  Broadcasts WM_SETTINGCHANGE so new shells / Explorer pick up the change
  without requiring a reboot.
*)

#ifndef ModPathName
  #error ModPathName must be defined before including modpath.iss
#endif
#ifndef ModPathType
  #error ModPathType must be defined ('system' or 'user') before including modpath.iss
#endif

[Code]
const
  ModPath_SystemKey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment';
  ModPath_UserKey   = 'Environment';
  ModPath_WM_SETTINGCHANGE = $001A;
  ModPath_HWND_BROADCAST   = $FFFF;
  ModPath_SMTO_ABORTIFHUNG = $0002;

function ModPath_SendMessageTimeout(
  hWnd: HWND; Msg: UINT; wParam: Longint; lParam: PAnsiChar;
  fuFlags: UINT; uTimeout: UINT; var lpdwResult: Longint): Longint;
  external 'SendMessageTimeoutA@user32.dll stdcall';

function ModPath_IsSystem(): Boolean;
begin
  Result := CompareText('{#ModPathType}', 'system') = 0;
end;

function ModPath_RootKey(): Integer;
begin
  if ModPath_IsSystem() then
    Result := HKEY_LOCAL_MACHINE
  else
    Result := HKEY_CURRENT_USER;
end;

function ModPath_SubKey(): String;
begin
  if ModPath_IsSystem() then
    Result := ModPath_SystemKey
  else
    Result := ModPath_UserKey;
end;

function ModPath_ReadPath(): String;
begin
  if not RegQueryStringValue(ModPath_RootKey(), ModPath_SubKey(), 'Path', Result) then
    Result := '';
end;

procedure ModPath_WritePath(const Value: String);
var
  Dummy: Longint;
begin
  RegWriteExpandStringValue(ModPath_RootKey(), ModPath_SubKey(), 'Path', Value);
  ModPath_SendMessageTimeout(ModPath_HWND_BROADCAST, ModPath_WM_SETTINGCHANGE,
    0, 'Environment', ModPath_SMTO_ABORTIFHUNG, 5000, Dummy);
end;

function ModPath_Split(const S, Sep: String): TArrayOfString;
var
  Cursor, Found, Count: Integer;
  Rest: String;
begin
  SetArrayLength(Result, 0);
  Rest := S;
  Count := 0;
  repeat
    Found := Pos(Sep, Rest);
    SetArrayLength(Result, Count + 1);
    if Found > 0 then begin
      Result[Count] := Copy(Rest, 1, Found - 1);
      Rest := Copy(Rest, Found + Length(Sep), MaxInt);
    end else begin
      Result[Count] := Rest;
      Rest := '';
    end;
    Inc(Count);
    Cursor := Found;
  until Cursor = 0;
end;

function ModPath_Contains(const Path, Entry: String): Boolean;
var
  Parts: TArrayOfString;
  I: Integer;
begin
  Result := False;
  Parts := ModPath_Split(Path, ';');
  for I := 0 to GetArrayLength(Parts) - 1 do
    if CompareText(Trim(Parts[I]), Trim(Entry)) = 0 then begin
      Result := True;
      Exit;
    end;
end;

procedure ModPath_Add(const Entry: String);
var
  Path: String;
begin
  Path := ModPath_ReadPath();
  if ModPath_Contains(Path, Entry) then
    Exit;
  if (Path <> '') and (Copy(Path, Length(Path), 1) <> ';') then
    Path := Path + ';';
  Path := Path + Entry;
  ModPath_WritePath(Path);
end;

procedure ModPath_Remove(const Entry: String);
var
  Path, NewPath: String;
  Parts: TArrayOfString;
  I: Integer;
begin
  Path := ModPath_ReadPath();
  if Path = '' then
    Exit;
  Parts := ModPath_Split(Path, ';');
  NewPath := '';
  for I := 0 to GetArrayLength(Parts) - 1 do begin
    if CompareText(Trim(Parts[I]), Trim(Entry)) = 0 then
      Continue;
    if NewPath = '' then
      NewPath := Parts[I]
    else
      NewPath := NewPath + ';' + Parts[I];
  end;
  if NewPath <> Path then
    ModPath_WritePath(NewPath);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Dirs: TArrayOfString;
  I: Integer;
begin
  if (CurStep <> ssPostInstall) then Exit;
  if not WizardIsTaskSelected('{#ModPathName}') then Exit;
  Dirs := ModPathDir();
  for I := 0 to GetArrayLength(Dirs) - 1 do
    ModPath_Add(Dirs[I]);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Dirs: TArrayOfString;
  I: Integer;
begin
  if (CurUninstallStep <> usPostUninstall) then Exit;
  Dirs := ModPathDir();
  for I := 0 to GetArrayLength(Dirs) - 1 do
    ModPath_Remove(Dirs[I]);
end;
