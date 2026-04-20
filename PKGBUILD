# Maintainer: Tim Ebbeke <tim 06 tr (at) gmail dot com>

pkgname=nui-sftp
pkgver=0.9.0
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
    boost-libs
    nlohmann-json
    sdbus-cpp
    zlib
    bzip2
    zstd
    xz
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
    "git+https://github.com/NuiCpp/Nui.git#tag=v3.4.2"
    "git+https://github.com/5cript/roar.git#commit=52acf8675404d6e370a4f7f6ce8e78d507b18e5d"
    "git+https://github.com/DNKpp/gimo.git#commit=16377a6d496b31a9272f9a079c060fba15258bcc"
    "git+https://github.com/NuiCpp/traits.git#commit=6c9caa21c48c9e1f7f039a7bdf8805a0940fce0a"
    "git+https://github.com/5cript/5cript-nui-components.git#commit=c8a3219b4413ce498f249bdb207588dcb433e6d4"
    "https://s3.g.s4.mega.io/jgemkib4a5fte35rktt5wxrwkw4ejk4ybemkf/nui-scp/images/NUI-SFTP_Logo-01_nopad.svg"
    "https://github.com/5cript/nui-sftp/releases/download/v${pkgver}/nui-sftp-linux-frontend_${pkgver}.tar.gz"
    "https://s3.g.s4.mega.io/jgemkib4a5fte35rktt5wxrwkw4ejk4ybemkf/nui-scp/icons.tar.gz"
)
sha256sums=(
    '27762713de942911f27b0aceb44faba44be0f4a76acea9602d7ea58f799d5b0b'
    'd9b5ce198e19fcda8c0fb4f9d0c58b0556cfd7728cc3b8b534f8d19da0d51c24'
    '444ad0bb110a2543bcf29b4ecbd4def53b937bc35e9e587a28f92bf52503c7dd'
    '8d5c5f36710425e8660470db14a5d6011e20b4e9be638f3ab34ad81f9fe286b7'
    '77bed25f96135cdcf1b8274664c9564375f9823866e7d55e843f75a213af5359'
    'd5d16912f0fa3788d073d25df5ffe4e32e7b7e1f9d38ebdc0bc2b1f8fae82335'
    'cf0fc442069dfd28bd8b7769da6dfdca92111044ea9817197716ed9bfada3869'
    '65d3abac6f052483cc4bd2b4a831236a6d375f2ca152ca8804948c7b43fc4c1f'
    '30ffa48c3a509e878db31a1e5d80376242852e34d9c2aa3b44d2e3d1da2ce32e'
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
    mkdir -p "$pkgdir"/opt/"$pkgname"/assets/icons
    mkdir -p "$pkgdir"/opt/"$pkgname"/themes

    # Unpack frontend tarball
    tar -xzf "$srcdir/nui-sftp-linux-frontend_${pkgver//_/-}.tar.gz" -C "$pkgdir"/opt/"$pkgname"/frontend --strip-components=1

    # Copy files
    install -m755 "$srcdir/$pkgname/build/bin/$pkgname" "$pkgdir"/opt/"$pkgname"/bin/"$pkgname"
    cp -r "$srcdir/$pkgname/static/assets" "$pkgdir"/opt/"$pkgname"/
    install -m644 "$srcdir/$pkgname/LICENSE" "$pkgdir"/opt/"$pkgname"/LICENSE
    cp -r "$srcdir/$pkgname/themes/." "$pkgdir"/opt/"$pkgname"/themes/
    tar -xzf "$srcdir/icons.tar.gz" -C "$pkgdir"/opt/"$pkgname"/assets/icons --strip-components=0

    # Desktop
    install -Dm644 "$srcdir/$pkgname/org.nuicpp.nui_sftp.desktop" "$pkgdir"/usr/share/applications/"$pkgname".desktop
    install -Dm644 "NUI-SFTP_Logo-01_nopad.svg" "$pkgdir"/usr/share/icons/hicolor/scalable/apps/nui_sftp.svg
    install -Dm644 "NUI-SFTP_Logo-01_nopad.svg" "$pkgdir"/opt/"$pkgname"/assets/icons/nui-sftp-logo.svg

    ln -s "/opt/$pkgname/bin/$pkgname" "$pkgdir"/usr/bin/"$pkgname"
}