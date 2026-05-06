#!/bin/bash

set -e
set -u

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "${SCRIPT_DIR}/../scripts/lib.sh"

SOURCE_DIR="${SOURCE_DIRECTORY:-${SCRIPT_DIR}/..}"
SOURCE_DIR=$(canonicalPath "${SOURCE_DIR}")

VERSION=$("${SOURCE_DIR}/scripts/extract_version.sh")
IMAGE_TAG="${IMAGE_TAG:-nui-sftp-appimage-builder}"
DOCKER="${DOCKER:-docker}"

cd "${SOURCE_DIR}"

"${DOCKER}" build -t "${IMAGE_TAG}" -f appimage/Dockerfile .

mkdir -p build/appimage

"${DOCKER}" run --rm \
    -v "${SOURCE_DIR}":/workspace \
    -e VERSION="${VERSION}" \
    -e APPIMAGE_EXTRACT_AND_RUN=1 \
    "${IMAGE_TAG}" \
    bash /workspace/appimage/build_inner.sh

echo "AppImage written to: ${SOURCE_DIR}/build/nui-sftp-${VERSION}-x86_64.AppImage"
