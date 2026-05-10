# nui-sftp-deploy

Deployment / Packages repository for [nui-sftp](https://github.com/5cript/nui-sftp).

This repository holds the packaging artefacts (PKGBUILD, Flatpak manifest,
AppImage Dockerfile, AppStream metainfo, desktop file, icons reference) and
the scripts that update them in lockstep when a new upstream release is cut.

## Layout

| Path | Purpose |
|---|---|
| `PKGBUILD` | Source of truth for the Arch / AUR package. |
| `arch/` | Git submodule pointing at the AUR repository (`aur:nui-sftp`). The PKGBUILD is copied here at release time. |
| `org.nuicpp.nui_sftp.yml` | Flatpak / Flathub manifest. |
| `org.nuicpp.nui_sftp.metainfo.xml` | AppStream metainfo (descriptions, screenshots, releases). |
| `appimage/` | AppImage Dockerfile and helpers. |
| `scripts/prepare_release.mjs` | Top-level release-prep entrypoint (run with `bun`). |
| `scripts/update_scripts/*.mjs` | Per-target updaters invoked by `prepare_release.mjs`. |

## Preparing a release

`prepare_release.mjs` rewrites every per-target file to reference a single
target version. It is idempotent — re-running it for the same version
produces the same output.

```bash
bun scripts/prepare_release.mjs --version 1.2.0
```

What it does:

1. Clones / fetches the upstream `nui-sftp` checkout under `checkout/` and
   checks out the requested tag.
2. Updates `PKGBUILD` (version, sources, sha256s).
3. Pulls the GitHub release notes for every tag of `5cript/nui-sftp` and
   regenerates the `<releases>` section of `org.nuicpp.nui_sftp.metainfo.xml`.
4. Updates `org.nuicpp.nui_sftp.yml` — the upstream `nui-sftp` git source,
   the `nui-sftp-frontend` archive URL + sha256, and `-DFORCED_PROJECT_VERSION`.
5. Updates the AppImage `Dockerfile`.

Review the diff before committing — the network-dependent steps (release
notes fetch, frontend tarball sha256) can fail silently and emit warnings
without aborting.

## Arch (AUR)

The AUR package is shipped through the `arch/` submodule, which has its
remote set to `ssh://aur@aur.archlinux.org/nui-sftp.git`. The release flow is:

1. Run `prepare_release.mjs` (above) to update the top-level `PKGBUILD`.
2. Run [`scripts/copy_pkgbuild_to_arch.sh`](scripts/copy_pkgbuild_to_arch.sh).
   The script copies the top-level `PKGBUILD` into `arch/`, regenerates
   `.SRCINFO`, and creates a commit inside the submodule with the standard
   AUR commit message format (`upgpkg: <pkgname> <pkgver>-<pkgrel>`).
3. Inside `arch/`, `git push` to publish to the AUR.
4. Back in the deploy repo, commit the updated submodule pointer.

```bash
bun scripts/prepare_release.mjs --version 1.2.0
./scripts/copy_pkgbuild_to_arch.sh
git -C arch push
git add arch && git commit -m "Bump arch submodule to 1.2.0"
```

## Flatpak (Flathub)

Once the Flathub submission has been accepted, Flathub creates a per-app
repository at `https://github.com/flathub/org.nuicpp.nui_sftp`. The intended
release flow mirrors the AUR one:

1. Add the Flathub repo as a submodule (e.g. `flathub/`) once it exists.
2. Run `prepare_release.mjs` to update `org.nuicpp.nui_sftp.yml` and
   `org.nuicpp.nui_sftp.metainfo.xml` in this repo.
3. A copy script (analogous to `copy_pkgbuild_to_arch.sh`) will copy the
   manifest and metainfo into the Flathub submodule and create a release
   commit there.
4. Pushing to the Flathub submodule's `master` branch triggers the Flathub
   buildbot, which publishes the new version once the build succeeds on all
   architectures.

Submission-specific details that are still in flight (will be folded into
`prepare_release.mjs` once the workflow stabilises):

- The Flatpak manifest pulls the metainfo from a tag on this repository
  (`flatpak/<version>`) via a `type: git` source under the name `deploy-meta`.
  Each release therefore needs the manifest *and* a matching tag pushed
  here, with the tag's commit SHA written into the manifest's `commit:`
  field. Until the submission is accepted this is filled in by hand.

## Other targets

- **AppImage** — `appimage/Dockerfile` is updated by `prepare_release.mjs`;
  the actual build runs in CI.

## Local Flatpak builds

[`scripts/build_flatpak.sh`](scripts/build_flatpak.sh) invokes
`org.flatpak.Builder` (the Flathub-blessed builder, installed as a Flatpak)
against `org.nuicpp.nui_sftp.yml`. The output bundle lands at
`build/nui-sftp.flatpak`.

```bash
./scripts/build_flatpak.sh
flatpak install --user --reinstall build/nui-sftp.flatpak
flatpak run org.nuicpp.nui_sftp
```

[`scripts/debug_flatpak.sh`](scripts/debug_flatpak.sh) opens a shell inside
the installed sandbox, useful for inspecting the deployed file layout under
`/app`.
