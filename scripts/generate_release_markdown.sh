#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-5cript/nui-sftp}"
TAG="${1:-}"

if [ -z "$TAG" ]; then
    TAG=$(gh release view -R "$REPO" --json tagName --jq '.tagName')
fi

assets_json=$(gh release view "$TAG" -R "$REPO" --json assets --jq '.assets')

classify() {
    local name="$1"
    local lower
    lower=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')

    case "$lower" in
        *.pkg.tar.zst)           echo "linux|Arch package" ;;
        *.deb)                   echo "linux|Debian package" ;;
        *.rpm)                   echo "linux|RPM package" ;;
        *.appimage)              echo "linux|AppImage" ;;
        *.flatpak)               echo "linux|Flatpak bundle" ;;
        *linux-frontend*.tar.gz) echo "other|Linux frontend tarball" ;;
        *.dmg)                   echo "macos|Universal DMG" ;;
        *.pkg)                   echo "macos|macOS installer package" ;;
        *-setup.exe|*setup.exe)  echo "windows|Windows installer" ;;
        *windows*.zip)           echo "windows|Windows zip" ;;
        *.msi)                   echo "windows|Windows MSI" ;;
        *source*.tar.gz|*src*.tar.gz|*sources*.tar.gz)
                                 echo "source|Source tarball" ;;
        *source*.zip|*src*.zip)  echo "source|Source zip" ;;
        *licenses*.tar.gz)       echo "other|Third-party licenses" ;;
        *)                       echo "other|$name" ;;
    esac
}

declare -A sections
sections[linux]=""
sections[macos]=""
sections[windows]=""
sections[source]=""
sections[other]=""

while IFS=$'\t' read -r name url; do
    [ -z "$name" ] && continue
    info=$(classify "$name")
    category="${info%%|*}"
    label="${info#*|}"
    sections[$category]+="- [${label}](${url})"$'\n'
done < <(printf '%s' "$assets_json" | jq -r '.[] | [.name, .url] | @tsv')

print_section() {
    local title="$1"
    local key="$2"
    local note="${3:-}"
    local body="${sections[$key]}"
    if [ -n "$body" ]; then
        printf '### %s\n' "$title"
        if [ -n "$note" ]; then
            printf '%s\n\n' "$note"
        fi
        printf '%s\n' "$body"
    fi
}

linux_note=""
if [ -n "${sections[linux]}" ] && printf '%s' "${sections[linux]}" | grep -q '\.pkg\.tar\.zst'; then
    linux_note='> **Arch Linux users:** prefer installing the [`nui-sftp`](https://aur.archlinux.org/packages/nui-sftp) package from the AUR instead of the `.pkg.tar.zst` directly, so you get automatic updates and dependency resolution.'
fi

printf '## Download\n'
print_section "Linux"   linux   "$linux_note"
print_section "macOS"   macos
print_section "Windows" windows
print_section "Source"  source
print_section "Other"   other
