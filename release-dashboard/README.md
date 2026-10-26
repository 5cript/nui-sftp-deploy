# Release dashboard

A local web page that runs the nui-sftp release: prepare the deploy branch, smoke test five targets, then the push, PR
and merge steps that stay with a human, and the AUR/Flathub work after the merge. Every step shows a red or green check
with its sub-checks, a live log and screenshots. Plain HTML/CSS/JS and a Node server without dependencies.

The controls (buttons, pills, badges, checkboxes, collapsible sections, message strips, spinner) are the markup of
[5cript-nui-components](https://github.com/5cript/5cript-nui-components) with its stylesheets, from the submodule
`vendor/5cript-nui-components` at the commit nui-sftp pins, themed with nui-sftp's variables; the light theme follows the
system setting. `run.sh` initialises the submodule when it is missing.

```bash
release-dashboard/run.sh --version 1.11.0
```

It opens `http://127.0.0.1:8740/`. "Run all" advances through every step whose dependencies passed and stops at the
human steps; it keeps going as soon as one of them passes (for example when "Check merge" finds the PR merged). Steps
also run one at a time with their own buttons, which are disabled while a step cannot run (dependencies not met, its
target busy, or another heavy job running). Skip marks a step as done so dependent steps can run; Reset puts it back
to pending.

The five test targets are columns. "Run all" works through them in order, one heavy build at a time. Start on a column
runs that target right away next to everything else: its steps still follow each other and advance by themselves, they
ignore the heavy lock and the ordering behind the local builds, but never their dependencies. Reset on a column puts
all of its steps back to pending to run the target again. While a step of a target is expanded, the columns turn into a
carousel (5cript-nui-components' carousel) with one target per page at full width; collapsing the last expanded step
brings the columns back.

State, logs and screenshots live in `build/release-dashboard/X.Y.Z/` (gitignored), so a restart picks up where it
stopped; a step that ran during the restart shows as failed and can be run again.

## Requirements

- The release has a GitHub release `vX.Y.Z`; the tag's Arch CI uploads the frontend tarball and the CEF distribution
  JSON, the first step waits for both.
- The app must contain `nuiAutomation.connect(name)` (nui-sftp 1.11.0 and later). Every smoke test starts the package
  with `--enable-dev-tools` and drives it over the DevTools protocol.
- `test-vm/windows` and `test-vm/macos` (machine-local, gitignored) for the Windows VM and the Mac mini.
- A saved session named `sftp-container` (`RELEASE_DASHBOARD_SESSION` overrides) in `~/.config/nui-sftp/persistence.json`;
  test runs use copies, never the real config. On the Mac the session goes through an ssh reverse tunnel on loopback,
  so a freshly signed bundle needs no Local Network permission.
- `konsole` for the play buttons (`RELEASE_DASHBOARD_TERMINAL`, e.g. `"alacritty -e"`).

## Steps

| Phase | Steps |
|---|---|
| Prepare | preflight, release assets, branch `release/X.Y.Z`, `prepare_release.mjs`, diff sanity checks, review and commit (you approve), tag checkout with submodules |
| Test | Mac (wake, local changes, build, smoke, sleep), Arch package (makepkg, smoke), Flatpak (build, lint, installed copies, smoke), AppImage (docker, build, smoke), Windows VM (start, build, smoke, installer, install/smoke/uninstall, shut down) |
| Publish | push the branch, open the PR "Release X.Y.Z", merge it (you) |
| After merge | update main, `flatpak/X.Y.Z` tag and push, AUR commit and push, Flathub branch, push and PR "Release X.Y.Z", local "Submodule Updates" commit, reinstall your Flathub copy if the test asked to remove it |

Human steps show their command with a play button: it opens a terminal running the command, and closing the window
runs the step's check (the remote branch exists, the PR exists, the AUR reports the version, ...). The dashboard never
pushes or opens PRs itself.

Heavy jobs (makepkg, flatpak build, AppImage build, Windows VM build) never overlap; the Mac build is remote and runs
next to them. The Windows VM only starts after the local builds and is shut down again if it was off; the Mac goes back
to sleep if it was asleep and nobody used it in the last two minutes.

## Sanity checks

Besides the per-target checks (About shows the version, connect, remote files listed, exit code 0, no coredumps or
crash reports, nothing written next to the installed program, no leftover mounts or processes), it checks: free memory
and disk before heavy jobs, other builds running, the Windows guest clock (set from the host when it is off by more than
30 s, the DST trap that made builds loop on "Re-running CMake"), builds that keep re-running CMake, changes on the Mac
that are not sync residue, an installed Flathub copy, release diff consistency (hashes, tag commit, metainfo date,
runtime version), and that `main` fast-forwards to the merge commit before tagging.

## Testing a branch

`--source <nui-sftp checkout>` builds the Windows VM and Mac targets from that checkout (needs a real `.git`
directory and initialised submodules) instead of the tag. `--deploy-root` points at another deploy checkout, for
example a sandbox clone whose `origin` and submodule remotes are local bare repositories.
