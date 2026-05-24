#!/bin/bash

# Build the nui-sftp Windows installer locally or in CI.
#
# Assumes deploy.sh from the main scp repo has already been run, producing the
# staged install tree (default: ../nui-sftp/build/install relative to this repo).
# Invokes ISCC against windows/nui-sftp.iss with the staged tree as SourceDir.

set -e
set -u

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "${SCRIPT_DIR}/lib.sh"

REPO_DIR=$(canonicalPath "${SCRIPT_DIR}/..")
ISS_FILE="${REPO_DIR}/windows/nui-sftp.iss"

VERSION=""
SOURCE_DIR_ARG=""
ICON_FILE_ARG=""
OUTPUT_DIR_ARG="${REPO_DIR}/build"

usage() {
    cat <<EOF
Usage: $0 [options]

Options:
  --version <X.Y.Z>      Version string baked into the installer
                         (default: read from PKGBUILD via extract_version.sh)
  --source-dir <path>    Path to the staged install tree from deploy.sh
                         (default: ../nui-sftp/build/install relative to this repo)
  --icon <path>          Path to nui-sftp.ico for SetupIconFile
                         (default: <source-dir>/assets/icons/nui-sftp.ico)
  --output-dir <path>    Where the installer .exe is written
                         (default: ./build)
  -h | --help            Show this help

Environment overrides (lowercase wins over flag):
  ISCC                   Path to ISCC.exe (otherwise auto-located)

Example:
  $0 --version 1.2.3
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version)        VERSION="$2"; shift 2 ;;
        --source-dir)     SOURCE_DIR_ARG="$2"; shift 2 ;;
        --icon)           ICON_FILE_ARG="$2"; shift 2 ;;
        --output-dir)     OUTPUT_DIR_ARG="$2"; shift 2 ;;
        -h|--help)        usage; exit 0 ;;
        *)                echo "Unknown argument: $1" >&2; usage; exit 1 ;;
    esac
done

if [ -z "${VERSION}" ]; then
    if [ -x "${SCRIPT_DIR}/extract_version.sh" ]; then
        VERSION=$("${SCRIPT_DIR}/extract_version.sh")
    else
        echo "Error: --version not supplied and extract_version.sh not found" >&2
        exit 1
    fi
fi
VERSION="${VERSION#v}"

SOURCE_DIR="${SOURCE_DIR_ARG:-${REPO_DIR}/../nui-sftp/build/install}"
SOURCE_DIR=$(canonicalPath "${SOURCE_DIR}")

ICON_FILE="${ICON_FILE_ARG:-${SOURCE_DIR}/assets/icons/nui-sftp.ico}"

mkdir -p "${OUTPUT_DIR_ARG}"
OUTPUT_DIR=$(canonicalPath "${OUTPUT_DIR_ARG}")

if [ ! -d "${SOURCE_DIR}" ]; then
    echo "Error: source directory does not exist: ${SOURCE_DIR}" >&2
    echo "Hint: run 'bash scripts/deploy.sh' in the main scp repo first." >&2
    exit 1
fi
if [ ! -f "${SOURCE_DIR}/bin/nui-sftp.exe" ]; then
    echo "Error: ${SOURCE_DIR}/bin/nui-sftp.exe not found." >&2
    echo "Hint: the source dir must be a Windows deploy.sh output, not a Linux one." >&2
    exit 1
fi
if [ ! -f "${ICON_FILE}" ]; then
    echo "Error: icon file not found: ${ICON_FILE}" >&2
    echo "Hint: build the main scp repo with ImageMagick installed so the .ico is generated." >&2
    exit 1
fi

# Convert a Windows-style path (C:\foo\bar) to bash form (/c/foo/bar).
win_to_unix() {
    local p="$1"
    if command -v cygpath > /dev/null 2>&1; then
        cygpath -u "$p"
        return
    fi
    p="${p//\\//}"
    if [[ "$p" =~ ^([A-Za-z]):(/.*)?$ ]]; then
        local drive="${BASH_REMATCH[1]}"
        # lowercase drive letter
        drive="$(echo "$drive" | tr '[:upper:]' '[:lower:]')"
        echo "/${drive}${BASH_REMATCH[2]}"
    else
        echo "$p"
    fi
}

