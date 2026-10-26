#!/usr/bin/env bash
# Guest helpers for the release dashboard, on top of test-vm/windows/lib.sh (WINDOWS_SCRIPTS points there).
#
#   windows.sh ssh-options             prints the ssh options of lib.sh, one per line
#   windows.sh ip                      prints the guest IP (empty when not running)
#   windows.sh ps                      runs the PowerShell script on stdin in the guest (uploaded as a .ps1)
#   windows.sh msys [VAR=value...]     runs the bash script on stdin in the guest's MSYS2 CLANG64 login shell
#   windows.sh upload <local> <guest>  scp -r to a guest path like C:/nui-sftp-vm/release/x
#   windows.sh launch <bin dir> <port> <name>
#                                      starts nui-sftp.exe from <bin dir> on the desktop (interactive task <name>) with
#                                      WebView2's DevTools on <port>; output and "exit code N" go to <name>.log
#   windows.sh cleanup <name>          deletes the task <name>
set -euo pipefail
# shellcheck source=/dev/null
source "${WINDOWS_SCRIPTS:?}/lib.sh"
guestDirectory='C:\nui-sftp-vm\release'
guestDirectorySlash='C:/nui-sftp-vm/release'

command="${1:-}"
shift || true
case "$command" in
ssh-options)
    printf '%s\n' "${SSH_OPTS[@]}"
    exit 0
    ;;
ip)
    vm_ip
    exit 0
    ;;
esac

require_vm_ip
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
upload() { scp -q -r "${SSH_OPTS[@]}" "$1" "${VM_USER}@${VM_IP}:$2"; }
vm_ssh "if not exist $guestDirectory mkdir $guestDirectory" >/dev/null

case "$command" in
ps)
    name="command-$$.ps1"
    cat > "$work/$name"
    upload "$work/$name" "$guestDirectorySlash/$name"
    status=0
    vm_ssh "powershell -NoProfile -ExecutionPolicy Bypass -File $guestDirectory\\$name" || status=$?
    vm_ssh "del $guestDirectory\\$name" >/dev/null 2>&1 || true
    exit "$status"
    ;;
msys)
    name="command-$$.sh"
    cat > "$work/$name"
    upload "$work/$name" "$guestDirectorySlash/$name"
    status=0
    vm_msys "$guestDirectorySlash/$name" "GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.fileMode GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=safe.directory GIT_CONFIG_VALUE_1=* $*" || status=$?
    vm_ssh "del $guestDirectory\\$name" >/dev/null 2>&1 || true
    exit "$status"
    ;;
upload)
    upload "$1" "$2"
    ;;
launch)
    binDirectory="$1"
    port="$2"
    name="$3"
    printf '%s\r\n' '@echo off' \
        "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=$port" \
        "cd /d \"$binDirectory\"" \
        "nui-sftp.exe --enable-dev-tools > $guestDirectory\\$name.log 2>&1" \
        "echo nui-sftp exit code %ERRORLEVEL% >> $guestDirectory\\$name.log" > "$work/$name.cmd"
    upload "$work/$name.cmd" "$guestDirectorySlash/$name.cmd"
    cat > "$work/$name.ps1" <<SCRIPT
if (Test-Path $guestDirectory\\$name.log) { Remove-Item $guestDirectory\\$name.log }
\$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '--headless cmd.exe /c $guestDirectory\\$name.cmd'
\$principal = New-ScheduledTaskPrincipal -UserId $VM_USER -LogonType Interactive -RunLevel Limited
\$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName $name -Action \$action -Principal \$principal -Settings \$settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
'started'
SCRIPT
    upload "$work/$name.ps1" "$guestDirectorySlash/$name.ps1"
    vm_ssh "powershell -NoProfile -ExecutionPolicy Bypass -File $guestDirectory\\$name.ps1"
    ;;
cleanup)
    vm_ssh "schtasks /delete /tn $1 /f" >/dev/null 2>&1 || true
    ;;
*)
    sed -n 2,13p "$0"
    exit 1
    ;;
esac
