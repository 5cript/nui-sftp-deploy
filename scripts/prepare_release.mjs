#!/bin/env bun

import { updatePkgBuild } from "./update_scripts/pkgbuild.mjs";
import { updateRepo } from "./update_scripts/git.mjs";
import { nuiSftpRepoDir } from "./update_scripts/files_and_dirs.mjs";
import { updateReleasesInMetainfoXml, parseMetainfoXml } from "./update_scripts/metainfo.mjs";
import { updateFlatpakYaml } from "./update_scripts/flatpak.mjs";
import { updateAppImageDockerfile } from "./update_scripts/appimage.mjs";
import { updateInnoSetup } from "./update_scripts/innosetup.mjs";
import { updateCefDistribution } from "./update_scripts/cef.mjs";
import { parsedVersion } from "./update_scripts/version.mjs";

const repoUrl = 'https://github.com/5cript/nui-sftp.git';

await updateRepo(repoUrl, nuiSftpRepoDir, parsedVersion().tag).catch((err) => {
    console.error('Error updating repository:', err);
    process.exit(1);
});

await updatePkgBuild().catch((err) => {
    console.error('Error updating PKGBUILD:', err);
    process.exit(1);
});

await updateReleasesInMetainfoXml(parseMetainfoXml()).catch((err) => {
    console.error('Error updating metainfo releases:', err);
    process.exit(1);
});

await updateFlatpakYaml().catch((err) => {
    console.error('Error updating flatpak YAML:', err);
    process.exit(1);
});

await updateCefDistribution().catch((err) => {
    console.error('Error updating the CEF distribution:', err);
    process.exit(1);
});

await updateAppImageDockerfile().catch((err) => {
    console.error('Error updating AppImage Dockerfile:', err);
    process.exit(1);
});

await updateInnoSetup().catch((err) => {
    console.error('Error updating Inno Setup script:', err);
    process.exit(1);
});