# Locate ISCC.exe
locate_iscc() {
    if [ -n "${ISCC:-}" ] && [ -x "${ISCC}" ]; then
        echo "${ISCC}"
        return
    fi
    local candidates=(
        "/c/Program Files (x86)/Inno Setup 6/ISCC.exe"
        "/c/Program Files/Inno Setup 6/ISCC.exe"
    )
    # winget per-user install — $HOME differs between git-bash and MSYS2,
    # so prefer the Windows env vars and convert them.
    if [ -n "${LOCALAPPDATA:-}" ]; then
        candidates+=("$(win_to_unix "${LOCALAPPDATA}")/Programs/Inno Setup 6/ISCC.exe")
    fi
    if [ -n "${USERPROFILE:-}" ]; then
        candidates+=("$(win_to_unix "${USERPROFILE}")/AppData/Local/Programs/Inno Setup 6/ISCC.exe")
    fi
    candidates+=("${HOME}/AppData/Local/Programs/Inno Setup 6/ISCC.exe")
    for c in "${candidates[@]}"; do
        if [ -x "${c}" ]; then
            echo "${c}"
            return
        fi
    done
    # Fall back to the uninstall registry — handles future version dirs
    # and non-default install locations.
    if command -v reg.exe > /dev/null 2>&1; then
        local key path_win path_unix
        for key in \
            'HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1' \
            'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1' \
            'HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1'; do
            path_win=$(reg.exe query "${key}" /v InstallLocation 2>/dev/null \
                | grep -oE '[A-Za-z]:\\.*' | head -1 | tr -d '\r')
            if [ -n "${path_win}" ]; then
                if command -v cygpath > /dev/null 2>&1; then
                    path_unix=$(cygpath -u "${path_win}")
                else
                    path_unix="${path_win//\\//}"
                fi
                path_unix="${path_unix%/}/ISCC.exe"
                if [ -x "${path_unix}" ]; then
                    echo "${path_unix}"
                    return
                fi
            fi
        done
    fi
    if command -v ISCC.exe > /dev/null 2>&1; then
        command -v ISCC.exe
        return
    fi
    if command -v iscc > /dev/null 2>&1; then
        command -v iscc
        return
    fi
    return 1
}

ISCC_PATH=$(locate_iscc || true)
if [ -z "${ISCC_PATH}" ]; then
    echo "Error: ISCC.exe not found." >&2
    echo "Install Inno Setup: winget install JRSoftware.InnoSetup" >&2
    echo "Checked: \$ISCC, \$HOME/AppData/Local/Programs/Inno Setup 6 (winget per-user)," >&2
    echo "         Program Files [(x86)], Uninstall registry, and \$PATH." >&2
    echo "Or set ISCC=/path/to/ISCC.exe and re-run." >&2
    exit 1
fi

echo "ISCC:        ${ISCC_PATH}"
echo "VERSION:     ${VERSION}"
echo "SourceDir:   ${SOURCE_DIR}"
echo "IconFile:    ${ICON_FILE}"
echo "OutputDir:   ${OUTPUT_DIR}"

# ISCC wants Windows-style paths under MSYS2; cygpath handles the conversion.
to_win() {
    if command -v cygpath > /dev/null 2>&1; then
        cygpath -w "$1"
    else
        echo "$1"
    fi
}

# MSYS2/Cygwin mangle args that start with '/' into Windows paths before
# passing them to native exes. Disable that for the ISCC call so /Qp and /D
# switches survive intact.
MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 \
"${ISCC_PATH}" \
    "/Qp" \
    "/DMyAppVersion=${VERSION}" \
    "/DSourceDir=$(to_win "${SOURCE_DIR}")" \
    "/DIconFile=$(to_win "${ICON_FILE}")" \
    "/DOutputDir=$(to_win "${OUTPUT_DIR}")" \
    "$(to_win "${ISS_FILE}")"

INSTALLER="${OUTPUT_DIR}/nui-sftp-windows-x86_64_${VERSION}-setup.exe"
if [ -f "${INSTALLER}" ]; then
    echo
    echo "Installer produced: ${INSTALLER}"
else
    echo "Error: ISCC reported success but ${INSTALLER} is missing." >&2
    exit 1
fi
