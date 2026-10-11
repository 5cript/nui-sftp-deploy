#!/bin/bash

# Build the nui-sftp macOS disk image locally or in CI.
#
# Assumes deploy.sh from the main nui-sftp repo has already been run on macOS, producing
# nui-sftp.app in the staged install tree (default: ../nui-sftp/build/install relative to this repo).
# The app is only ad-hoc signed, so first launches need right-click > Open.

set -e
set -u

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "${SCRIPT_DIR}/lib.sh"

REPO_DIR=$(canonicalPath "${SCRIPT_DIR}/..")

VERSION=""
SOURCE_DIR_ARG=""
OUTPUT_DIR_ARG="${REPO_DIR}/build"
ARCHITECTURE="$(uname -m)"

usage() {
    cat <<USAGE
Usage: $0 [options]

Options:
  --version <X.Y.Z>      Version string in the file name
                         (default: read from PKGBUILD via extract_version.sh)
  --source-dir <path>    Path to the staged install tree from deploy.sh
                         (default: ../nui-sftp/build/install relative to this repo)
  --output-dir <path>    Where the .dmg is written (default: ./build)
  -h | --help            Show this help
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --source-dir) SOURCE_DIR_ARG="$2"; shift 2 ;;
        --output-dir) OUTPUT_DIR_ARG="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    esac
done

[ -n "${VERSION}" ] || VERSION="$("${SCRIPT_DIR}/extract_version.sh")"
VERSION="${VERSION#v}"
SOURCE_DIR="${SOURCE_DIR_ARG:-${REPO_DIR}/../nui-sftp/build/install}"
APP="$(canonicalPath "${SOURCE_DIR}")/nui-sftp.app"
[ -d "${APP}" ] || { echo "No app bundle at ${APP}, run deploy.sh on macOS first." >&2; exit 1; }

mkdir -p "${OUTPUT_DIR_ARG}"
OUTPUT_DIR="$(canonicalPath "${OUTPUT_DIR_ARG}")"
DMG="${OUTPUT_DIR}/nui-sftp-macos-${ARCHITECTURE}_${VERSION}.dmg"

STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT
ditto "${APP}" "${STAGING}/nui-sftp.app"
ln -s /Applications "${STAGING}/Applications"

rm -f "${DMG}"
# hdiutil create is deprecated from macOS 26 on, older runners only have hdiutil.
if [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 26 ]; then
    diskutil image create from --format UDZO --volumeName "nui-sftp ${VERSION}" "${STAGING}" "${DMG}"
else
    hdiutil create -volname "nui-sftp ${VERSION}" -srcfolder "${STAGING}" -fs APFS -format UDZO -ov "${DMG}"
fi
echo "Built ${DMG}"
