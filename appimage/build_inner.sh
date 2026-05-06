#!/bin/bash
# Runs inside the appimage/Dockerfile container. Builds nui-sftp from the
# tagged source, stages an AppDir mirroring the PKGBUILD /opt/nui-sftp layout,
# and produces a single-file AppImage in /workspace/build/.

set -e
set -u

VERSION="${VERSION:?VERSION must be provided}"
WORKSPACE=/workspace
BUILD_DIR="${WORKSPACE}/build/appimage"
SRC_DIR="${BUILD_DIR}/src"
APPDIR="${BUILD_DIR}/AppDir"
PKGNAME="nui-sftp"
APP_ID="org.nuicpp.nui_sftp"

rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}" "${APPDIR}"

# Source: same tag the PKGBUILD pulls.
git clone --depth 1 --branch "v${VERSION}" --recurse-submodules \
    https://github.com/5cript/nui-sftp "${SRC_DIR}"

# Same external inputs the PKGBUILD uses.
cd "${BUILD_DIR}"
wget -q "https://github.com/5cript/nui-sftp/releases/download/v${VERSION}/${PKGNAME}-linux-frontend_${VERSION}.tar.gz"
wget -q "https://s3.g.s4.mega.io/jgemkib4a5fte35rktt5wxrwkw4ejk4ybemkf/nui-scp/icons.tar.gz"
wget -q "https://s3.g.s4.mega.io/jgemkib4a5fte35rktt5wxrwkw4ejk4ybemkf/nui-scp/images/NUI-SFTP_Logo-01_nopad.svg"

# Build (mirrors the PKGBUILD build() flags).
cd "${SRC_DIR}"
cmake -B build -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DFORCED_PROJECT_VERSION="${VERSION}" \
    -DCMAKE_C_COMPILER=clang \
    -DCMAKE_CXX_COMPILER=clang++ \
    -DCMAKE_LINKER=lld \
    -DCMAKE_CXX_STANDARD=23 \
    -DOMIT_FRONTEND_BUILD=ON \
    -DNUI_FETCH_TRAITS=OFF
cmake --build build

# AppDir layout. Resources go under opt/nui-sftp/ to match what the PKGBUILD
# installs to /opt/nui-sftp/, so the binary's resource discovery sees the same
# relative layout it sees on a packaged Arch install.
mkdir -p "${APPDIR}/usr/bin"
mkdir -p "${APPDIR}/usr/share/applications"
mkdir -p "${APPDIR}/usr/share/metainfo"
mkdir -p "${APPDIR}/usr/share/icons/hicolor/scalable/apps"
mkdir -p "${APPDIR}/opt/${PKGNAME}/bin"
mkdir -p "${APPDIR}/opt/${PKGNAME}/frontend"
mkdir -p "${APPDIR}/opt/${PKGNAME}/assets/icons"
mkdir -p "${APPDIR}/opt/${PKGNAME}/themes"

tar -xzf "${BUILD_DIR}/${PKGNAME}-linux-frontend_${VERSION}.tar.gz" \
    -C "${APPDIR}/opt/${PKGNAME}/frontend" --strip-components=1

install -m755 "${SRC_DIR}/build/bin/${PKGNAME}" "${APPDIR}/opt/${PKGNAME}/bin/${PKGNAME}"
cp -r "${SRC_DIR}/static/assets/." "${APPDIR}/opt/${PKGNAME}/assets/"
install -m644 "${SRC_DIR}/LICENSE" "${APPDIR}/opt/${PKGNAME}/LICENSE"
cp -r "${SRC_DIR}/themes/." "${APPDIR}/opt/${PKGNAME}/themes/"
tar -xzf "${BUILD_DIR}/icons.tar.gz" -C "${APPDIR}/opt/${PKGNAME}/assets/icons"

install -Dm644 "${BUILD_DIR}/NUI-SFTP_Logo-01_nopad.svg" \
    "${APPDIR}/opt/${PKGNAME}/assets/icons/nui-sftp-logo.svg"

# Top-level + usr/share icon (AppImage spec requires top-level <id>.svg/.png).
install -Dm644 "${BUILD_DIR}/NUI-SFTP_Logo-01_nopad.svg" \
    "${APPDIR}/usr/share/icons/hicolor/scalable/apps/${APP_ID}.svg"

# Desktop file: rename Icon= to the org.* id so the icon resolves both inside
# the AppImage (top-level) and on host integration (hicolor scalable).
install -m644 "${SRC_DIR}/${APP_ID}.desktop" "${APPDIR}/usr/share/applications/${APP_ID}.desktop"
sed -i "s/Icon=${PKGNAME//-/_}/Icon=${APP_ID}/g" "${APPDIR}/usr/share/applications/${APP_ID}.desktop"

install -Dm644 "${WORKSPACE}/${APP_ID}.metainfo.xml" \
    "${APPDIR}/usr/share/metainfo/${APP_ID}.metainfo.xml"

