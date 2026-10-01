#!/bin/bash

set -e
set -u

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
DOCKER="${DOCKER:-docker}"

if ! "${DOCKER}" info > /dev/null 2>&1; then
    echo "Docker daemon is not running, starting it..."
    sudo systemctl start docker

    for _ in $(seq 1 30); do
        "${DOCKER}" info > /dev/null 2>&1 && break
        sleep 1
    done

    if ! "${DOCKER}" info > /dev/null 2>&1; then
        echo "Error: docker daemon did not become ready" >&2
        exit 1
    fi
fi

exec "${SCRIPT_DIR}/../appimage/build.sh" "$@"
