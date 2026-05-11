#!/bin/bash

set -e
set -u

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "${SCRIPT_DIR}/lib.sh"

SOURCE_DIR="${SOURCE_DIRECTORY:-${SCRIPT_DIR}/..}"
SOURCE_DIR=$(canonicalPath "${SOURCE_DIR}")

MANIFEST="${SOURCE_DIR}/org.nuicpp.nui_sftp.yml"
REPO="${SOURCE_DIR}/build/flatpak-export"

LINT="flatpak run --command=flatpak-builder-lint org.flatpak.Builder --exceptions --exceptions-repo stable"

echo "=== manifest check ==="
${LINT} manifest "${MANIFEST}"

if [ -d "${REPO}" ]; then
    echo
    echo "=== repo check (${REPO}) ==="
    ${LINT} repo "${REPO}"
else
    echo
    echo "Skipping repo check: ${REPO} does not exist."
    echo "Run scripts/build_flatpak.sh first to produce the OSTree repo."
fi
