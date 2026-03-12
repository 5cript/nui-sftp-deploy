#!/bin/bash

set -e
set -u

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "${SCRIPT_DIR}/lib.sh"
SOURCE_DIR="${SOURCE_DIRECTORY:-${SCRIPT_DIR}/..}"
SOURCE_DIR=$(canonicalPath "${SOURCE_DIR}")

PKGBUILD_FILE="${SOURCE_DIR}/PKGBUILD"

# Extract version from PKGBUILD
VERSION=$(sed -n 's/^pkgver=\(.*\)/\1/p' "$PKGBUILD_FILE")
VERSION=${VERSION//_/-}

echo "$VERSION"