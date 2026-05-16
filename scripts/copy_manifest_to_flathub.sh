#!/bin/bash

set -e
set -u

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "${SCRIPT_DIR}/lib.sh"

SOURCE_DIR="${SOURCE_DIRECTORY:-${SCRIPT_DIR}/..}"
SOURCE_DIR=$(canonicalPath "${SOURCE_DIR}")

MANIFEST="org.nuicpp.nui_sftp.yml"

cp "${SOURCE_DIR}/${MANIFEST}" "${SOURCE_DIR}/flathub/${MANIFEST}"

cd "${SOURCE_DIR}/flathub"

VERSION=$("${SCRIPT_DIR}/extract_version.sh")

git add "${MANIFEST}"
git commit -m "Update to ${VERSION}"
