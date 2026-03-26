# Maintainer: Tim Ebbeke <tim 06 tr (at) gmail dot com>

pkgname=nui-sftp
pkgver=0.3.0
pkgrel=1
pkgdesc="NUI-based SFTP application"
arch=('x86_64')
url="https://github.com/5cript/nui-sftp"
license=('MIT')
depends=(
    webkitgtk-6.0
    curl
    crypto++
    libssh
    fmt
    boost
    nlohmann-json
)
makedepends=(
    cmake
    ninja
    clang
    lld
    git
    python
    nodejs
)
options=('!debug')
source=(
    "$pkgname::git+$url.git#tag=v${pkgver//_/-}"
    "git+https://github.com/NuiCpp/Nui.git#tag=v3.1.1"
    "git+https://github.com/5cript/roar.git#commit=52acf8675404d6e370a4f7f6ce8e78d507b18e5d"
    "git+https://github.com/DNKpp/gimo.git#commit=16377a6d496b31a9272f9a079c060fba15258bcc"
    "git+https://github.com/NuiCpp/traits.git#commit=6c9caa21c48c9e1f7f039a7bdf8805a0940fce0a"
    "git+https://github.com/5cript/5cript-nui-components.git#commit=755a0246a961619e4372caf24e0b499b4856d4dd"
    "https://s3.g.s4.mega.io/jgemkib4a5fte35rktt5wxrwkw4ejk4ybemkf/nui-scp/images/NUI-SFTP_Logo-01.svg"
    "https://github.com/5cript/nui-sftp/releases/download/v${pkgver}/nui-sftp-linux-frontend_${pkgver}.tar.gz"
)
sha256sums=(
    'd6adaeb7e9f9279083b2cb8d5607c985b57627f05e36dc2d82d5aacfe46305a0'
    'f3d10eb187828de1290914768a263639db0531dd8b0d3eae48a3865a4cd04a17'
    '444ad0bb110a2543bcf29b4ecbd4def53b937bc35e9e587a28f92bf52503c7dd'
    '8d5c5f36710425e8660470db14a5d6011e20b4e9be638f3ab34ad81f9fe286b7'
    '77bed25f96135cdcf1b8274664c9564375f9823866e7d55e843f75a213af5359'
    'b2c3cf89924b49a3d4106c49fe8123cef784acfec9189102c0a26cd5b2585559'
    '6a8217c9f00ded6893324649394a9dbc9e5004a2644735fd3f18934bb29bcae6'
    '35983aac5871c50f52fbdc81d0d32e1c3c2fd6b8bbdbe4cabded7c9d7d4bcf2b'
)

build() {
    cd "$pkgname"

    mkdir -p $srcdir/$pkgname/dependencies

    # Make copies from sources into src/$pkgname/dependencies/*
    cp -r "$srcdir/Nui" "$srcdir/$pkgname/dependencies/Nui"
    cp -r "$srcdir/roar" "$srcdir/$pkgname/dependencies/roar"
    cp -r "$srcdir/gimo" "$srcdir/$pkgname/dependencies/gimo"
    cp -r "$srcdir/traits" "$srcdir/$pkgname/dependencies/traits"
    cp -r "$srcdir/5cript-nui-components" "$srcdir/$pkgname/dependencies/5cript-nui-components"

    cmake -B "$srcdir/$pkgname/build" \
        -S "$srcdir/$pkgname" \
        -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DFORCED_PROJECT_VERSION="$pkgver" \
        -DCMAKE_C_COMPILER=clang \
        -DCMAKE_CXX_COMPILER=clang++ \
        -DCMAKE_LINKER=lld \
        -DCMAKE_CXX_STANDARD=23 \
        -DOMIT_FRONTEND_BUILD=ON \
        -DNUI_FETCH_TRAITS=OFF

    cmake --build "$srcdir/$pkgname/build"
}

package() {
    # Create directories
    mkdir -p "$pkgdir"/usr/bin
    mkdir -p "$pkgdir"/opt/"$pkgname"
    mkdir -p "$pkgdir"/opt/"$pkgname"/bin
    mkdir -p "$pkgdir"/opt/"$pkgname"/frontend
    mkdir -p "$pkgdir"/opt/"$pkgname"/assets

    # Unpack frontend tarball
    tar -xzf "$srcdir/nui-sftp-linux-frontend_${pkgver//_/-}.tar.gz" -C "$pkgdir"/opt/"$pkgname"/frontend --strip-components=1

    # Copy files
    install -m755 "$srcdir/$pkgname/build/bin/$pkgname" "$pkgdir"/opt/"$pkgname"/bin/"$pkgname"
    cp -r "$srcdir/$pkgname/build/assets" "$pkgdir"/opt/"$pkgname"/
    install -m644 "$srcdir/$pkgname/LICENSE" "$pkgdir"/opt/"$pkgname"/LICENSE

    # Desktop
    install -Dm644 "$srcdir/$pkgname/org.nuicpp.nui_sftp.desktop" "$pkgdir"/usr/share/applications/"$pkgname".desktop
    install -Dm644 "NUI-SFTP_Logo-01.svg" "$pkgdir"/usr/share/icons/hicolor/scalable/apps/nui_sftp.svg

    ln -s "/opt/$pkgname/bin/$pkgname" "$pkgdir"/usr/bin/"$pkgname"
}