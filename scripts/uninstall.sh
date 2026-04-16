#!/bin/bash

set -u

PACMAN_PKG="nui-sftp"
FLATPAK_APP="org.nuicpp.nui_sftp"

if command -v pacman >/dev/null 2>&1; then
    if pacman -Qq "${PACMAN_PKG}" >/dev/null 2>&1; then
        echo "Removing pacman package ${PACMAN_PKG}..."
        sudo pacman -Rns --noconfirm "${PACMAN_PKG}"
    else
        echo "Pacman package ${PACMAN_PKG} is not installed."
    fi
else
    echo "pacman not found, skipping."
fi

if command -v flatpak >/dev/null 2>&1; then
    if flatpak info "${FLATPAK_APP}" --user >/dev/null 2>&1; then
        echo "Removing flatpak (user) ${FLATPAK_APP}..."
        flatpak uninstall --user -y "${FLATPAK_APP}"
    elif flatpak info "${FLATPAK_APP}" >/dev/null 2>&1; then
        echo "Removing flatpak (system) ${FLATPAK_APP}..."
        sudo flatpak uninstall -y "${FLATPAK_APP}"
    else
        echo "Flatpak ${FLATPAK_APP} is not installed."
    fi
else
    echo "flatpak not found, skipping."
fi
