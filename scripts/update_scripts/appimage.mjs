// The AppImage build derives the nui-sftp version from PKGBUILD's pkgver via
// extract_version.sh, so a release version bump propagates automatically.
//
// What does NOT propagate is the appimage Dockerfile's pinned dep versions
// (boost / libssh / fmt / nlohmann-json / interval-tree). Those mirror what
// the flatpak manifest builds from source — keeping them aligned avoids
// silent drift between the flatpak and AppImage builds when a dep is bumped.

import fs from 'node:fs/promises';
import { flatpakYamlPath, appimageDockerfilePath } from './files_and_dirs.mjs';
import { splitLines, findLineIndexMatching, onLineMatchingModify } from './text_editing.mjs';

function findFlatpakModuleTag(yamlLines, moduleName) {
    const moduleIdx = findLineIndexMatching(
        yamlLines, new RegExp(`^\\s*-\\s*name:\\s*${moduleName}\\s*$`)
    ).lineIndex;
    if (moduleIdx === -1) return null;

    for (let i = moduleIdx + 1; i < yamlLines.length; i++) {
        if (/^\s*-\s*name:/.test(yamlLines[i])) break; // hit the next module
        const tagMatch = yamlLines[i].match(/^\s*tag:\s*(.+?)\s*$/);
        if (tagMatch) return tagMatch[1];
    }
    return null;
}

function findFlatpakBoostVersion(yamlLines) {
    const urlIdx = findLineIndexMatching(
        yamlLines, /https:\/\/archives\.boost\.io\/release\/(\d+\.\d+\.\d+)\/source\/boost_/
    );
    return urlIdx.match ? urlIdx.match[1] : null;
}

function applyArgUpdate(dockerLines, argName, value) {
    if (!value) {
        console.warn(`Could not find ${argName} value in flatpak YAML, skipping...`);
        return dockerLines;
    }
    let updated = false;
    const next = onLineMatchingModify(
        dockerLines, new RegExp(`^ARG ${argName}=(.+)$`),
        (line, match) => {
            updated = true;
            if (match[1] === value) return line;
            console.log(`Updating AppImage Dockerfile ${argName} from ${match[1]} to ${value}...`);
            return `ARG ${argName}=${value}`;
        }
    );
    if (!updated) {
        console.warn(`Could not find ARG ${argName} in AppImage Dockerfile, skipping...`);
    }
    return next;
}

export async function updateAppImageDockerfile() {
    console.log(`Updating AppImage Dockerfile at ${appimageDockerfilePath}...`);

    const yamlLines = splitLines(await fs.readFile(flatpakYamlPath, 'utf-8'));
    const versions = {
        BOOST_VERSION: findFlatpakBoostVersion(yamlLines),
        LIBSSH_TAG: findFlatpakModuleTag(yamlLines, 'libssh'),
        FMT_TAG: findFlatpakModuleTag(yamlLines, 'fmt'),
        JSON_TAG: findFlatpakModuleTag(yamlLines, 'nlohmann-json'),
        INTERVAL_TREE_TAG: findFlatpakModuleTag(yamlLines, 'interval-tree'),
    };

    let dockerLines = splitLines(await fs.readFile(appimageDockerfilePath, 'utf-8'));
    for (const [arg, value] of Object.entries(versions)) {
        dockerLines = applyArgUpdate(dockerLines, arg, value);
    }
    await fs.writeFile(appimageDockerfilePath, dockerLines.join('\n'), 'utf-8');
    console.log('AppImage Dockerfile updated successfully.');
}
