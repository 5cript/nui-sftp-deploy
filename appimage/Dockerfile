FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG LLVM_VERSION=21
ARG BOOST_VERSION=1.90.0
ARG LIBSSH_TAG=libssh-0.11.4
ARG FMT_TAG=12.1.0
ARG JSON_TAG=v3.12.0
ARG INTERVAL_TREE_TAG=v3.1.1
ARG CMAKE_VERSION=4.1.0

# Use bash so RUN steps can use bash parameter expansion (${var//./_}).
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Base toolchain + system deps that AREN'T built from source.
# Versions matching the flatpak manifest (boost/libssh/fmt/nlohmann-json/interval-tree)
# are built from source below. Other deps (webkitgtk-6.0, sdbus-c++, crypto++,
# curl, compression libs) come from Ubuntu packages.
# libstdc++-15-dev is needed because libstdc++-14's std::ranges::to has a
# malformed forward_like that clang correctly rejects (gcc accepts it). The
# toolchain PPA provides gcc-15 / libstdc++-15 on Ubuntu 24.04.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates gnupg software-properties-common \
    && add-apt-repository -y ppa:ubuntu-toolchain-r/test \
    && apt-get update && apt-get install -y --no-install-recommends \
        curl wget lsb-release \
        git ninja-build python3 nodejs npm pkg-config file xz-utils \
        dpkg-dev patchelf squashfs-tools \
        libstdc++-15-dev \
        desktop-file-utils appstream \
        libwebkitgtk-6.0-dev \
        libcurl4-openssl-dev \
        libcrypto++-dev \
        libsdbus-c++-dev \
        libopenmpi-dev \
        zlib1g-dev libbz2-dev libzstd-dev liblzma-dev \
        libgtk-4-dev \
    && rm -rf /var/lib/apt/lists/*

# Clang from apt.llvm.org (matches flatpak's llvm21 SDK extension).
RUN curl -fsSL https://apt.llvm.org/llvm.sh -o /tmp/llvm.sh \
    && chmod +x /tmp/llvm.sh \
    && /tmp/llvm.sh ${LLVM_VERSION} all \
    && rm /tmp/llvm.sh \
    && ln -sf /usr/lib/llvm-${LLVM_VERSION}/bin/clang   /usr/local/bin/clang \
    && ln -sf /usr/lib/llvm-${LLVM_VERSION}/bin/clang++ /usr/local/bin/clang++ \
    && ln -sf /usr/lib/llvm-${LLVM_VERSION}/bin/lld     /usr/local/bin/lld \
    && ln -sf /usr/lib/llvm-${LLVM_VERSION}/bin/ld.lld  /usr/local/bin/ld.lld

ENV CC=clang CXX=clang++

# CMake from Kitware (Ubuntu 24.04 ships 3.28, project requires >=4.1).
RUN wget -q -O /tmp/cmake.tar.gz \
        "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz" \
    && mkdir -p /opt/cmake \
    && tar -xzf /tmp/cmake.tar.gz -C /opt/cmake --strip-components=1 \
    && rm /tmp/cmake.tar.gz \
    && ln -sf /opt/cmake/bin/cmake  /usr/local/bin/cmake \
    && ln -sf /opt/cmake/bin/ctest  /usr/local/bin/ctest \
    && ln -sf /opt/cmake/bin/cpack  /usr/local/bin/cpack

# boost (pinned to flatpak version)
RUN cd /tmp \
    && wget -q "https://archives.boost.io/release/${BOOST_VERSION}/source/boost_${BOOST_VERSION//./_}.tar.gz" \
    && tar xf "boost_${BOOST_VERSION//./_}.tar.gz" \
    && cd "boost_${BOOST_VERSION//./_}" \
    && ./bootstrap.sh --prefix=/usr/local \
    && ./b2 -j"$(nproc)" \
        --with-program_options --with-filesystem --with-system \
        --with-serialization --with-thread --with-mpi \
        --with-iostreams --with-asio --with-process \
        install \
    && cd / && rm -rf "/tmp/boost_${BOOST_VERSION//./_}" "/tmp/boost_${BOOST_VERSION//./_}.tar.gz"

# libssh
RUN cd /tmp && git clone --depth 1 --branch "${LIBSSH_TAG}" https://git.libssh.org/projects/libssh.git \
    && cd libssh \
    && cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
    && cmake --build build --target install \
    && cd / && rm -rf /tmp/libssh

# fmt
RUN cd /tmp && git clone --depth 1 --branch "${FMT_TAG}" https://github.com/fmtlib/fmt.git \
    && cd fmt \
    && cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local -DFMT_TEST=OFF \
    && cmake --build build --target install \
    && cd / && rm -rf /tmp/fmt

# nlohmann-json
RUN cd /tmp && git clone --depth 1 --branch "${JSON_TAG}" https://github.com/nlohmann/json.git \
    && cd json \
    && cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local -DJSON_BuildTests=OFF \
    && cmake --build build --target install \
    && cd / && rm -rf /tmp/json

# interval-tree (header-only)
RUN cd /tmp && git clone --depth 1 --branch "${INTERVAL_TREE_TAG}" https://github.com/5cript/interval-tree.git \
    && cp -r interval-tree/include/interval-tree /usr/local/include/interval-tree \
    && rm -rf /tmp/interval-tree

# linuxdeploy + gtk plugin + appimagetool. Extracted at build time so we can run
# without FUSE inside docker.
RUN mkdir -p /opt/appimage-tools && cd /opt/appimage-tools \
    && wget -q https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage \
    && wget -q https://raw.githubusercontent.com/linuxdeploy/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh \
    && wget -q https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage \
    && chmod +x linuxdeploy-x86_64.AppImage linuxdeploy-plugin-gtk.sh appimagetool-x86_64.AppImage \
    && ./linuxdeploy-x86_64.AppImage --appimage-extract \
    && mv squashfs-root linuxdeploy.AppDir \
    && ./appimagetool-x86_64.AppImage --appimage-extract \
    && mv squashfs-root appimagetool.AppDir \
    && ln -sf /opt/appimage-tools/linuxdeploy.AppDir/AppRun        /usr/local/bin/linuxdeploy \
    && ln -sf /opt/appimage-tools/linuxdeploy-plugin-gtk.sh        /usr/local/bin/linuxdeploy-plugin-gtk \
    && ln -sf /opt/appimage-tools/appimagetool.AppDir/AppRun       /usr/local/bin/appimagetool \
    && rm /opt/appimage-tools/linuxdeploy-x86_64.AppImage /opt/appimage-tools/appimagetool-x86_64.AppImage \
    && wget -q -O /opt/appimage-tools/runtime-x86_64 \
        https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64

# linuxdeploy uses appstreamcli to validate; appstream package above provides it.
ENV APPIMAGE_EXTRACT_AND_RUN=1

WORKDIR /workspace
