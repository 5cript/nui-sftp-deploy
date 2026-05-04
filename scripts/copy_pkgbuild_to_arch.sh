#!/bin/bash

set -e
set -u

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "${SCRIPT_DIR}/lib.sh"

SOURCE_DIR="${SOURCE_DIRECTORY:-${SCRIPT_DIR}/..}"
SOURCE_DIR=$(canonicalPath "${SOURCE_DIR}")

cp "${SOURCE_DIR}/PKGBUILD" "${SOURCE_DIR}/arch/PKGBUILD"

cd "${SOURCE_DIR}/arch"
makepkg --printsrcinfo > .SRCINFO

pkgname=$(. ./PKGBUILD; echo "${pkgname}")
pkgver=$(. ./PKGBUILD; echo "${pkgver}")
pkgrel=$(. ./PKGBUILD; echo "${pkgrel}")

git add PKGBUILD .SRCINFO
git commit -m "upgpkg: ${pkgname} ${pkgver}-${pkgrel}"
