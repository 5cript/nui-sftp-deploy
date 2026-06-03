#!/bin/bash

set -e
set -u

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "${SCRIPT_DIR}/lib.sh"

SOURCE_DIR="${SOURCE_DIRECTORY:-${SCRIPT_DIR}/..}"
SOURCE_DIR=$(canonicalPath "${SOURCE_DIR}")

MANIFEST="org.nuicpp.nui_sftp.yml"

VERSION=$("${SCRIPT_DIR}/extract_version.sh")

# The flathub manifest references this deploy repo as a git source. The tag/commit
# pair must be refreshed every release, otherwise flathub keeps building against an
# outdated deploy-meta snapshot. Require an exact `flatpak/*` tag at HEAD so we never
# pin to a commit that hasn't been tagged for flathub yet.
DEPLOY_COMMIT=$(git -C "${SOURCE_DIR}" rev-parse HEAD)
if ! DEPLOY_TAG=$(git -C "${SOURCE_DIR}" describe --tags --exact-match --match 'flatpak/*' HEAD 2>/dev/null); then
    echo "Error: HEAD of ${SOURCE_DIR} has no flatpak/* tag." >&2
    echo "       Create and push one (e.g. flatpak/${VERSION}_1) before running this script." >&2
    exit 1
fi
echo "Pinning deploy-meta to tag ${DEPLOY_TAG} (commit ${DEPLOY_COMMIT})"

cp "${SOURCE_DIR}/${MANIFEST}" "${SOURCE_DIR}/flathub/${MANIFEST}"

DEST_MANIFEST="${SOURCE_DIR}/flathub/${MANIFEST}"

# Update only the deploy-meta git source block (delimited by its url: line and the
# `dest: deploy-meta` line); other git sources in the manifest are left untouched.
sed -i -E "/^[[:space:]]*url:[[:space:]]*https:\/\/github\.com\/5cript\/nui-sftp-deploy[[:space:]]*$/,/^[[:space:]]*dest:[[:space:]]*deploy-meta[[:space:]]*$/ {
    s|^([[:space:]]*)tag:[[:space:]]*.*$|\1tag: ${DEPLOY_TAG}|
    s|^([[:space:]]*)commit:[[:space:]]*.*$|\1commit: ${DEPLOY_COMMIT}|
}" "${DEST_MANIFEST}"

if ! grep -qF "tag: ${DEPLOY_TAG}" "${DEST_MANIFEST}" \
        || ! grep -qF "commit: ${DEPLOY_COMMIT}" "${DEST_MANIFEST}"; then
    echo "Error: failed to update deploy-meta tag/commit in ${DEST_MANIFEST}" >&2
    exit 1
fi

cd "${SOURCE_DIR}/flathub"

git add "${MANIFEST}"
git commit -m "Update to ${VERSION}"
