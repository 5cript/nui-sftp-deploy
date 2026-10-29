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
| `windows/` | Inno Setup script for the Windows installer. |
| `scripts/build_dmg.sh` | Wraps the macOS app bundle into a disk image. |
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

The app lives on Flathub in [flathub/org.nuicpp.nui_sftp](https://github.com/flathub/org.nuicpp.nui_sftp),
which is checked out here as the `flathub/` submodule. Flathub builds whatever manifest is on its
`master` branch. That manifest takes the AppStream metainfo (with the release notes) from this
repository, the `deploy-meta` source pinned to a `flatpak/<version>` tag, so every release needs
that tag too.

Releasing version 1.2.0 to Flathub, after the release branch here is merged:

1. Update `main` and tag the merge commit of the release. The tag is what the Flathub manifest
   points at, so push it before anything else:

   ```bash
   git checkout main && git pull
   git tag -a flatpak/1.2.0 -m flatpak/1.2.0
   git push origin flatpak/1.2.0
   ```

2. Start a branch in the submodule from Flathub's current `master`:

   ```bash
   git -C flathub fetch origin
   git -C flathub checkout -b release/1.2.0 origin/master
   ```

3. Copy the manifest over. The script refuses to run unless the deploy repository's `HEAD` is
   exactly at a `flatpak/*` tag; if there are commits on top already, run it from the tag with
   `git checkout flatpak/1.2.0` and go back to `main` afterwards.

   ```bash
   ./scripts/copy_manifest_to_flathub.sh
   ```

   It copies `org.nuicpp.nui_sftp.yml` into `flathub/`, pins `deploy-meta` to the tag and its
   commit and commits "Update to 1.2.0" in the submodule. Look over that commit before pushing.

4. Push the branch and open a pull request against `master` on
   [flathub/org.nuicpp.nui_sftp](https://github.com/flathub/org.nuicpp.nui_sftp/pulls):

   ```bash
   git -C flathub push -u origin release/1.2.0
   ```

   Flathub's bot builds the pull request and links a test build. Install it and check that the app
   starts before merging.

5. Merge the pull request. Flathub then builds `master` and publishes the update, which takes a
   few hours to show up for users.

6. Record the new submodule commits here, together with the AUR one (see above), and push:

   ```bash
   git add arch flathub
   git commit -m "Submodule Updates from 1.2.0"
   git push origin main
   ```

## Other targets

- **AppImage** — `appimage/Dockerfile` is updated by `prepare_release.mjs`;
  the actual build runs in CI. The AppImage embeds the update information
  `gh-releases-zsync|5cript|nui-sftp|latest|nui-sftp-appimage-x86_64_*.AppImage.zsync`
  and CI uploads its `.zsync` next to it to the release (and to S4, like every
  other release file), so AppImageUpdate can update installed copies. Publish
  the GitHub release as a pre-release (release label "Pre-release",
  `gh release create --prerelease`): AppImageUpdate asks GitHub for the latest
  release, which is never a pre-release. The release dashboard's last step
  turns it into the latest release once CI uploaded both, so AppImageUpdate
  never finds a latest release without the `.zsync`.

## Windows (Inno Setup)

`windows/nui-sftp.iss` is an Inno Setup script that wraps the portable zip's
file tree into a per-machine installer with Start Menu / optional desktop /
optional PATH integration. Upgrades are handled automatically by Inno Setup's
stable `AppId` mechanism. No special migration logic is needed across
releases.

`prepare_release.mjs` updates the `MyAppVersion` literal inside the `.iss` so
it stays in lockstep with `PKGBUILD`'s `pkgver` and the Flatpak manifest's
`FORCED_PROJECT_VERSION`. The CI workflow overrides it via ISCC's `/D` flag at
build time; the literal only matters for ad-hoc local invocations.

### Local build

The local build expects the [main scp repo](https://github.com/5cript/nui-sftp)
to be checked out as a sibling of this repo (i.e. `../nui-sftp/`). Inside the
scp checkout, run a Windows build (MSYS2 clang64, see scp's
`.github/workflows/windows.yml`) and then `bash scripts/deploy.sh` to stage
the install tree at `../nui-sftp/build/install`.

Then, from this repo:

```bash
./scripts/build_installer.sh --version 1.2.3
```

The script auto-locates ISCC.exe (Inno Setup 6) and writes the installer to
`build/nui-sftp-windows-x86_64_<version>-setup.exe`. Install Inno Setup with
`winget install JRSoftware.InnoSetup` if missing.

## macOS (disk image)

There is no per-release file to update for macOS: the workflow reads the version from
`PKGBUILD`, builds nui-sftp with `-DFORCED_PROJECT_VERSION` (which also lands in the bundle's
`Info.plist`), runs nui-sftp's `scripts/deploy.sh` to assemble the ad-hoc signed `nui-sftp.app`
and wraps it into `nui-sftp-macos-arm64_<version>.dmg`. On `main` the image is uploaded to the
GitHub release and to S4 under `macos/arm64/`.

nui-sftp is compiled with Homebrew's `llvm@23` instead of AppleClang. Its
`scripts/macos/build_dependencies.sh` builds libc++ and all libraries statically for macOS 15.2
(cached between runs), so the app links nothing but the OS and the runner's macOS version does not
matter.

### Local build

On a Mac, with nui-sftp checked out as a sibling and `bash scripts/deploy.sh` run there:

```bash
./scripts/build_dmg.sh --version 1.2.3
```

The image lands in `build/`.

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
