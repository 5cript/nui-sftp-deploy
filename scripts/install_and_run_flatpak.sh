#!/bin/bash

set -e
set -u

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
SOURCE_DIR="${SOURCE_DIRECTORY:-${SCRIPT_DIR}/..}"
BUNDLE="${SOURCE_DIR}/build/nui-sftp.flatpak"

if [[ ! -f "${BUNDLE}" ]]; then
    echo "Bundle not found at ${BUNDLE}. Run scripts/build_flatpak.sh first." >&2
    exit 1
fi

flatpak install --user --reinstall -y "${BUNDLE}"
flatpak run org.nuicpp.nui_sftp "$@"