# Bundle WebKit's helper processes + injected-bundle. On Ubuntu 24.04 these
# live under the libdir (/usr/lib/x86_64-linux-gnu/webkitgtk-6.0/) and
# linuxdeploy-plugin-gtk doesn't copy them. The host layout is mirrored so
# the LD_PRELOAD shim (compiled below) can rewrite the hardcoded path that
# libwebkitgtk-6.0 uses to spawn WebKitNetworkProcess et al.
WEBKIT_EXEC_SRC="/usr/lib/x86_64-linux-gnu/webkitgtk-6.0"
WEBKIT_EXEC_DST="${APPDIR}/usr/lib/x86_64-linux-gnu/webkitgtk-6.0"
if [ -d "${WEBKIT_EXEC_SRC}" ]; then
    mkdir -p "${WEBKIT_EXEC_DST}"
    cp -a "${WEBKIT_EXEC_SRC}/." "${WEBKIT_EXEC_DST}/"
    # Patch rpaths so the helpers find bundled libs at $ORIGIN/../.. (lib).
    for helper in "${WEBKIT_EXEC_DST}"/* "${WEBKIT_EXEC_DST}"/injected-bundle/*; do
        if [ -f "${helper}" ] && file "${helper}" | grep -q ELF; then
            patchelf --set-rpath '$ORIGIN/../..:$ORIGIN/../../..' "${helper}" || true
        fi
    done
else
    echo "ERROR: ${WEBKIT_EXEC_SRC} not found, webkit helpers can't be bundled" >&2
    exit 1
fi

# webkitgtk-6.0 hardcodes /usr/lib/x86_64-linux-gnu/webkitgtk-6.0 for helper
# spawn (the WEBKIT_EXEC_PATH env override was removed). Compile a tiny
# LD_PRELOAD shim that intercepts posix_spawn/execve and rewrites that prefix
# to $APPDIR/usr/lib/x86_64-linux-gnu/webkitgtk-6.0.
mkdir -p "${APPDIR}/usr/lib/appimage-shims"
clang -O2 -shared -fPIC -Wl,--no-as-needed \
    "${WORKSPACE}/appimage/webkit_path_shim.c" \
    -o "${APPDIR}/usr/lib/appimage-shims/webkit_path_shim.so" \
    -ldl

# linuxdeploy expects the executable under usr/bin. Symlink, not a copy, so the
# binary's $0 stays inside opt/<pkg>/bin/ and relative resource lookups work.
ln -sf "../../opt/${PKGNAME}/bin/${PKGNAME}" "${APPDIR}/usr/bin/${PKGNAME}"

# Custom AppRun lives at appimage/AppRun in the repo. linuxdeploy copies it
# into the AppDir during the appimage step.
APPRUN_SRC="${WORKSPACE}/appimage/AppRun"

# Bundle libs + GTK/webkit stack into the AppDir. linuxdeploy is NOT asked to
# produce the AppImage here; we run appimagetool ourselves below to control
# compression.
cd "${BUILD_DIR}"
DEPLOY_GTK_VERSION=4 \
linuxdeploy \
    --appdir "${APPDIR}" \
    --executable "${APPDIR}/opt/${PKGNAME}/bin/${PKGNAME}" \
    --desktop-file "${APPDIR}/usr/share/applications/${APP_ID}.desktop" \
    --icon-file "${APPDIR}/usr/share/icons/hicolor/scalable/apps/${APP_ID}.svg" \
    --custom-apprun "${APPRUN_SRC}" \
    --plugin gtk

# Strip every ELF in the AppDir before compression. linuxdeploy doesn't strip
# helper processes or webkit's massive .so set; stripping shaves ~30-40 MB
# before squashfs compression even runs.
find "${APPDIR}" -type f \( -name '*.so' -o -name '*.so.*' \) -exec strip --strip-unneeded {} + 2>/dev/null || true
find "${APPDIR}/opt/${PKGNAME}/bin" "${APPDIR}/usr/lib/x86_64-linux-gnu/webkitgtk-6.0" \
    -type f -executable -exec strip --strip-unneeded {} + 2>/dev/null || true

# Produce the AppImage manually: mksquashfs concatenated with the type-2
# AppImage runtime. We bypass appimagetool because its bundled mksquashfs is
# limited; system squashfs-tools lets us tune block size and compression
# level. zstd at -22 (max) is the tightest the upstream AppImage runtime can
# decode — it dropped xz support, so xz squashfs would build but not mount.
APPIMAGE_OUT="${WORKSPACE}/build/${PKGNAME}-${VERSION}-x86_64.AppImage"
SQUASHFS_OUT="${BUILD_DIR}/${PKGNAME}.squashfs"

# Top-level icon symlink expected by the AppImage runtime / file managers.
ln -sfn "usr/share/icons/hicolor/scalable/apps/${APP_ID}.svg" "${APPDIR}/.DirIcon"

rm -f "${SQUASHFS_OUT}"
mksquashfs "${APPDIR}" "${SQUASHFS_OUT}" \
    -comp zstd -Xcompression-level 22 \
    -b 1M \
    -no-xattrs -all-root -noappend

cat /opt/appimage-tools/runtime-x86_64 "${SQUASHFS_OUT}" > "${APPIMAGE_OUT}"
chmod +x "${APPIMAGE_OUT}"
rm -f "${SQUASHFS_OUT}"

echo "Built: build/${PKGNAME}-${VERSION}-x86_64.AppImage ($(du -h "${APPIMAGE_OUT}" | cut -f1))"
