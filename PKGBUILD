# Maintainer: Tim Ebbeke <tim 06 tr (at) gmail dot com>

pkgname=nui-sftp
pkgver=e72524033622eb20a815111ff4b8a022c2352b0d
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
source=(
    "$pkgname::git+$url.git#tag=${pkgver//_/-}"
    "git+https://github.com/NuiCpp/Nui.git#commit=970676604bc3bc63fa32e547c90a76dec8daf6bd"
    "git+https://github.com/5cript/roar.git#commit=a787bce9c8132f4c860bc9e55bff742fd1a3276f"
    "git+https://github.com/DNKpp/gimo.git#commit=16377a6d496b31a9272f9a079c060fba15258bcc"
    "git+https://github.com/NuiCpp/traits.git#commit=6c9caa21c48c9e1f7f039a7bdf8805a0940fce0a"
    "git+https://github.com/NuiCpp/ui5.git#commit=a514318f9110f7e77574abd283ef0c5ecf634f40"
    "git+https://github.com/5cript/5cript-nui-components.git#commit=fb33b5f751eed174b930329fbecf52138e63c0cf"
    "https://s3.g.s4.mega.io/jgemkib4a5fte35rktt5wxrwkw4ejk4ybemkf/nui-scp/images/NUI-SFTP_Logo-01.svg"
)
sha256sums=(
    'SKIP'
    'SKIP'
    '411be282af945718509ce24cc0c2ef837657398c23386a0cb7035d1ecc6367d5'
    '8d5c5f36710425e8660470db14a5d6011e20b4e9be638f3ab34ad81f9fe286b7'
    '77bed25f96135cdcf1b8274664c9564375f9823866e7d55e843f75a213af5359'
    '64e6a4c24ef2e229721482448f8b139c50c41bbdecaea4cf79ce079a8d21e4a0'
    'b48e921daff6efe9b9ce1520ae9ee431c0f8ed6428d8190cd33750df8049398a'
    '6a8217c9f00ded6893324649394a9dbc9e5004a2644735fd3f18934bb29bcae6'
)

build() {
    cd "$pkgname"

    mkdir -p $srcdir/$pkgname/dependencies

    # Make copies from sources into src/$pkgname/dependencies/*
    cp -r "$srcdir/Nui" "$srcdir/$pkgname/dependencies/Nui"
    cp -r "$srcdir/roar" "$srcdir/$pkgname/dependencies/roar"
    cp -r "$srcdir/gimo" "$srcdir/$pkgname/dependencies/gimo"
    cp -r "$srcdir/traits" "$srcdir/$pkgname/dependencies/traits"
    cp -r "$srcdir/ui5" "$srcdir/$pkgname/dependencies/ui5"
    cp -r "$srcdir/5cript-nui-components" "$srcdir/$pkgname/dependencies/5cript-nui-components"

    cmake -B "$srcdir/$pkgname/build" \
        -S "$srcdir/$pkgname" \
        -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER=clang \
        -DCMAKE_CXX_COMPILER=clang++ \
        -DCMAKE_LINKER=lld \
        -DCMAKE_CXX_STANDARD=23 \
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
    mkdir -p "$pkgdir"/opt/"$pkgname"/themes
    mkdir -p "$pkgdir"/opt/"$pkgname"/themes/dark

    # Copy files
    install -m755 "$srcdir/$pkgname/build/bin/$pkgname" "$pkgdir"/opt/"$pkgname"/bin/"$pkgname"
    cp -r "$srcdir/$pkgname/build/frontend" "$pkgdir"/opt/"$pkgname"/
    cp -r "$srcdir/$pkgname/build/assets" "$pkgdir"/opt/"$pkgname"/
    install -m644 "$srcdir/$pkgname/LICENSE" "$pkgdir"/opt/"$pkgname"/LICENSE
    install -m644 "$srcdir/$pkgname/build/themes/dark/css_variables.css" "$pkgdir"/opt/"$pkgname"/themes/dark/css_variables.css

    # Desktop
    install -Dm644 "$srcdir/$pkgname/org.nuicpp.nui_sftp.desktop" "$pkgdir"/usr/share/applications/"$pkgname".desktop
    install -Dm644 "NUI-SFTP_Logo-01.svg" "$pkgdir"/usr/share/icons/hicolor/scalable/apps/nui_sftp.svg

    ln -s "/opt/$pkgname/bin/$pkgname" "$pkgdir"/usr/bin/"$pkgname"
}