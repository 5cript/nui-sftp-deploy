#!/bin/env bash

./scripts/build_flatpak.sh && flatpak install --user --reinstall build/nui-sftp.flatpak --include-sdk --include-debug

# flatpak install --user --reinstall build/nui-sftp.flatpak

# flatpak run --command=bash org.nuicpp.nui_sftp
